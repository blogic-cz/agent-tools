import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { promisify } from "node:util";
import { execFile, spawnSync } from "node:child_process";
import { createProxy, capabilityDigest } from "#api/proxy";
import { validateOperator, relativePath, MAX_RESULT_ENVELOPE_BYTES } from "#api/types";
import { createApiClient } from "#api/client";
import { allowedAddress, makePinnedTransport, MAX_PENDING_DNS_LOOKUPS } from "#api/transport";
import { startProxy } from "#api/server";
import { claimGrants, readSecretStore } from "#api/store";
import { createCredentialGuard } from "#guard";
import type { Transport, TransportRequest } from "#api/transport";
import type { OperatorConfig } from "#api/types";

const execFileAsync = promisify(execFile);
const capability = "synthetic-caller-capability-00000001";
const credential = "synthetic-upstream-secret";
const request = { profile: "sample", method: "GET", path: "/v1/items" } as const;
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
function config(): Mutable<OperatorConfig> {
  return {
    listen: { kind: "developmentLoopback", host: "127.0.0.1", port: 32123 },
    secretsFile: "/operator/private/store.json",
    grantUseDirectory: "/operator/private/used",
    profiles: {
      sample: {
        origin: "https://service.example.invalid",
        auth: { kind: "bearer", secretRef: "token" },
        pathPrefixes: ["/v1"],
        deniedPathPrefixes: ["/v1/auth"],
        allowedPrivateAddresses: [],
        disclosure: { kind: "raw" },
        maxRequestBytes: 1000,
        maxResponseBytes: 2000,
        timeoutMs: 1000,
      },
    },
    grants: [
      {
        digest: capabilityDigest(capability),
        expiresAt: Date.now() + 60000,
        revoked: false,
        profiles: ["sample"],
        maxRequests: 4,
        maxBytes: 30000,
        maxConcurrent: 2,
        lifetimeMs: 60000,
      },
    ],
    maxConcurrent: 4,
  };
}
const success: Transport = async () => ({ status: 200, body: '{"items":[1,2]}' });
const proxyFor = (transport: Transport = success, value = config()) =>
  createProxy({ config: value, secrets: { token: credential }, transport });

