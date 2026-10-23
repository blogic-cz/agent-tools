import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";

import type { AzurePlatformConfig } from "#config/types";

import type { AzParseError } from "./errors";

import { AzCommandError, AzProfileError, AzSecurityError, AzTimeoutError } from "./errors";
import { isProductionProfile, selectAzProfileName } from "./profile";
import { equalsIgnoreCase, isAzCommandAllowed } from "./security";
import { ConfigService, getToolConfig } from "#config";
import { missingBinaryFromSpawnFailure } from "#shared/binary-preflight";
import { renderCommandLine } from "#shared/exec";
import { unsafeOutboundTextReason } from "#shared/content-security";

const DEFAULT_TIMEOUT_MS = 60000;

const AccountsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    tenantId: Schema.String,
    isDefault: Schema.Boolean,
  }),
);

const WorkspacesSchema = Schema.Array(
  Schema.Struct({ customerId: Schema.String, resourceGroup: Schema.String }),
);

/** The command a run-time guard protects, with the profile it runs under. */
type GuardedCommand = {
  readonly command: string;
  readonly azConfig: AzurePlatformConfig;
  readonly timeoutMs: number;
};

const hasOutputFlag = (argv: readonly string[]): boolean =>
  argv.some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output="));

export type AzCommandResult = {
  readonly command: string;
  readonly subscription: string | undefined;
  readonly data: unknown;
};

export class AzService extends Context.Service<
  AzService,
  {
    readonly runCommand: (
      cmd: string,
      profile?: string,
    ) => Effect.Effect<
      AzCommandResult,
      AzSecurityError | AzCommandError | AzTimeoutError | AzParseError | AzProfileError
    >;
    readonly renderCommand: (
      cmd: string,
      profile?: string,
    ) => Effect.Effect<string, AzSecurityError | AzCommandError | AzProfileError>;
  }
