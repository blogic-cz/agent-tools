import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { AgentToolsConfig } from "#config";

import { AzService } from "#az/service";
import { ConfigService } from "#config";

type SpawnResult = { stdout: string; stderr: string; exitCode: number };

const OK: SpawnResult = { stdout: "[]", stderr: "", exitCode: 0 };

const SUBSCRIPTION = "11111111-2222-3333-4444-555555555555";

function createMockProcess(result: SpawnResult) {
  const encoder = new TextEncoder();
  const reref: ChildProcessSpawner.Reref = Effect.void;

  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.succeed(undefined),
    stderr: Stream.fromIterable([encoder.encode(result.stderr)]),
    stdin: Sink.drain,
    stdout: Stream.fromIterable([encoder.encode(result.stdout)]),
    all: Stream.fromIterable([encoder.encode(result.stdout)]),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(reref),
  });
}

/** Records every argv the service actually spawns, so scoping can be asserted. */
function createSpawnerLayer(observed: string[][], result: SpawnResult = OK) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const spawned = command as { command: string; args: readonly string[] };
      observed.push([spawned.command, ...spawned.args]);
      return Effect.succeed(createMockProcess(result));
    }),
  );
}

/** The real AzService layer — only the spawner and config are stubbed. */
function createServiceLayer(
  config: AgentToolsConfig | undefined,
  observed: string[][],
  result: SpawnResult = OK,
) {
  return AzService.layer.pipe(
    Layer.provide(createSpawnerLayer(observed, result)),
    Layer.provide(Layer.succeed(ConfigService, config)),
  );
}

const configWith = (
  platform: Record<string, Record<string, unknown>> | undefined,
): AgentToolsConfig =>
  platform ? ({ azurePlatform: platform } as AgentToolsConfig) : ({} as AgentToolsConfig);

describe("AzService", () => {
  describe("subscription pinning", () => {
    it.effect("appends the configured subscription to every spawned command", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ default: { subscription: SUBSCRIPTION } }),
          observed,
        );

        yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("vm list");
        }).pipe(Effect.provide(layer));

        expect(observed).toHaveLength(1);
        const argv = observed[0] ?? [];
        expect(argv[0]).toBe("az");
        expect(argv).toContain("--subscription");
        expect(argv[argv.indexOf("--subscription") + 1]).toBe(SUBSCRIPTION);
      }),
    );

    it.effect("injects --output json only when the caller did not choose a format", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ default: { subscription: SUBSCRIPTION } }),
          observed,
        );

        yield* Effect.gen(function* () {
          const az = yield* AzService;
          yield* az.runCommand("vm list");
          yield* az.runCommand("vm list --output table");
        }).pipe(Effect.provide(layer));

        expect(observed[0]?.join(" ")).toContain("--output json");
        expect(observed[1]?.join(" ")).toContain("--output table");
        expect(observed[1]?.filter((arg) => arg === "--output")).toHaveLength(1);
      }),
    );

    it.effect("rejects a blocked command without spawning anything", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ default: { subscription: SUBSCRIPTION } }),
          observed,
        );

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("vm delete --name web01");
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("AzSecurityError");
        expect(observed).toHaveLength(0);
      }),
    );
  });

  describe("missing configuration", () => {
    it.effect("fails with AzCommandError when no azurePlatform section exists", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(configWith(undefined), observed);

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("vm list");
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("AzCommandError");
          expect(result.failure.message).toContain("azurePlatform");
        }
        expect(observed).toHaveLength(0);
      }),
    );
  });

  describe("production profile guard", () => {
    it.effect("blocks an implicitly selected prod profile through runCommand", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ prod: { subscription: SUBSCRIPTION } }),
          observed,
        );

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("vm list");
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("AzProfileError");
          expect(result.failure.message).toContain("Implicit production access blocked");
        }
        expect(observed).toHaveLength(0);
      }),
    );

    it.effect("blocks it through renderCommand too, so --dry-run cannot leak the pin", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ prod: { subscription: SUBSCRIPTION } }),
          observed,
        );

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.renderCommand("vm list");
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("AzProfileError");
      }),
    );

    it.effect("allows a prod profile once it is named explicitly", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ prod: { subscription: SUBSCRIPTION } }),
          observed,
        );

        yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("vm list", "prod");
        }).pipe(Effect.provide(layer));

        expect(observed).toHaveLength(1);
        expect(observed[0]?.join(" ")).toContain(`--subscription ${SUBSCRIPTION}`);
      }),
    );

    it.effect("honours production: false on a prod-named profile", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ prod: { subscription: SUBSCRIPTION, production: false } }),
          observed,
        );

        yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("vm list");
        }).pipe(Effect.provide(layer));

        expect(observed).toHaveLength(1);
      }),
    );

    it.effect("blocks a default-keyed profile flagged production: true", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({
            default: { subscription: SUBSCRIPTION, production: true },
            dev: { subscription: "dev-sub" },
          }),
          observed,
        );

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("vm list");
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("AzProfileError");
      }),
    );
  });

  describe("resource group allowlist", () => {
    it.effect("threads allowedResourceGroups from config into the security gate", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({
            default: { subscription: SUBSCRIPTION, allowedResourceGroups: ["rg-a"] },
          }),
          observed,
        );

        const denied = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("vm list --resource-group rg-evil");
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(denied)).toBe(true);
        if (Result.isFailure(denied)) expect(denied.failure._tag).toBe("AzSecurityError");
        expect(observed).toHaveLength(0);

        yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("vm list --resource-group rg-a");
        }).pipe(Effect.provide(layer));

        expect(observed).toHaveLength(1);
      }),
    );
  });

  describe("command failure", () => {
    it.effect("surfaces a non-zero exit as AzCommandError with stderr", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ default: { subscription: SUBSCRIPTION } }),
          observed,
          { stdout: "", stderr: "ERROR: subscription not found", exitCode: 1 },
        );

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("vm list");
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("AzCommandError");
          expect(result.failure.message).toContain("subscription not found");
        }
      }),
    );
  });
});