describe("REST credential proxy boundaries", () => {
  it("sends approved JSON REST request with server-owned auth and no credentials in result", async () => {
    let captured: TransportRequest | undefined;
    const proxy = proxyFor(async (input) => {
      captured = input;
      return success(input);
    });
    expect(await proxy.request(capability, { ...request, query: { q: "a b" } })).toEqual({
      status: 200,
      data: { items: [1, 2] },
    });
    expect(captured?.url.href).toBe("https://service.example.invalid/v1/items?q=a+b");
    expect(captured?.headers.authorization).toBe(`Bearer ${credential}`);
  });
  it.each([
    "https://evil.example.invalid/x",
    "//evil/x",
    "/v1/../x",
    "/v1/%2e%2e/x",
    "/v1/%252e/x",
    "/v1/a\\b",
    "/v1//x",
    "/v1/x?y=1",
    "/v1/x#x",
    "/v1/./x",
  ])("refuses ambiguous path %s", (path) => {
    expect(() => relativePath(path)).toThrow();
  });
  it.each([
    { ...request, profile: "absent" },
    { ...request, method: "POST" },
    { ...request, path: "/v1/auth/token" },
    { ...request, path: "/v10/items" },
    { ...request, body: {} },
    { ...request, origin: "https://evil.example.invalid" },
    { ...request, headers: { authorization: "agent-token" } },
  ])("refuses unauthorized request shape %#", async (value) => {
    let calls = 0;
    const proxy = proxyFor(async (input) => {
      calls++;
      return success(input);
    });
    await expect(proxy.request(capability, value)).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
  it("fails closed for missing credentials and bad operator config", () => {
    expect(() => createProxy({ config: config(), secrets: {}, transport: success })).toThrow(
      "CREDENTIAL_UNAVAILABLE",
    );
    expect(() => validateOperator({ ...config(), unexpected: true })).toThrow("CONFIG_INVALID");
    const value = config();
    value.profiles.sample.origin = "http://service.example.invalid";
    expect(() => validateOperator(value)).toThrow("CONFIG_INVALID");
  });
  it.each([
    credential,
    'quoted"\\password',
    Buffer.from(credential).toString("base64"),
    encodeURIComponent(credential),
  ])("blocks exact and encoded secret echoes %#", async (echo) => {
    const secret = echo.startsWith("quoted") ? echo : credential;
    const proxy = createProxy({
      config: config(),
      secrets: { token: secret },
      transport: async () => ({ status: 200, body: JSON.stringify({ echo }) }),
    });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "DISCLOSURE_DENIED",
    });
  });
  it("projects only approved JSON fields", async () => {
    const value = config();
    value.profiles.sample.disclosure = { kind: "fields", fields: ["safe"] };
    const proxy = proxyFor(
      async () => ({
        status: 200,
        body: JSON.stringify({ safe: 1, token: credential, personal: "private" }),
      }),
      value,
    );
    expect(await proxy.request(capability, request)).toEqual({ status: 200, data: { safe: 1 } });
  });
  it("never exposes upstream errors or credential-bearing exceptions", async () => {
    const proxy = proxyFor(async () => {
      throw new Error(credential);
    });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "UPSTREAM_FAILED",
      message: "UPSTREAM_FAILED",
    });
  });
  it("admits configured JSON writes and API-key/basic headers", async () => {
    for (const auth of [
      { kind: "apiKey", header: "x-api-key", secretRef: "token" },
      { kind: "basic", usernameRef: "token", passwordRef: "token" },
    ] as const) {
      const value = config();
      value.profiles.sample.auth = auth;
      value.profiles.sample.methods = ["POST"];
      let captured: TransportRequest | undefined;
      const proxy = proxyFor(async (input) => {
        captured = input;
        return success(input);
      }, value);
      await proxy.request(capability, { ...request, method: "POST", body: { limit: 2 } });
      expect(captured?.body).toBe('{"limit":2}');
      expect(captured?.headers[auth.kind === "apiKey" ? "x-api-key" : "authorization"]).toBe(
        auth.kind === "apiKey"
          ? credential
          : `Basic ${Buffer.from(`${credential}:${credential}`).toString("base64")}`,
      );
    }
  });
  it("keeps configured login output internal, denies its path and blocks minted token echoes", async () => {
    const value = config();
    value.profiles.sample.auth = {
      kind: "login",
      path: "/auth/login",
      fields: { password: "token" },
      tokenField: "access_token",
    };
    const calls: TransportRequest[] = [];
    const proxy = proxyFor(async (input) => {
      calls.push(input);
      return input.url.pathname === "/auth/login"
        ? { status: 200, body: '{"access_token":"minted-synthetic-token","extra":"internal"}' }
        : { status: 200, body: '{"echo":"minted-synthetic-token"}' };
    }, value);
    await expect(
      proxy.request(capability, { ...request, path: "/auth/login" }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "DISCLOSURE_DENIED",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toBe(JSON.stringify({ password: credential }));
    expect(calls[1]?.headers.authorization).toBe("Bearer minted-synthetic-token");
  });
  it("checks revocation before dispatching after login", async () => {
    const value = config();
    value.profiles.sample.auth = {
      kind: "login",
      path: "/auth/login",
      fields: { password: "token" },
      tokenField: "token",
    };
    let calls = 0;
    const proxy = proxyFor(async () => {
      calls++;
      proxy.revoke(capabilityDigest(capability));
      return { status: 200, body: '{"token":"minted-token"}' };
    }, value);
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(calls).toBe(1);
  });
  it("bounds cumulative requests and byte reservations even when requests fail", async () => {
    const value = config();
    value.grants[0]!.maxRequests = 1;
    const proxy = proxyFor(async () => ({ status: 500, body: credential }), value);
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "UPSTREAM_FAILED",
    });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
    });
    const bytes = config();
    bytes.grants[0]!.maxBytes = 2999;
    await expect(proxyFor(success, bytes).request(capability, request)).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
    });
  });
  it("atomically refuses excess concurrent admission", async () => {
    const value = config();
    value.grants[0]!.maxConcurrent = 1;
    let finish: ((value: { status: number; body: string }) => void) | undefined;
    const proxy = proxyFor(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      value,
    );
    const pending = proxy.request(capability, request);
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
    });
    finish?.({ status: 200, body: "{}" });
    await pending;
  });
  it("refuses expiry, lifetime and revocation at admission and completion", async () => {
    let time = 100;
    const value = config();
    value.grants[0]!.expiresAt = 200;
    value.grants[0]!.lifetimeMs = 50;
    const proxy = createProxy({
      config: value,
      secrets: { token: credential },
      now: () => time,
      transport: async () => {
        time = 151;
        return { status: 200, body: "{}" };
      },
    });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
    });
    time = 200;
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const revoked = config();
    revoked.grants[0]!.revoked = true;
    await expect(proxyFor(success, revoked).request(capability, request)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("bounds request and response body sizes", async () => {
    const proxy = proxyFor(async () => ({ status: 200, body: '"' + "x".repeat(2001) + '"' }));
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    await expect(
      proxy.request(capability, { ...request, query: { q: "x".repeat(1001) } }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  it("bounds a never-resolving transport using the abort deadline", async () => {
    const value = config();
    value.profiles.sample.timeoutMs = 10;
    await expect(
      proxyFor(() => new Promise(() => {}), value).request(capability, request),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
  });
});

describe("pinned transport", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "168.63.129.16",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
  ])("refuses nonpublic destination %s", (address) =>
    expect(allowedAddress(address, [])).toBe(false),
  );
  it("permits an exact private allowance and cannot permit metadata", () => {
    expect(allowedAddress("10.0.0.1", ["10.0.0.1"])).toBe(true);
    expect(allowedAddress("10.0.0.2", ["10.0.0.1"])).toBe(false);
    expect(allowedAddress("169.254.169.254", ["169.254.169.254"])).toBe(false);
    expect(allowedAddress("8.8.8.8", [])).toBe(true);
  });
  it("fails closed for mixed DNS answers, empty answers and DNS failure without HTTP", async () => {
    for (const resolve of [
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      async () => [],
      async () => {
        throw new Error("private diagnostics");
      },
    ]) {
      await expect(
        makePinnedTransport(resolve)({
          url: new URL("https://service.example.invalid/x"),
          method: "GET",
          headers: {},
          body: "",
          maxBytes: 100,
          signal: new AbortController().signal,
          allowedPrivateAddresses: [],
        }),
      ).rejects.toMatchObject({ code: "DESTINATION_DENIED" });
    }
  });
  it("bounds never-resolving DNS", async () => {
    const controller = new AbortController();
    const pending = makePinnedTransport(() => new Promise(() => {}))({
      url: new URL("https://service.example.invalid/x"),
      method: "GET",
      headers: {},
      body: "",
      maxBytes: 100,
      signal: controller.signal,
      allowedPrivateAddresses: [],
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
  });
});

describe("operator store, actual client and CLI", () => {
  it("requires private files and durable fresh grants on restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-proxy-store-"));
    try {
      const file = join(dir, "store.json");
      await writeFile(file, JSON.stringify({ token: credential }), { mode: 0o600 });
      expect(await readSecretStore(file)).toEqual({ token: credential });
      await chmod(file, 0o644);
      await expect(readSecretStore(file)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
      await chmod(file, 0o600);
      await symlink(file, join(dir, "link.json"));
      await expect(readSecretStore(join(dir, "link.json"))).rejects.toBeDefined();
      const value = config();
      value.grantUseDirectory = join(dir, "used");
      await mkdir(value.grantUseDirectory, { mode: 0o700 });
      await claimGrants(value);
      await expect(claimGrants(value)).rejects.toMatchObject({ code: "GRANT_ALREADY_USED" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("runs a real local synthetic proxy/client round trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-proxy-roundtrip-"));
    let server: Awaited<ReturnType<typeof startProxy>> | undefined;
    try {
      const value = config();
      value.secretsFile = join(dir, "store.json");
      value.grantUseDirectory = join(dir, "used");
      await writeFile(value.secretsFile, JSON.stringify({ token: credential }), { mode: 0o600 });
      await mkdir(value.grantUseDirectory, { mode: 0o700 });
      value.listen.port = 0;
      server = await startProxy(value, success);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Synthetic server did not bind");
      const proxyOrigin = `http://127.0.0.1:${address.port}`;
      const client = createApiClient({ proxyOrigin, capability, developmentLoopback: true });
      expect(await client.request(request)).toEqual({ status: 200, data: { items: [1, 2] } });
      await expect(
        createApiClient({
          proxyOrigin,
          capability: "synthetic-invalid-capability-00000001",
          developmentLoopback: true,
        }).request(request),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(client.request({ ...request, method: "POST" })).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server?.close((error) => (error ? reject(error) : resolve())),
        );
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects insecure client origins, operator fields and invalid result shapes", async () => {
    expect(() =>
      createApiClient({ proxyOrigin: "http://service.example.invalid", capability }),
    ).toThrow("CONFIG_INVALID");
    const client = createApiClient(
      { proxyOrigin: "https://proxy.example.invalid", capability },
      async () => ({ status: 200, body: '{"token":"unexpected"}' }),
    );
    await expect(client.request(request)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
  it("drives actual CLI help and rejects unknown CLI flags", () => {
    const help = spawnSync("bun", ["src/api-tool/index.ts", "request", "--help"], {
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--profile");
    expect(help.stdout).toContain("--config");
    const invalid = spawnSync(
      "bun",
      ["src/api-tool/index.ts", "request", "--upstream-token", credential],
      { encoding: "utf8" },
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout + invalid.stderr).not.toContain(credential);
  });
  it.each([
    "api-tool request --config /tmp/client.json --profile sample --path /v1/items",
    "bun run api-tool request --config /tmp/client.json --profile sample --path /v1/items",
    "api-tool request --help",
    `bun run api-tool request --config /tmp/client.json --profile sample --path /v1/items --query '{"limit":"2"}'`,
    `api-tool request --config /tmp/client.json --profile sample --path /v1/items --method POST --body '{"limit":2}'`,
  ])("admits inert public client command %s", (command) => {
    expect(createCredentialGuard().isDangerousBashCommand(command)).toBe(false);
  });
});

function loginConfig() {
  const value = config();
  value.profiles.sample.auth = {
    kind: "login",
    path: "/auth/login",
    fields: { password: "token" },
    tokenField: "token",
  };
  value.profiles.echo = { ...value.profiles.sample, auth: { kind: "bearer", secretRef: "token" } };
  value.grants[0]!.profiles.push("echo");
  return value;
}
function storedSecrets(count: number) {
  return {
    token: credential,
    ...Object.fromEntries(
      Array.from({ length: count - 1 }, (_, index) => [
        `unused-${index}`,
        `synthetic-unused-secret-${index}`,
      ]),
    ),
  };
}

describe("REST proxy review regressions", () => {
  it("rejects long malicious paths in Node and Bun with external kill timeouts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-path-validator-"));
    try {
      const script = `for (const n of [100,1000000]) { try { relativePath("/"+"a".repeat(n)+"%"); process.exit(1); } catch {} }`;
      const bun = spawnSync(
        "bun",
        ["-e", `import { relativePath } from "./src/api-tool/types.ts"; ${script}`],
        { encoding: "utf8", timeout: 2000 },
      );
      expect(bun.error).toBeUndefined();
      expect(bun.status).toBe(0);
      const validator = join(dir, "validator.mjs");
      const build = spawnSync(
        "bun",
        ["build", "src/api-tool/types.ts", "--target=node", "--outfile", validator],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(build.status).toBe(0);
      const runner = join(dir, "runner.mjs");
      await writeFile(runner, `import { relativePath } from "./validator.mjs"; ${script}`);
      const node = spawnSync(process.execPath, [runner], { encoding: "utf8", timeout: 2000 });
      expect(node.error).toBeUndefined();
      expect(node.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("refuses login before I/O when stored secrets fill retention", async () => {
    let calls = 0;
    const proxy = createProxy({
      config: loginConfig(),
      secrets: storedSecrets(128),
      transport: async () => {
        calls++;
        return { status: 200, body: '{"token":"new-token"}' };
      },
    });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
    });
    expect(calls).toBe(0);
  });
  it("accounts deterministic Basic credentials at startup", () => {
    const value = config();
    value.profiles.sample.auth = { kind: "basic", usernameRef: "token", passwordRef: "token" };
    expect(() =>
      createProxy({ config: value, secrets: storedSecrets(128), transport: success }),
    ).toThrow("CONFIG_INVALID");
  });
  it("reserves the last token slot synchronously across competing logins", async () => {
    let calls = 0;
    let complete: ((result: { status: number; body: string }) => void) | undefined;
    const proxy = createProxy({
      config: loginConfig(),
      secrets: storedSecrets(127),
      transport: (input) => {
        if (input.url.pathname !== "/auth/login") return success(input);
        calls++;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const first = proxy.request(capability, request);
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
    });
    expect(calls).toBe(1);
    complete?.({ status: 200, body: '{"token":"minted-last-token"}' });
    await first;
  });
  it("retains tokens even when the following operation refuses", async () => {
    const proxy = createProxy({
      config: loginConfig(),
      secrets: storedSecrets(127),
      transport: async (input) => {
        if (input.url.pathname === "/auth/login")
          return { status: 200, body: '{"token":"minted-refused-token"}' };
        return input.headers.authorization === `Bearer ${credential}`
          ? { status: 200, body: '{"echo":"minted-refused-token"}' }
          : { status: 500, body: "{}" };
      },
    });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "UPSTREAM_FAILED",
    });
    await expect(proxy.request(capability, { ...request, profile: "echo" })).rejects.toMatchObject({
      code: "DISCLOSURE_DENIED",
    });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
    });
  });
  it("releases slots after a failed exchange or duplicate known token", async () => {
    let logins = 0;
    const proxy = createProxy({
      config: loginConfig(),
      secrets: storedSecrets(127),
      transport: async (input) => {
        if (input.url.pathname !== "/auth/login") return success(input);
        logins++;
        if (logins === 1) return { status: 500, body: "{}" };
        return {
          status: 200,
          body: JSON.stringify({ token: logins === 2 ? credential : "minted-new-token" }),
        };
      },
    });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "UPSTREAM_FAILED",
    });
    await expect(proxy.request(capability, request)).resolves.toMatchObject({ status: 200 });
    await expect(proxy.request(capability, request)).resolves.toMatchObject({ status: 200 });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
    });
    expect(logins).toBe(3);
  });
  it("accounts login path and actual credential JSON before admission", () => {
    for (const oversizedPath of [true, false]) {
      const value = loginConfig();
      value.profiles.sample.maxRequestBytes = 100;
      if (value.profiles.sample.auth.kind !== "login") throw new Error("Expected login fixture");
      value.profiles.sample.auth.path = oversizedPath ? "/" + "a".repeat(10000) : "/auth/login";
      let calls = 0;
      expect(() =>
        createProxy({
          config: value,
          secrets: { token: "x".repeat(200) },
          transport: async (input) => {
            calls++;
            return success(input);
          },
        }),
      ).toThrow("CONFIG_INVALID");
      expect(calls).toBe(0);
    }
  });
  it.each([
    async () => ({ status: 200, body: "not-json-private-detail" }),
    async () => ({ status: 400, body: "not-json-private-detail" }),
    async () => {
      throw new Error("private diagnostics synthetic-secret");
    },
  ])(
    "normalizes every exported client failure without private diagnostics %#",
    async (transport) => {
      const client = createApiClient(
        { proxyOrigin: "https://proxy.example.invalid", capability },
        transport,
      );
      await expect(client.request(request)).rejects.toMatchObject({
        code: "UPSTREAM_FAILED",
        message: "UPSTREAM_FAILED",
      });
      try {
        await client.request(request);
      } catch (error) {
        expect(JSON.stringify(error)).not.toMatch(/private|synthetic-secret/);
      }
    },
  );
  it("ships the operator documentation in the package files inventory", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    expect(manifest.files).toContain("docs/rest-api-proxy.md");
    expect(await readFile("docs/rest-api-proxy.md", "utf8")).toContain(
      "Required deployment boundary",
    );
  });
  it.each([
    `api-tool request --config /tmp/client.json --profile sample --path /v1/items --bod '{"a":1,"b":2}'`,
    `api-tool request --config /tmp/client.json --profile sample --path /v1/items --body '{"a":1,"b":2}' --body '{"b":2}'`,
    `api-tool request --config /tmp/client.json --profile sample --path /v1/items --body '{"a":1,"b":2}' --extra yes`,
    `api-tool request --config /tmp/client.json --profile sample --path /v1/items --body "$(printenv SYNTHETIC_TOKEN)"`,
    `api-tool request --config /tmp/client.json --profile sample --path /v1/items --body '{"a":"x"}' ; bash -c 'printenv SYNTHETIC_TOKEN'`,
    `bun run arbitrary-script request --body '{"a":1,"b":2}'`,
    `api-tool request --config /tmp/client.json --profile '{"a":1,"b":2}' --path /v1/items --body '{}'`,
  ])("refuses malicious neighboring JSON exemption commands %s", (command) => {
    expect(createCredentialGuard().isDangerousBashCommand(command)).toBe(true);
  });
  it.each([
    `api-tool request --config=/tmp/client.json --profile=sample --path=/v1/items --body='{"a":1}'`,
    `bun run api-tool request --config=/tmp/client.json --profile=sample --path=/v1/items --query='{"a":"1"}'`,
  ])("supports inert attached JSON arguments %s", (command) => {
    expect(createCredentialGuard().isDangerousBashCommand(command)).toBe(false);
  });
});

async function withProxy(
  transport: Transport,
  run: (origin: string, dir: string) => Promise<void>,
  maxResponseBytes = 2000,
  maxConcurrent = 4,
) {
  const dir = await mkdtemp(join(tmpdir(), "api-proxy-review-"));
  let server: Awaited<ReturnType<typeof startProxy>> | undefined;
  try {
    const value = config();
    value.listen.port = 0;
    value.maxConcurrent = maxConcurrent;
    value.profiles.sample.maxResponseBytes = maxResponseBytes;
    value.grants[0]!.maxBytes = 100_000_000;
    value.grants[0]!.expiresAt = Date.now() + 60000;
    value.profiles.sample.timeoutMs = 60000;
    value.secretsFile = join(dir, "store.json");
    value.grantUseDirectory = join(dir, "used");
    await writeFile(value.secretsFile, JSON.stringify({ token: credential }), { mode: 0o600 });
    await mkdir(value.grantUseDirectory, { mode: 0o700 });
    server = await startProxy(value, transport);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic server did not bind");
    await run(`http://127.0.0.1:${address.port}`, dir);
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(dir, { recursive: true, force: true });
  }
}

async function inspectProxyResult(proxyOrigin: string) {
  return makePinnedTransport()({
    url: new URL("/request", proxyOrigin),
    method: "POST",
    headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
    body: JSON.stringify(request),
    maxBytes: MAX_RESULT_ENVELOPE_BYTES + 1,
    signal: new AbortController().signal,
    allowedPrivateAddresses: [],
    developmentLoopback: true,
  });
}

describe("actual proxy output and CLI", () => {
  it("refuses JSON number expansion before server output", async () => {
    const body = "[" + Array(500000).fill("1e20").join(",") + "]";
    await withProxy(
      async () => ({ status: 200, body }),
      async (proxyOrigin) => {
        expect(await inspectProxyResult(proxyOrigin)).toEqual({
          status: 400,
          body: '{"code":"LIMIT_EXCEEDED"}',
        });
        const client = createApiClient({ proxyOrigin, capability, developmentLoopback: true });
        await expect(client.request(request)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
      },
      10_000_000,
    );
  }, 15000);
  it("accepts the exact envelope boundary and refuses one byte beyond", async () => {
    const overhead = Buffer.byteLength(JSON.stringify({ status: 200, data: "" }));
    let length = MAX_RESULT_ENVELOPE_BYTES - overhead;
    await withProxy(
      async () => ({ status: 200, body: JSON.stringify("x".repeat(length)) }),
      async (proxyOrigin) => {
        const client = createApiClient({ proxyOrigin, capability, developmentLoopback: true });
        expect((await client.request(request)).data).toHaveLength(length);
        length++;
        expect(await inspectProxyResult(proxyOrigin)).toEqual({
          status: 400,
          body: '{"code":"LIMIT_EXCEEDED"}',
        });
        await expect(client.request(request)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
      },
      10_000_000,
    );
  }, 15000);
  it("prints approved JSON through an actual successful api-tool request", async () => {
    await withProxy(success, async (proxyOrigin, dir) => {
      const file = join(dir, "client.json");
      await writeFile(file, JSON.stringify({ proxyOrigin, capability, developmentLoopback: true }));
      const result = await execFileAsync(
        "bun",
        [
          "src/api-tool/index.ts",
          "request",
          "--config",
          file,
          "--profile",
          "sample",
          "--path",
          "/v1/items",
        ],
        { timeout: 5000 },
      );
      expect(JSON.parse(result.stdout)).toEqual({ status: 200, data: { items: [1, 2] } });
      expect(result.stderr).not.toContain(credential);
    });
  });
});

describe("actual synthetic upstream TLS transport", () => {
  it("verifies trust and hostname, pins DNS, refuses redirects and streamed overflow in Node and Bun", async () => {
    const fixture = "tests/fixtures/api-proxy/";
    const [ca, cert, key] = await Promise.all(
      ["ca.pem", "cert.pem", "key.pem"].map((file) => readFile(fixture + file, "utf8")),
    );
    let requests = 0;
    let redirects = 0;
    const server = createHttpsServer({ cert, key }, (incoming, response) => {
      requests++;
      if (incoming.url === "/redirect") {
        response.writeHead(302, { location: "/followed" });
        response.end();
      } else if (incoming.url === "/followed") {
        redirects++;
        response.end("{}");
      } else if (incoming.url === "/overflow") {
        response.write("x".repeat(80));
        response.end("x".repeat(80));
      } else response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Synthetic TLS did not bind");
      let resolutions = 0;
      const resolver = async () => {
        resolutions++;
        return [{ address: "127.0.0.1", family: 4 }];
      };
      const trusted = makePinnedTransport(resolver, { ca });
      const input = (path: string, host = "service.example.invalid"): TransportRequest => ({
        url: new URL(`https://${host}:${address.port}${path}`),
        method: "GET",
        headers: {},
        body: "",
        maxBytes: 100,
        allowedPrivateAddresses: ["127.0.0.1"],
        signal: new AbortController().signal,
      });
      expect(await trusted(input("/ok"))).toEqual({ status: 200, body: '{"ok":true}' });
      await expect(makePinnedTransport(resolver)(input("/ok"))).rejects.toMatchObject({
        code: "UPSTREAM_FAILED",
      });
      await expect(trusted(input("/ok", "wrong.example.invalid"))).rejects.toMatchObject({
        code: "UPSTREAM_FAILED",
      });
      expect(requests).toBe(1);
      await expect(trusted(input("/redirect"))).rejects.toMatchObject({
        code: "DESTINATION_DENIED",
      });
      await expect(trusted(input("/overflow"))).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
      expect(redirects).toBe(0);
      expect(resolutions).toBe(5);
      const script = `import { makePinnedTransport } from "./src/api-tool/transport.ts"; const ca=await Bun.file(${JSON.stringify(fixture + "ca.pem")}).text(); let resolutions=0; const transport=makePinnedTransport(async()=>{resolutions++;return [{address:"127.0.0.1",family:4}]},{ca}); const input=(host,path)=>({url:new URL("https://"+host+":${address.port}"+path),method:"GET",headers:{},body:"",maxBytes:100,signal:new AbortController().signal,allowedPrivateAddresses:["127.0.0.1"]}); const results=[]; for(const [host,path] of [["service.example.invalid","/ok"],["wrong.example.invalid","/ok"],["service.example.invalid","/redirect"],["service.example.invalid","/overflow"]]) { try { results.push(await transport(input(host,path))); } catch(error) {results.push({code:error.code});} } try { results.push(await makePinnedTransport(async()=>{resolutions++;return [{address:"127.0.0.1",family:4}]})(input("service.example.invalid","/ok"))); } catch(error) { results.push({code:error.code}); } console.log(JSON.stringify({results,resolutions}));`;
      const child = await execFileAsync("bun", ["-e", script], {
        timeout: 10000,
        env: {
          ...process.env,
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
          ALL_PROXY: "http://127.0.0.1:1",
        },
      });
      expect(JSON.parse(child.stdout)).toEqual({
        results: [
          { status: 200, body: '{"ok":true}' },
          { code: "UPSTREAM_FAILED" },
          { code: "DESTINATION_DENIED" },
          { code: "LIMIT_EXCEEDED" },
          { code: "UPSTREAM_FAILED" },
        ],
        resolutions: 5,
      });
      expect(redirects).toBe(0);
      expect(requests).toBe(6);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 15000);
});

describe("Opus boundary regressions", () => {
  it.each(["/v1/auth;x/t", "/v1/AUTH/t", "/v1/auth./t"])(
    "denies normalized auth path %s before transport",
    async (path) => {
      let calls = 0;
      const proxy = proxyFor(async (input) => {
        calls++;
        return success(input);
      });
      await expect(proxy.request(capability, { ...request, path })).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
      expect(calls).toBe(0);
    },
  );
  it.each(["/auth/LOGIN", "/auth/login;x", "/auth/login./t"])(
    "denies normalized login path %s before transport",
    async (path) => {
      const value = loginConfig();
      value.profiles.sample.pathPrefixes = ["/"];
      let calls = 0;
      const proxy = createProxy({
        config: value,
        secrets: { token: credential },
        transport: async (input) => {
          calls++;
          return success(input);
        },
      });
      await expect(proxy.request(capability, { ...request, path })).rejects.toMatchObject({
        code: "POLICY_DENIED",
      });
      expect(calls).toBe(0);
    },
  );
  it.each([201, 204, 205])(
    "returns null for empty success status %s with one provider dispatch",
    async (status) => {
      for (const kind of ["raw", "fields"] as const) {
        const value = config();
        value.profiles.sample.methods = ["DELETE"];
        value.profiles.sample.disclosure = kind === "raw" ? { kind } : { kind, fields: ["items"] };
        let calls = 0;
        const proxy = proxyFor(async () => {
          calls++;
          return { status, body: "" };
        }, value);
        expect(await proxy.request(capability, { ...request, method: "DELETE" })).toEqual({
          status,
          data: null,
        });
        expect(calls).toBe(1);
      }
    },
  );
  it.each(["[]", "1", '"string"'])(
    "classifies unsupported projected data %s as disclosure denial",
    async (body) => {
      const value = config();
      value.profiles.sample.disclosure = { kind: "fields", fields: ["items"] };
      await expect(
        proxyFor(async () => ({ status: 200, body }), value).request(capability, request),
      ).rejects.toMatchObject({ code: "DISCLOSURE_DENIED" });
    },
  );
  it.each([false, true])("blocks unpadded base64 variant, url=%s", async (url) => {
    const secret = "\u00fb\u00ffsynthetic";
    const echo = Buffer.from(secret)
      .toString(url ? "base64url" : "base64")
      .replace(/=+$/, "");
    const proxy = createProxy({
      config: config(),
      secrets: { token: secret },
      transport: async () => ({ status: 200, body: JSON.stringify({ echo }) }),
    });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "DISCLOSURE_DENIED",
    });
  });
  it.each([
    ["2001:4860:4860::8888", true],
    ["2001::1", false],
    ["2001:1ff::1", false],
    ["2001:200::1", true],
    ["2001:db8::1", false],
    ["2002::1", false],
    ["3fff:fff::1", false],
    ["3fff:1000::1", true],
  ] as const)("classifies IPv6 special range %s as %s", (address, allowed) => {
    expect(allowedAddress(address, [])).toBe(allowed);
  });
  it.each([
    `./api-tool request --config c --profile p --path /v1 --body '{"a":"{e,}nv"}'`,
    `/tmp/x/agent-tools-api request --config c --profile p --path /v1 --body '{"a":"{e,}nv"}'`,
    `PATH=/tmp/x api-tool request --config c --profile p --path /v1 --body '{"a":"{e,}nv"}'`,
    `env PATH=/tmp/x api-tool request --config c --profile p --path /v1 --body '{"a":"{e,}nv"}'`,
    `api-tool request --config c --profile p --path '/v1/{a,b}' --body '{}'`,
    `api-tool request --config c --profile p --method EXEC --path /v1 --body '{"a":1,"b":2}'`,
    `api-tool request --config '{a,b}' --profile p --path /v1 --body '{}'`,
  ])("rejects a broader CLI identity or malformed fixed argument %s", (command) => {
    expect(createCredentialGuard().isDangerousBashCommand(command)).toBe(true);
  });
  it("bounds unresolved DNS operations after their callers abort", async () => {
    let calls = 0;
    let settle: (() => void) | undefined;
    const transport = makePinnedTransport(() => {
      calls++;
      return new Promise((resolve) => {
        settle = () => resolve([]);
      });
    });
    const input = () => ({
      url: new URL("https://service.example.invalid/x"),
      method: "GET",
      headers: {},
      body: "",
      maxBytes: 100,
      allowedPrivateAddresses: [],
    });
    for (let index = 0; index < MAX_PENDING_DNS_LOOKUPS; index++) {
      const controller = new AbortController();
      const pending = transport({ ...input(), signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    }
    await expect(
      transport({ ...input(), signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(calls).toBe(MAX_PENDING_DNS_LOOKUPS);
    settle?.();
    await Promise.resolve();
    await Promise.resolve();
    const controller = new AbortController();
    const pending = transport({ ...input(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(calls).toBe(MAX_PENDING_DNS_LOOKUPS + 1);
  });
  it("keeps an aborted login token slot until transport settles and retains a late token", async () => {
    const value = loginConfig();
    value.profiles.sample.timeoutMs = 10;
    let settle: ((result: { status: number; body: string }) => void) | undefined;
    const proxy = createProxy({
      config: value,
      secrets: storedSecrets(127),
      transport: (input) => {
        if (input.url.pathname === "/auth/login")
          return new Promise((resolve) => {
            settle = resolve;
          });
        return Promise.resolve({ status: 200, body: '{"echo":"late-minted-token"}' });
      },
    });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
    await expect(proxy.request(capability, request)).rejects.toMatchObject({
      code: "BUDGET_EXHAUSTED",
    });
    settle?.({ status: 200, body: '{"token":"late-minted-token"}' });
    await Promise.resolve();
    await Promise.resolve();
    await expect(proxy.request(capability, { ...request, profile: "echo" })).rejects.toMatchObject({
      code: "DISCLOSURE_DENIED",
    });
  });
  it("rejects invalid capability before a hanging body can occupy the sole handler slot", async () => {
    await withProxy(
      success,
      async (proxyOrigin) => {
        const bad = httpRequest(new URL("/request", proxyOrigin), {
          method: "POST",
          headers: {
            authorization: "Bearer synthetic-unknown-capability-00000001",
            "content-type": "application/json",
            "content-length": "100",
          },
        });
        try {
          const denied = new Promise<string>((resolve, reject) => {
            bad.on("error", reject);
            bad.on("response", (response) => {
              let body = "";
              response.on("data", (chunk) => {
                body += chunk;
              });
              response.on("end", () => resolve(body));
            });
          });
          bad.write("{");
          expect(JSON.parse(await denied)).toEqual({ code: "UNAUTHORIZED" });
          const client = createApiClient({ proxyOrigin, capability, developmentLoopback: true });
          expect(await client.request(request)).toEqual({ status: 200, data: { items: [1, 2] } });
        } finally {
          bad.destroy();
        }
      },
      2000,
      1,
    );
  });
  it("refuses bad content type and overlarge request envelope on the actual server", async () => {
    let calls = 0;
    await withProxy(
      async (input) => {
        calls++;
        return success(input);
      },
      async (proxyOrigin) => {
        for (const [contentType, body] of [
          ["text/plain", "{}"],
          ["application/json", "x".repeat(1000001)],
        ]) {
          const result = await makePinnedTransport()({
            url: new URL("/request", proxyOrigin),
            method: "POST",
            headers: { authorization: `Bearer ${capability}`, "content-type": contentType ?? "" },
            body: body ?? "",
            maxBytes: 1000,
            signal: new AbortController().signal,
            allowedPrivateAddresses: [],
            developmentLoopback: true,
          });
          expect(result.status).toBe(400);
          expect(JSON.parse(result.body).code).toBe(
            contentType === "text/plain" ? "POLICY_DENIED" : "LIMIT_EXCEEDED",
          );
        }
      },
    );
    expect(calls).toBe(0);
  });
  it("refuses nonprivate claims and existing markers before a restart listens", async () => {
    await withProxy(success, async (proxyOrigin, dir) => {
      const value = config();
      value.listen.port = Number(new URL(proxyOrigin).port);
      value.secretsFile = join(dir, "store.json");
      value.grantUseDirectory = join(dir, "used");
      await expect(startProxy(value, success)).rejects.toMatchObject({
        code: "GRANT_ALREADY_USED",
      });
      await chmod(value.grantUseDirectory, 0o755);
      await expect(claimGrants(value)).rejects.toMatchObject({ code: "GRANT_STORE_UNAVAILABLE" });
    });
  });
  it.each([
    {
      args: [
        "--config",
        "/nonexistent/synthetic-config.json",
        "--profile",
        "sample",
        "--path",
        "/v1/items",
      ],
    },
    { args: ["--unknown", "synthetic-value"] },
  ])("classifies local CLI usage and input errors as CONFIG_INVALID %#", ({ args }) => {
    const result = spawnSync("bun", ["src/api-tool/index.ts", "request", ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CONFIG_INVALID");
    expect(result.stderr).not.toContain("UPSTREAM_FAILED");
  });
  it("classifies malformed CLI JSON as local input failure before dispatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-cli-input-"));
    try {
      const file = join(dir, "client.json");
      await writeFile(
        file,
        JSON.stringify({ proxyOrigin: "https://proxy.example.invalid", capability }),
      );
      for (const flag of ["--query", "--body"]) {
        const result = spawnSync(
          "bun",
          [
            "src/api-tool/index.ts",
            "request",
            "--config",
            file,
            "--profile",
            "sample",
            "--path",
            "/v1/items",
            flag,
            "invalid-json",
          ],
          { encoding: "utf8", timeout: 5000 },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("CONFIG_INVALID");
        expect(result.stderr).not.toContain("UPSTREAM_FAILED");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