>()("@agent-tools/AzService") {
  static readonly layer = Layer.effect(
    AzService,
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const executor = yield* ChildProcessSpawner.ChildProcessSpawner;

      const resolveConfig = (profile?: string) =>
        Effect.gen(function* () {
          const azConfig = getToolConfig<AzurePlatformConfig>(config, "azurePlatform", profile);

          if (!azConfig) {
            return yield* new AzCommandError({
              message:
                "No Azure platform configuration found. Add an 'azurePlatform' section to agent-tools.json5.",
              command: "unknown",
              exitCode: -1,
              hint: "azurePlatform pins the subscription every command runs against, so it is required.",
              nextCommand:
                "echo '{ azurePlatform: { default: { subscription: \"<subscription-id>\" } } }' > agent-tools.json5",
            });
          }

          // A production subscription must be named, never inherited from
          // auto-selection or the "default" key.
          const profileName = selectAzProfileName(config?.azurePlatform, profile);
          if (!profile && isProductionProfile(profileName, azConfig)) {
            const label = profileName ?? "default";
            return yield* new AzProfileError({
              message: `Implicit production access blocked. Profile '${label}' is a production profile but --profile was not passed explicitly.`,
              profile: label,
              hint: `Pass --profile ${label} explicitly to confirm production access, or set production: false on that profile.`,
              nextCommand: `agent-tools-az cmd --profile ${label} --cmd "group list"`,
            });
          }

          return azConfig;
        });

      /** Security gate plus profile scoping. Shared by dry-run rendering and execution. */
      const buildArgv = (cmd: string, profile?: string) =>
        Effect.gen(function* () {
          const azConfig = yield* resolveConfig(profile);
          const securityCheck = isAzCommandAllowed(cmd, {
            allowedResourceGroups: azConfig.allowedResourceGroups,
            allowEntra: azConfig.allowEntra,
            allowTenantScope: azConfig.allowTenantScope,
            subscription: azConfig.subscription,
          });

          if (!securityCheck.allowed || !securityCheck.argv) {
            return yield* new AzSecurityError({
              message: securityCheck.reason ?? "Command not allowed",
              command: cmd,
              hint:
                securityCheck.hint ??
                "Only read-only Azure platform commands are allowed. Use azdo-tool for Azure DevOps.",
            });
          }

          const unsafeReason = unsafeOutboundTextReason(securityCheck.argv.join(" "));
          if (unsafeReason !== null) {
            return yield* new AzSecurityError({
              message: `Refusing to send command containing ${unsafeReason}.`,
              command: "[redacted]",
            });
          }

          const argv = [...securityCheck.argv, "--only-show-errors"];

          if (!hasOutputFlag(securityCheck.argv)) {
            argv.push("--output", "json");
          }

          if (!securityCheck.omitsSubscription) {
            argv.push("--subscription", azConfig.subscription);
          }

          return { argv, azConfig, securityCheck };
        });

      const spawnAz = (argv: readonly string[], timeoutMs: number, renderedCommand: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const command = ChildProcess.make("az", argv, {
              stdout: "pipe",
              stderr: "pipe",
            });
            const process = yield* executor.spawn(command);

            const stdoutChunk = yield* process.stdout.pipe(Stream.decodeText(), Stream.runCollect);
            const stderrChunk = yield* process.stderr.pipe(Stream.decodeText(), Stream.runCollect);
            const exitCode = yield* process.exitCode;

            return { stdout: stdoutChunk.join(""), stderr: stderrChunk.join(""), exitCode };
          }),
        ).pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.mapError((platformError) => {
            const missing = missingBinaryFromSpawnFailure("az", String(platformError));
            return new AzCommandError({
              message: `Command execution failed: ${String(platformError)}`,
              command: renderedCommand,
              exitCode: -1,
              stderr: String(platformError),
              hint: missing?.hint ?? "Check that the az CLI is installed and authenticated",
              nextCommand: "az login",
              retryable: true,
            });
          }),
        );

      /** A read a guard depends on. Any failure refuses: the guarded fact stays unknown. */
      const guardLookup = <T>(
        argv: readonly string[],
        decode: (json: unknown) => T,
        guarded: GuardedCommand,
        refusal: string,
      ) =>
        Effect.gen(function* () {
          const lookupArgv = [...argv, "--only-show-errors", "--output", "json"];
          const lookupCommand = renderCommandLine(["az", ...lookupArgv]);
          const refuse = new AzSecurityError({
            message: refusal,
            command: guarded.command,
            hint: `The check '${lookupCommand}' could not run, so the command is refused. Check the az login and retry.`,
            retryable: true,
          });

          const result = yield* spawnAz(lookupArgv, guarded.timeoutMs, lookupCommand).pipe(
            Effect.mapError(() => refuse),
          );
          if (Option.isNone(result) || result.value.exitCode !== 0) return yield* refuse;

          const stdout = result.value.stdout;
          return yield* Effect.try({
            try: () => decode(JSON.parse(stdout)),
            catch: () => refuse,
          });
        });

      /**
       * Entra and App Insights data commands authenticate against the default
       * az login, whatever --subscription says, so they would silently read
       * another tenant's directory or fail with InvalidTokenError.
       */
      const ensureDefaultTenant = (guarded: GuardedCommand) =>
        Effect.gen(function* () {
          const { azConfig } = guarded;
          const accounts = yield* guardLookup(
            [
              "account",
              "list",
              "--query",
              "[].{id:id,name:name,tenantId:tenantId,isDefault:isDefault}",
            ],
            Schema.decodeUnknownSync(AccountsSchema),
            guarded,
            "Could not confirm that the default az login is in the tenant of the pinned subscription.",
          );
          // A name may match subscriptions in several tenants, so only a unique match counts.
          const matches = accounts.filter(
            (account) =>
              equalsIgnoreCase(account.id, azConfig.subscription) ||
              equalsIgnoreCase(account.name, azConfig.subscription),
          );
          if (matches.length > 1) {
            return yield* new AzSecurityError({
              message: `Subscription name '${azConfig.subscription}' matches ${matches.length} subscriptions, so its tenant is ambiguous.`,
              command: guarded.command,
              hint: "Pin the profile by subscription ID instead of name.",
            });
          }
          const [pinned] = matches;
          const current = accounts.find((account) => account.isDefault);

          if (!pinned || !current || !equalsIgnoreCase(pinned.tenantId, current.tenantId)) {
            return yield* new AzSecurityError({
              message: `This command reads the tenant of the default az login (${current?.tenantId ?? "unknown"}), not the tenant of subscription ${azConfig.subscription} (${pinned?.tenantId ?? "unknown"}).`,
              command: guarded.command,
              hint: `Ask the user to run 'az account set --subscription ${azConfig.subscription}', or use a profile whose subscription is in the default tenant.`,
            });
          }
        });

      /** A workspace GUID is not scoped by --subscription, so it must belong to the pinned subscription. */
      const ensureWorkspacesInScope = (workspaces: readonly string[], guarded: GuardedCommand) =>
        Effect.gen(function* () {
          const { azConfig } = guarded;
          const known = yield* guardLookup(
            [
              "monitor",
              "log-analytics",
              "workspace",
              "list",
              "--subscription",
              azConfig.subscription,
              "--query",
              "[].{customerId:customerId,resourceGroup:resourceGroup}",
            ],
            Schema.decodeUnknownSync(WorkspacesSchema),
            guarded,
            "Could not list the Log Analytics workspaces of the pinned subscription.",
          );
          const allowedGroups = azConfig.allowedResourceGroups ?? [];

          for (const workspace of workspaces) {
            const match = known.find((entry) => equalsIgnoreCase(entry.customerId, workspace));
            if (!match) {
              return yield* new AzSecurityError({
                message: `Workspace '${workspace}' is not a Log Analytics workspace in subscription ${azConfig.subscription}.`,
                command: guarded.command,
                hint: 'Pass the workspace customer ID from: monitor log-analytics workspace list --query "[].{name:name,id:customerId}"',
              });
            }
            if (
              allowedGroups.length > 0 &&
              !allowedGroups.some((group) => equalsIgnoreCase(group, match.resourceGroup))
            ) {
              return yield* new AzSecurityError({
                message: `Workspace '${workspace}' is in resource group '${match.resourceGroup}', which this profile does not allow.`,
                command: guarded.command,
                hint: `Allowed resource groups: ${allowedGroups.join(", ")}.`,
              });
            }
          }
        });

      const renderCommand = Effect.fn("AzService.renderCommand")(function* (
        cmd: string,
        profile?: string,
      ) {
        const { argv } = yield* buildArgv(cmd, profile);
        return renderCommandLine(["az", ...argv]);
      });

      const runCommand = Effect.fn("AzService.runCommand")(function* (
        cmd: string,
        profile?: string,
      ) {
        const { argv, azConfig, securityCheck } = yield* buildArgv(cmd, profile);
        const timeoutMs = azConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const fullCommand = renderCommandLine(["az", ...argv]);

        const guarded: GuardedCommand = { command: fullCommand, azConfig, timeoutMs };
        if (securityCheck.usesDefaultLoginTenant) {
          yield* ensureDefaultTenant(guarded);
        }
        if (securityCheck.workspaces) {
          yield* ensureWorkspacesInScope(securityCheck.workspaces, guarded);
        }

        const resultOption = yield* spawnAz(argv, timeoutMs, fullCommand);

        if (Option.isNone(resultOption)) {
          return yield* new AzTimeoutError({
            message: `Command timed out after ${timeoutMs}ms`,
            command: fullCommand,
            timeoutMs,
            retryable: true,
            hint: "The command took too long. Retry or increase timeoutMs in azurePlatform config.",
          });
        }

        const result = resultOption.value;

        if (result.exitCode !== 0) {
          return yield* new AzCommandError({
            message: result.stderr || `Command failed with exit code ${result.exitCode}`,
            command: fullCommand,
            exitCode: result.exitCode,
            ...(result.stderr ? { stderr: result.stderr } : {}),
          });
        }

        const output = result.stdout.trim();

        if (output.length === 0) {
          return {
            command: fullCommand,
            subscription: azConfig.subscription,
            data: null,
          } satisfies AzCommandResult;
        }

        // --output json is injected unless the caller picked a format, so non-JSON
        // output here is a deliberate table/tsv request and is passed through as text.
        const parsed = ((): unknown => {
          try {
            return JSON.parse(output) as unknown;
          } catch {
            return output;
          }
        })();

        return {
          command: fullCommand,
          subscription: azConfig.subscription,
          data: parsed,
        } satisfies AzCommandResult;
      });

      return { runCommand, renderCommand };
    }),
  );
}

export const AzServiceLayer = AzService.layer;
