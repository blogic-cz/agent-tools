import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { Effect } from "effect";
import type { Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { redactSensitiveText } from "#shared/content-security";
import {
  makeSecretEnvResolverLayer,
  makeZshRunner,
  type ZshLauncher,
  SecretEnvResolver,
  type LookupResult,
  type ZshRunner,
} from "#shared/secret-env";

const envBefore = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!envBefore.has(name)) envBefore.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of envBefore) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  envBefore.clear();
});

const resolveSecret = (layer: Layer.Layer<SecretEnvResolver>, name: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* SecretEnvResolver;
    }).pipe(Effect.provide(layer)),
  ).then((resolver) => resolver.resolveSecretEnv(name));

const lookupConfig = (layer: Layer.Layer<SecretEnvResolver>, name: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const resolver = yield* SecretEnvResolver;
      return yield* Effect.promise(() => resolver.lookupConfigEnv(name));
    }).pipe(Effect.provide(layer)),
  );

describe("SecretEnvResolver", () => {
  it("uses a defined process value, including empty strings, before the runner", async () => {
    const runner = vi.fn<ZshRunner>(async () => ({ _tag: "failed", reason: "unused" }));
    setEnv("AGENT_TOOLS_SECRET_ENV_PROCESS", "");
    setEnv("agent_tools_secret_env_lower", "app");
    const layer = makeSecretEnvResolverLayer(runner);

    await expect(lookupConfig(layer, "AGENT_TOOLS_SECRET_ENV_PROCESS")).resolves.toEqual({
      _tag: "found",
      value: "",
    });
    await expect(lookupConfig(layer, "agent_tools_secret_env_lower")).resolves.toEqual({
      _tag: "found",
      value: "app",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("falls through an empty process secret and rejects an empty shell secret", async () => {
    const name = "AGENT_TOOLS_SECRET_ENV_EMPTY";
    const runner = vi.fn<ZshRunner>(async () => ({ _tag: "found", value: "" }));
    setEnv(name, "");

    const error = await resolveSecret(SecretEnvResolver.testLayer(runner), name).then(
      () => new Error("unexpected success"),
      (cause: unknown) => cause,
    );

    expect(runner).toHaveBeenCalledOnce();
    expect(String(error)).toBe(`Error: ${name} is too short to redact safely`);
    expect(String(error)).not.toContain("fake-secret-");
  });

  it.each([
    [
      "absent",
      async (_name: string, _timeout: number): Promise<LookupResult> => ({ _tag: "absent" }),
    ],
    [
      "failed",
      async (_name: string, _timeout: number): Promise<LookupResult> => ({
        _tag: "failed",
        reason: "NAME",
      }),
    ],
    [
      "runner rejection",
      async (_name: string, _timeout: number): Promise<LookupResult> => {
        throw new Error("fake-secret-error");
      },
    ],
  ])("returns a name-only error for %s secrets", async (_label, runner) => {
    const fake = `fake-secret-${crypto.randomUUID()}`;
    const configuredRunner: ZshRunner = async (...args) => {
      try {
        const result = await runner(...args);
        return result._tag === "found" ? { _tag: "found", value: fake } : result;
      } catch {
        throw new Error(fake);
      }
    };
    const error = await resolveSecret(
      SecretEnvResolver.testLayer(configuredRunner),
      "AGENT_TOOLS_SECRET_ENV_MISSING",
    ).then(
      () => new Error("unexpected success"),
      (cause: unknown) => cause,
    );
    expect(String(error)).not.toContain(fake);
    expect(String(error)).toContain("AGENT_TOOLS_SECRET_ENV_MISSING");
  });

  it("rejects secret names outside the strict uppercase form without starting zsh", async () => {
    const runner = vi.fn<ZshRunner>(async () => ({ _tag: "absent" }));
    const error = await resolveSecret(makeSecretEnvResolverLayer(runner), "lowercase_name").then(
      () => new Error("unexpected success"),
      (cause: unknown) => cause,
    );
    expect(String(error)).toContain("Invalid environment variable name: lowercase_name");
    expect(runner).not.toHaveBeenCalled();
  });

  it("caches shell lookup results by name", async () => {
    let calls = 0;
    const runner = async (): Promise<LookupResult> => {
      calls += 1;
      return { _tag: "found", value: "fake-cached-value" };
    };
    const resolver = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* SecretEnvResolver;
      }).pipe(Effect.provide(makeSecretEnvResolverLayer(runner))),
    );
    await Promise.all([
      resolver.resolveSecretEnv("AGENT_TOOLS_SECRET_ENV_CACHED"),
      resolver.resolveSecretEnv("AGENT_TOOLS_SECRET_ENV_CACHED"),
    ]);
    expect(calls).toBe(1);
  });

  it("registers four-character secrets for redaction", async () => {
    const fake = crypto.randomUUID().slice(0, 4);
    const layer = SecretEnvResolver.testLayer(async () => ({ _tag: "found", value: fake }));
    await resolveSecret(layer, "AGENT_TOOLS_SECRET_ENV_SHORT");
    expect(redactSensitiveText(`echo ${fake}`, {})).toBe("echo [REDACTED]");
  });

  it("rejects secrets shorter than four characters with a name-only error", async () => {
    const name = "AGENT_TOOLS_SECRET_ENV_TOO_SHORT";
    const fake = crypto.randomUUID().slice(0, 3);
    const layer = SecretEnvResolver.testLayer(async () => ({ _tag: "found", value: fake }));
    const error = await resolveSecret(layer, name).then(
      () => new Error("unexpected success"),
      (cause: unknown) => cause,
    );

    expect(String(error)).toBe(`Error: ${name} is too short to redact safely`);
    expect(String(error)).not.toContain(fake);
  });

  it("does not run the live shell in Vitest without a temporary ZDOTDIR", async () => {
    setEnv("VITEST", "true");
    setEnv("ZDOTDIR", undefined);
    const error = await resolveSecret(
      SecretEnvResolver.liveLayer,
      "AGENT_TOOLS_SECRET_ENV_GUARD",
    ).then(
      () => new Error("unexpected success"),
      (cause: unknown) => cause,
    );
    expect(String(error)).toContain("AGENT_TOOLS_SECRET_ENV_GUARD");
  });

  const fakeShell = () => {
    setEnv("VITEST", undefined);
    const pipe = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdio: [null, null, null, pipe, null] satisfies ReturnType<ZshLauncher>["stdio"],
      kill: vi.fn<() => boolean>(() => true),
    });
    const launch = vi.fn<ZshLauncher>(() => child);
    const terminate = vi.fn<(pid: number) => void>();
    return { pipe, child, launch, terminate, runner: makeZshRunner(launch, terminate) };
  };
  const frame = (value: string) => Buffer.from(`set\n${Buffer.byteLength(value)}\n${value}`);

  it("round-trips newline and frame-like text over the dedicated pipe", async () => {
    const shell = fakeShell();
    const value = "fake-secret-line-one\nset\n0\nfake-secret-π-line-two";
    const result = shell.runner("AGENT_TOOLS_SECRET_ENV_FRAME", 1000);
    shell.pipe.emit("data", frame(value).subarray(0, 8));
    shell.pipe.emit("data", frame(value).subarray(8));
    shell.child.emit("exit", 0);
    expect(await result).toEqual({ _tag: "found", value });
    expect(shell.launch).toHaveBeenCalledWith(
      "zsh",
      ["-i", "-c", expect.any(String), "agent-tools-secret-env", "AGENT_TOOLS_SECRET_ENV_FRAME"],
      expect.objectContaining({ detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] }),
    );
    expect(shell.terminate).toHaveBeenCalledWith(-42);
  });

  it("rejects an empty value from the shell runner", async () => {
    const shell = fakeShell();
    const name = "AGENT_TOOLS_SECRET_ENV_EMPTY_FROM_ZSH";
    const result = resolveSecret(makeSecretEnvResolverLayer(shell.runner), name);
    await vi.waitFor(() => expect(shell.launch).toHaveBeenCalled());
    shell.pipe.emit("data", frame(""));
    shell.child.emit("exit", 0);
    await expect(result).rejects.toThrow(`${name} is too short to redact safely`);
  });

  it("passes allowlisted startup inputs and excludes other parent variables", async () => {
    setEnv("XDG_CONFIG_HOME", "fake-secret-allowed-selector");
    setEnv("AGENT_TOOLS_SECRET_ENV_PARENT_ONLY", "fake-secret-parent-only");
    const shell = fakeShell();
    const result = shell.runner("AGENT_TOOLS_SECRET_ENV_ALLOWED", 1000);
    expect(shell.launch.mock.calls[0]?.[2].env).toMatchObject({
      XDG_CONFIG_HOME: "fake-secret-allowed-selector",
    });
    expect(shell.launch.mock.calls[0]?.[2].env).not.toHaveProperty(
      "AGENT_TOOLS_SECRET_ENV_PARENT_ONLY",
    );
    shell.pipe.emit("data", frame("fake-secret-allowed-value"));
    shell.child.emit("exit", 0);
    expect(await result).toEqual({ _tag: "found", value: "fake-secret-allowed-value" });
  });

  it("reports an unset shell parameter as absent", async () => {
    const shell = fakeShell();
    const result = shell.runner("AGENT_TOOLS_SECRET_ENV_UNSET", 1000);
    shell.pipe.emit("data", Buffer.from("unset\n"));
    shell.child.emit("exit", 0);
    expect(await result).toEqual({ _tag: "absent" });
  });

  it("rejects startup text written to the private frame pipe", async () => {
    const shell = fakeShell();
    const result = shell.runner("AGENT_TOOLS_SECRET_ENV_CORRUPT", 1000);
    shell.pipe.emit("data", Buffer.from("fake-secret-corrupt-frame\n"));
    expect(await result).toEqual({ _tag: "failed", reason: "AGENT_TOOLS_SECRET_ENV_CORRUPT" });
    expect(shell.terminate).toHaveBeenCalledWith(-42);
  });

  it.each(["a disowned background process", "a hanging rc"])(
    "settles at the deadline when the shell hangs with %s",
    async () => {
      vi.useFakeTimers();
      try {
        const shell = fakeShell();
        const result = shell.runner("AGENT_TOOLS_SECRET_ENV_TIMEOUT", 150);
        await vi.advanceTimersByTimeAsync(149);
        expect(shell.terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toEqual({ _tag: "failed", reason: "AGENT_TOOLS_SECRET_ENV_TIMEOUT" });
        expect(shell.terminate).toHaveBeenCalledWith(-42);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["a background process in the child group", "a daemon in a separate session"])(
    "returns a valid value while %s keeps fd 3 open",
    async () => {
      const shell = fakeShell();
      const result = shell.runner("AGENT_TOOLS_SECRET_ENV_BACKGROUND", 1500);
      shell.pipe.emit("data", frame("fake-secret-background-value"));
      shell.child.emit("exit", 0);
      expect(await result).toEqual({ _tag: "found", value: "fake-secret-background-value" });
      expect(shell.pipe.destroyed).toBe(true);
    },
  );
});
