import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";

import { githubApi, resolveGitHubToken } from "#gh/api";
import { ghEnvironment } from "#gh/environment";
import { isSensitivePath, readValidatedOutboundFile } from "#gh/text-input";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ApiFetch = (url: string, options: RequestInit) => Promise<Response>;

const originalEnvironment = process.env;
afterEach(() => {
  process.env = originalEnvironment;
  vi.unstubAllGlobals();
});

describe("GitHub request snapshots", () => {
  const secret = "synthetic-value-12345678901234567890";
  const escapedSecret = 'synthetic\nsecret"with\\escaping';
  const dump = "APP_MODE=test\nLOG_LEVEL=info\nREGION=example\nSERVICE_PASSWORD=short\nWORKERS=2";

  it.effect("rejects serialized credentials, escaped secrets and keys before auth or fetch", () =>
    Effect.gen(function* () {
      process.env = { NOVEL_SECRET: escapedSecret };
      const auth = vi.fn<() => void>();
      const fetch = vi.fn<ApiFetch>();
      vi.stubGlobal("Bun", { spawn: auth });
      vi.stubGlobal("fetch", fetch);
      for (const body of [
        { password: secret },
        { toJSON: () => ({ password: secret }) },
        { nested: [{ text: escapedSecret }] },
        { [escapedSecret]: "ordinary" },
        { nested: [{ text: dump }] },
        { [dump]: "ordinary" },
      ]) {
        const result = yield* githubApi({
          path: "repos/owner/repo/issues",
          method: "POST",
          body,
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("GitHubCommandError");
      }
      expect(auth).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it.effect("maps serialization failures before authentication", () =>
    Effect.gen(function* () {
      process.env = {};
      const auth = vi.fn<() => void>();
      const fetch = vi.fn<ApiFetch>();
      vi.stubGlobal("Bun", { spawn: auth });
      vi.stubGlobal("fetch", fetch);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      for (const body of [
        circular,
        1n,
        () => "not JSON",
        {
          get value() {
            throw new Error("synthetic getter failure");
          },
        },
      ]) {
        const result = yield* githubApi({ path: "repos/owner/repo/issues", body }).pipe(
          Effect.result,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure.message).toBe("Refusing to publish an invalid request body");
      }
      expect(auth).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it.effect("serializes getters and toJSON once and sends the snapshot across a retry", () =>
    Effect.gen(function* () {
      process.env = { GH_TOKEN: "synthetic-auth" };
      let getters = 0;
      let serializations = 0;
      let paths = 0;
      let methods = 0;
      const fetch = vi
        .fn<ApiFetch>()
        .mockResolvedValueOnce(new Response("{}", { status: 502 }))
        .mockResolvedValueOnce(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      const request = githubApi({
        get path() {
          paths += 1;
          return paths === 1 ? "repos/owner/repo/issues" : `repos/${secret}`;
        },
        get method() {
          methods += 1;
          return "GET" as const;
        },
        body: {
          toJSON() {
            serializations += 1;
            return {
              get text() {
                getters += 1;
                return getters === 1 ? "ordinary\nbody" : secret;
              },
            };
          },
        },
      });
      const fiber = yield* Effect.forkChild(request);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(serializations).toBe(1);
      expect(getters).toBe(1);
      expect(paths).toBe(1);
      expect(methods).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const [url, options] of fetch.mock.calls) {
        expect(url).toBe("https://api.github.com/repos/owner/repo/issues");
        expect(options.body).toBe('{"text":"ordinary\\nbody"}');
      }
    }),
  );

  it.effect("keeps absent bodies absent and JSON null intact", () =>
    Effect.gen(function* () {
      process.env = { GH_TOKEN: "synthetic-auth" };
      const fetch = vi.fn<ApiFetch>().mockImplementation(() => Promise.resolve(new Response("{}")));
      vi.stubGlobal("fetch", fetch);
      yield* githubApi({ path: "repos/owner/repo/issues" });
      yield* githubApi({ path: "repos/owner/repo/issues", method: "POST", body: null });
      expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("body");
      expect(fetch.mock.calls[0]?.[1].headers).not.toHaveProperty("Content-Type");
      expect(fetch.mock.calls[1]?.[1].body).toBe("null");
    }),
  );
});

describe("GitHub child environment", () => {
  it("copies exact supported names without unrelated credentials or execution settings", () => {
    const allowed = {
      PATH: "/synthetic/bin",
      HOME: "/synthetic/home",
      USERPROFILE: "C:\\Users\\test",
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
      AppData: "C:\\Users\\test\\AppData\\Roaming",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\test",
      SYSTEMROOT: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TMPDIR: "/synthetic/tmp",
      TMP: "tmp",
      TEMP: "temp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      TERM: "dumb",
      XDG_CONFIG_HOME: "/synthetic/config",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic/session-bus",
      GH_CONFIG_DIR: "/synthetic/gh",
      GH_HOST: "github.example.test",
      GH_REPO: "owner/repo",
      GH_TOKEN: "synthetic-gh",
      GITHUB_TOKEN: "synthetic-github",
      GH_ENTERPRISE_TOKEN: "synthetic-enterprise",
      GITHUB_ENTERPRISE_TOKEN: "synthetic-enterprise-github",
      HTTP_PROXY: "http://proxy",
      http_proxy: "http://proxy",
      HTTPS_PROXY: "http://proxy",
      https_proxy: "http://proxy",
      ALL_PROXY: "http://proxy",
      all_proxy: "http://proxy",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
      SSL_CERT_FILE: "/synthetic/ca.pem",
      SSL_CERT_DIR: "/synthetic/certs",
    };
    const excluded = Object.fromEntries(
      [
        "DATABASE_URL",
        "AWS_SECRET_ACCESS_KEY",
        "AZURE_DEVOPS_EXT_PAT",
        "NOVEL_NAME",
        "GH_NOVEL_NAME",
        "NODE_OPTIONS",
        "PYTHONPATH",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "GH_PAGER",
        "PAGER",
        "GH_EDITOR",
        "EDITOR",
      ].map((name) => [name, "synthetic-unrelated"]),
    );
    expect(ghEnvironment({ ...allowed, ...excluded })).toEqual(allowed);
    expect(ghEnvironment({ GH_TOKEN: undefined })).toEqual({});
  });

  it.effect("uses the allowlist for the gh auth fallback and preserves token precedence", () =>
    Effect.gen(function* () {
      const spawn = vi.fn<() => { stdout: Response["body"]; exited: Promise<number> }>(() => ({
        stdout: new Response("synthetic-fallback\n").body,
        exited: Promise.resolve(0),
      }));
      vi.stubGlobal("Bun", { spawn });
      process.env = { GH_TOKEN: "synthetic-gh", GITHUB_TOKEN: "synthetic-github" };
      expect(yield* resolveGitHubToken()).toBe("synthetic-gh");
      delete process.env.GH_TOKEN;
      expect(yield* resolveGitHubToken()).toBe("synthetic-github");
      expect(spawn).not.toHaveBeenCalled();
      process.env = {
        PATH: "/synthetic/bin",
        HOME: "/synthetic/home",
        GH_CONFIG_DIR: "/synthetic/config",
        HTTPS_PROXY: "http://proxy",
        SSL_CERT_FILE: "/synthetic/ca.pem",
        AWS_SECRET_ACCESS_KEY: "synthetic-aws",
        NODE_OPTIONS: "untrusted-loader",
      };
      expect(yield* resolveGitHubToken()).toBe("synthetic-fallback");
      expect(spawn).toHaveBeenCalledWith(["gh", "auth", "token", "--hostname", "github.com"], {
        stdout: "pipe",
        stderr: "ignore",
        env: {
          PATH: "/synthetic/bin",
          HOME: "/synthetic/home",
          GH_CONFIG_DIR: "/synthetic/config",
          HTTPS_PROXY: "http://proxy",
          SSL_CERT_FILE: "/synthetic/ca.pem",
        },
      });
    }),
  );
});

describe("GitHub outbound file failures", () => {
  it("matches complete credential path components with either separator", () => {
    expect(isSensitivePath("C:\\Users\\synthetic\\.ssh\\id_rsa")).toBe(true);
    expect(isSensitivePath("C:\\Users\\synthetic\\AppData\\Roaming\\GitHub CLI\\hosts.yml")).toBe(
      true,
    );
    expect(isSensitivePath("/repo/my-secrets-notes/README.md")).toBe(false);
    expect(isSensitivePath("/repo/.docker/README.md")).toBe(false);
    expect(isSensitivePath("/repo/.config/gh/README.md")).toBe(false);
  });

  it.effect("refuses failed byte reads and invalid UTF-8", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "gh-byte-failure-")));
      const path = join(directory, "ordinary.txt");
      yield* Effect.promise(() => writeFile(path, "ordinary"));
      yield* Effect.gen(function* () {
        for (const bytes of [
          () => Promise.reject(new Error("synthetic read failure")),
          () => Promise.resolve(new Uint8Array([0xff])),
        ]) {
          vi.stubGlobal("Bun", { file: () => ({ bytes }) });
          const result = yield* readValidatedOutboundFile(path, "gh-test").pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
        }
      }).pipe(
        Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))),
      );
    }),
  );
});
