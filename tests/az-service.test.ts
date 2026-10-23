import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

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

type SpawnResponder = SpawnResult | ((args: readonly string[]) => SpawnResult);

/** Records every argv the service actually spawns, so scoping can be asserted. */
function createSpawnerLayer(observed: string[][], result: SpawnResponder = OK) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const spawned = command as { command: string; args: readonly string[] };
      observed.push([spawned.command, ...spawned.args]);
      return Effect.succeed(
        createMockProcess(typeof result === "function" ? result(spawned.args) : result),
      );
    }),
  );
}

/** The real AzService layer — only the spawner and config are stubbed. */
function createServiceLayer(
  config: AgentToolsConfig | undefined,
  observed: string[][],
  result: SpawnResponder = OK,
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
  it.effect("refuses credential-bearing command arguments before spawning az", () =>
    Effect.gen(function* () {
      const observed: string[][] = [];
      const layer = createServiceLayer(
        configWith({ default: { subscription: SUBSCRIPTION } }),
        observed,
      );
      const token = `ghp_${"A".repeat(36)}`;
      const splitToken = `ghp_${"A".repeat(18)}'${"A".repeat(18)}'`;
      const result = yield* Effect.gen(function* () {
        const az = yield* AzService;
        return yield* az.runCommand(`vm list --query ${splitToken}`);
      }).pipe(Effect.result, Effect.provide(layer));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result) && result.failure._tag === "AzSecurityError") {
        expect(result.failure.message).toContain("credential pattern");
        expect(result.failure.command).not.toContain(token);
      }
      expect(observed).toHaveLength(0);
    }),
  );

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

  describe("resource IDs", () => {
    it.effect("refuses an ID naming a subscription other than the pinned one", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ default: { subscription: SUBSCRIPTION } }),
          observed,
        );

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand(
            "monitor metrics list --resource /subscriptions/other/resourceGroups/rg/providers/p/t/n",
          );
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("AzSecurityError");
        expect(observed).toHaveLength(0);
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

  describe("tenant-bound commands", () => {
    const OTHER_SUBSCRIPTION = "99999999-2222-3333-4444-555555555555";

    const accounts = (defaultTenant: string) =>
      JSON.stringify([
        { id: SUBSCRIPTION, name: "pinned", tenantId: "tenant-a", isDefault: false },
        { id: OTHER_SUBSCRIPTION, name: "other", tenantId: defaultTenant, isDefault: true },
      ]);

    const respondWith =
      (accountList: SpawnResult) =>
      (args: readonly string[]): SpawnResult =>
        args[0] === "account" && args[1] === "list" ? accountList : OK;

    const entraConfig = configWith({ default: { subscription: SUBSCRIPTION, allowEntra: true } });

    it.effect("runs Entra commands without --subscription once the tenants match", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          entraConfig,
          observed,
          respondWith({ stdout: accounts("tenant-a"), stderr: "", exitCode: 0 }),
        );

        yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("ad user list");
        }).pipe(Effect.provide(layer));

        expect(observed).toHaveLength(2);
        expect(observed[0]?.slice(1, 3)).toEqual(["account", "list"]);
        expect(observed[1]?.slice(1, 4)).toEqual(["ad", "user", "list"]);
        expect(observed[1]).not.toContain("--subscription");
      }),
    );

    it.effect("runs management group reads without --subscription after the tenant check", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ default: { subscription: SUBSCRIPTION, allowTenantScope: true } }),
          observed,
          respondWith({ stdout: accounts("tenant-a"), stderr: "", exitCode: 0 }),
        );

        yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("account management-group list");
        }).pipe(Effect.provide(layer));

        expect(observed).toHaveLength(2);
        expect(observed[0]?.slice(1, 3)).toEqual(["account", "list"]);
        expect(observed[1]?.slice(1, 4)).toEqual(["account", "management-group", "list"]);
        expect(observed[1]).not.toContain("--subscription");
      }),
    );

    it.effect("refuses when the default login is in another tenant", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          entraConfig,
          observed,
          respondWith({ stdout: accounts("tenant-b"), stderr: "", exitCode: 0 }),
        );

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("ad user list");
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("AzSecurityError");
          expect(result.failure.message).toContain("tenant-b");
        }
        expect(observed).toHaveLength(1);
      }),
    );

    it.effect("refuses a profile pinned by a subscription name that is not unique", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ default: { subscription: "shared-name", allowEntra: true } }),
          observed,
          respondWith({
            stdout: JSON.stringify([
              { id: SUBSCRIPTION, name: "shared-name", tenantId: "tenant-a", isDefault: true },
              {
                id: OTHER_SUBSCRIPTION,
                name: "shared-name",
                tenantId: "tenant-b",
                isDefault: false,
              },
            ]),
            stderr: "",
            exitCode: 0,
          }),
        );

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand("ad user list");
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.message).toContain("ambiguous");
        expect(observed).toHaveLength(1);
      }),
    );

    it.effect("refuses when the tenant lookup fails or returns something unexpected", () =>
      Effect.gen(function* () {
        for (const accountList of [
          { stdout: "", stderr: "ERROR: not logged in", exitCode: 1 },
          { stdout: "not json", stderr: "", exitCode: 0 },
          { stdout: '[{"id":1}]', stderr: "", exitCode: 0 },
        ]) {
          const observed: string[][] = [];
          const layer = createServiceLayer(
            configWith({ default: { subscription: SUBSCRIPTION } }),
            observed,
            respondWith(accountList),
          );

          const result = yield* Effect.gen(function* () {
            const az = yield* AzService;
            return yield* az.runCommand(
              "monitor app-insights events show --app web -g rg --type requests",
            );
          }).pipe(Effect.result, Effect.provide(layer));

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) expect(result.failure._tag).toBe("AzSecurityError");
          expect(observed).toHaveLength(1);
        }
      }),
    );

    it.effect("leaves subscription-scoped commands without a tenant lookup", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(entraConfig, observed);

        yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand(
            `monitor metrics list-definitions --resource /subscriptions/${SUBSCRIPTION}/resourceGroups/rg/providers/p/t/n`,
          );
        }).pipe(Effect.provide(layer));

        expect(observed).toHaveLength(1);
      }),
    );
  });

  describe("Log Analytics workspace scope", () => {
    const WORKSPACE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const workspaceList: SpawnResult = {
      stdout: JSON.stringify([{ customerId: WORKSPACE, resourceGroup: "rg-logs" }]),
      stderr: "",
      exitCode: 0,
    };
    const respond = (args: readonly string[]): SpawnResult =>
      args.slice(0, 4).join(" ") === "monitor log-analytics workspace list" ? workspaceList : OK;

    const query = (workspace: string) =>
      `monitor log-analytics query -w ${workspace} --analytics-query "Heartbeat | take 1"`;

    it.effect("runs a query against a workspace of the pinned subscription", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ default: { subscription: SUBSCRIPTION } }),
          observed,
          respond,
        );

        yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand(query(WORKSPACE.toUpperCase()));
        }).pipe(Effect.provide(layer));

        expect(observed).toHaveLength(2);
        const lookup = observed[0] ?? [];
        expect(lookup[lookup.indexOf("--subscription") + 1]).toBe(SUBSCRIPTION);
        expect(observed[1]).toContain("Heartbeat | take 1");
      }),
    );

    it.effect("refuses a workspace the pinned subscription does not hold", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ default: { subscription: SUBSCRIPTION } }),
          observed,
          respond,
        );

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand(query("11111111-0000-0000-0000-000000000000"));
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("AzSecurityError");
        expect(observed).toHaveLength(1);
      }),
    );

    it.effect("refuses a workspace in a resource group outside the allowlist", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({
            default: { subscription: SUBSCRIPTION, allowedResourceGroups: ["rg-web"] },
          }),
          observed,
          respond,
        );

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand(query(WORKSPACE));
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.message).toContain("rg-logs");
        expect(observed).toHaveLength(1);
      }),
    );

    it.effect("refuses when the workspace listing fails", () =>
      Effect.gen(function* () {
        const observed: string[][] = [];
        const layer = createServiceLayer(
          configWith({ default: { subscription: SUBSCRIPTION } }),
          observed,
          { stdout: "", stderr: "ERROR: boom", exitCode: 1 },
        );

        const result = yield* Effect.gen(function* () {
          const az = yield* AzService;
          return yield* az.runCommand(query(WORKSPACE));
        }).pipe(Effect.result, Effect.provide(layer));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe("AzSecurityError");
        expect(observed).toHaveLength(1);
      }),
    );
  });
});
