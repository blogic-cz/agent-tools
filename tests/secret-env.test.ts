import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import type { Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { redactSensitiveText } from "#shared/content-security";
import {
  makeSecretEnvResolverLayer,
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

async function withZdotdir<T>(rc: string, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tools-secret-env-"));
  const oldHome = process.env.HOME;
  const oldZdotdir = process.env.ZDOTDIR;
  const oldVitest = process.env.VITEST;
  process.env.HOME = directory;
  process.env.ZDOTDIR = directory;
  delete process.env.VITEST;
  await writeFile(join(directory, ".zshrc"), rc);
  try {
    return await run(directory);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldZdotdir === undefined) delete process.env.ZDOTDIR;
    else process.env.ZDOTDIR = oldZdotdir;
    if (oldVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = oldVitest;
    await rm(directory, { recursive: true, force: true });
  }
}

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

  it("round-trips newline and frame-like text over the dedicated pipe", async () =>
    withZdotdir(
      'export AGENT_TOOLS_SECRET_ENV_FRAME=$\'fake-secret-line-one\\nset\\n0\\nfake-secret-π-line-two\'\nprint -r -- "startup fake-secret-noise"\nprint -ru2 -- "startup fake-secret-stderr"\n',
      async () => {
        const value = await resolveSecret(
          makeSecretEnvResolverLayer(undefined, 1000),
          "AGENT_TOOLS_SECRET_ENV_FRAME",
        );
        expect(value).toBe("fake-secret-line-one\nset\n0\nfake-secret-π-line-two");
      },
    ));

  it("rejects an empty value from real zsh", async () =>
    withZdotdir("export AGENT_TOOLS_SECRET_ENV_EMPTY_FROM_ZSH=''\n", async () => {
      const name = "AGENT_TOOLS_SECRET_ENV_EMPTY_FROM_ZSH";
      const error = await resolveSecret(makeSecretEnvResolverLayer(undefined, 1000), name).then(
        () => new Error("unexpected success"),
        (cause: unknown) => cause,
      );
      expect(String(error)).toBe(`Error: ${name} is too short to redact safely`);
    }));

  it("passes allowlisted startup inputs and excludes other parent variables", async () => {
    setEnv("XDG_CONFIG_HOME", "fake-secret-allowed-selector");
    const allowed = await withZdotdir(
      'if [[ "$XDG_CONFIG_HOME" == fake-secret-allowed-selector ]]; then export AGENT_TOOLS_SECRET_ENV_ALLOWED=fake-secret-allowed-value; fi\n',
      () =>
        resolveSecret(
          makeSecretEnvResolverLayer(undefined, 1000),
          "AGENT_TOOLS_SECRET_ENV_ALLOWED",
        ),
    );
    expect(allowed).toBe("fake-secret-allowed-value");

    const parentOnly = `fake-secret-${crypto.randomUUID()}`;
    setEnv("AGENT_TOOLS_SECRET_ENV_PARENT_ONLY", parentOnly);
    const absent = await withZdotdir(
      'if [[ -n "$AGENT_TOOLS_SECRET_ENV_PARENT_ONLY" ]]; then export AGENT_TOOLS_SECRET_ENV_EXCLUDED=fake-secret-exposed; fi\n',
      () =>
        resolveSecret(
          makeSecretEnvResolverLayer(undefined, 1000),
          "AGENT_TOOLS_SECRET_ENV_EXCLUDED",
        ).then(
          () => "unexpected success",
          (error: unknown) => String(error),
        ),
    );
    expect(absent).toContain("AGENT_TOOLS_SECRET_ENV_EXCLUDED");
    expect(absent).not.toContain(parentOnly);
  });

  it("reports an unset shell parameter as absent", async () =>
    withZdotdir("", async () => {
      const error = await resolveSecret(
        makeSecretEnvResolverLayer(undefined, 1000),
        "AGENT_TOOLS_SECRET_ENV_UNSET",
      ).then(
        () => new Error("unexpected success"),
        (cause: unknown) => cause,
      );
      expect(String(error)).toContain("AGENT_TOOLS_SECRET_ENV_UNSET");
      expect(String(error)).not.toContain("fake-secret-");
    }));

  it("rejects startup text written to the private frame pipe", async () =>
    withZdotdir(
      'print -ru3 -- "fake-secret-corrupt-frame"\nexport AGENT_TOOLS_SECRET_ENV_CORRUPT=fake-secret-real-value\n',
      async () => {
        const error = await resolveSecret(
          makeSecretEnvResolverLayer(undefined, 1000),
          "AGENT_TOOLS_SECRET_ENV_CORRUPT",
        ).then(
          () => new Error("unexpected success"),
          (cause: unknown) => cause,
        );
        expect(String(error)).toContain("AGENT_TOOLS_SECRET_ENV_CORRUPT");
        expect(String(error)).not.toContain("fake-secret-");
      },
    ));

  it.each([
    ["a disowned background process", "/bin/sleep 30 &!\nwhile true; do :; done\n"],
    ["a hanging rc", "while true; do :; done\n"],
  ])("settles within the timeout when zsh hangs with %s", async (_label, rc) =>
    withZdotdir(rc, async () => {
      const started = Date.now();
      await expect(
        resolveSecret(makeSecretEnvResolverLayer(undefined, 150), "AGENT_TOOLS_SECRET_ENV_TIMEOUT"),
      ).rejects.toThrow("AGENT_TOOLS_SECRET_ENV_TIMEOUT");
      expect(Date.now() - started).toBeLessThan(1500);
    }),
  );

  it.each([
    ["a background process in the child group", "/bin/sleep 30 &!\n"],
    [
      "a daemon in a separate session",
      '/usr/bin/perl -MPOSIX -e \'setsid(); open(my $f, q{>}, $ARGV[0]); print $f $$; close($f); sleep 30\' "$ZDOTDIR/daemon.pid" &!\nwhile [[ ! -s "$ZDOTDIR/daemon.pid" ]]; do /bin/sleep 0.01; done\n',
    ],
  ])("returns a valid value while %s keeps fd 3 open", async (_label, startup) =>
    withZdotdir(
      `${startup}export AGENT_TOOLS_SECRET_ENV_BACKGROUND=fake-secret-background-value\n`,
      async (directory) => {
        const started = Date.now();
        const value = await resolveSecret(
          makeSecretEnvResolverLayer(undefined, 1500),
          "AGENT_TOOLS_SECRET_ENV_BACKGROUND",
        );
        expect(value).toBe("fake-secret-background-value");
        expect(Date.now() - started).toBeLessThan(1000);

        if (startup.includes("setsid")) {
          const pidFile = join(directory, "daemon.pid");
          const pid = Number(await readFile(pidFile, "utf8"));
          process.kill(pid, "SIGKILL");
        }
      },
    ),
  );
});
