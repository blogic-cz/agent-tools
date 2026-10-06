import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createProxy, capabilityDigest } from "#api/proxy";
import { validateOperator, relativePath } from "#api/types";
import { createApiClient } from "#api/client";
import { allowedAddress, makePinnedTransport } from "#api/transport";
import { startProxy } from "#api/server";
import { claimGrants, readSecretStore } from "#api/store";
import { safeError } from "#api/errors";
import { createCredentialGuard } from "#guard";
import type { Transport, TransportRequest } from "#api/transport";
import type { OperatorConfig } from "#api/types";

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
    try {
      await proxy.request(capability, request);
    } catch (error) {
      expect(JSON.stringify(safeError(error))).not.toContain(credential);
      expect(safeError(error).code).toBe("UPSTREAM_FAILED");
    }
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
      // Port zero is reserved to tests; validated runtime configurations require a finite port.
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
