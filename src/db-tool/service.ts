import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Clock, Context, Duration, Effect, Layer, Ref, Result, Stream } from "effect";

import type { DbConfig, DbMutationOperation, QueryResult, SchemaMode } from "./types";

import { ConfigService } from "#config";
import { isPrerequisiteRunError } from "#shared/prerequisites/errors";
import { resolveEnvTemplate } from "#shared/env-template";
import { resolveEnvironmentScopedPrerequisites } from "#shared/prerequisites/config";
import { runWithProfilePrerequisites } from "#shared/prerequisites/runtime";
import { buildApiProbeArgs } from "#shared/k8s-probe";
import { DbConfigService, TUNNEL_CHECK_INTERVAL_MS } from "./config-service";
import { DbSqlClient, type DbConnection } from "./sql-client";
import {
  DbConnectionError,
  DbMutationBlockedError,
  DbQueryError,
  DbTunnelError,
  type DbError,
} from "./errors";
import {
  getColumns,
  getRelationships,
  getTableNames,
  parseTableReference,
  SYSTEM_SCHEMAS_SQL,
} from "./schema";
import {
  detectSchemaError,
  getAllowedMutationOperation,
  getMutationTarget,
  hasMultipleStatements,
  isValidTableName,
  isMutationQuery,
} from "./security";
import { transformQueryResult } from "./transformers";

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function resolveDbAccessMode(
  env: string,
  host: string,
  hasKubectlConfig: boolean,
  allowedMutations: readonly DbMutationOperation[] = [],
): Pick<DbConfig, "allowMutations" | "allowedMutations" | "host" | "needsTunnel"> {
  const isLocalHost = LOCALHOST_HOSTS.has(host);
  const isLocalEnvironment = env === "local";

  return {
    host,
    needsTunnel: hasKubectlConfig && !isLocalEnvironment && isLocalHost,
    allowMutations: isLocalEnvironment,
    allowedMutations: isLocalEnvironment ? ["insert", "update", "delete"] : allowedMutations,
  };
}

export function isFullyReadOnly(
  config: Pick<DbConfig, "allowMutations" | "allowedMutations" | "allowedMutationTargets">,
): boolean {
  return (
    !config.allowMutations &&
    config.allowedMutations.length === 0 &&
    Object.keys(config.allowedMutationTargets).length === 0
  );
}

// Re-exported from the shared probe so existing `#db/service` consumers keep working.
export { buildApiProbeArgs } from "#shared/k8s-probe";

export class DbService extends Context.Service<
  DbService,
  {
    readonly executeQuery: (
      env: string,
      sql: string,
      limit?: number,
    ) => Effect.Effect<QueryResult, DbError>;
    readonly executeSchemaQuery: (
      env: string,
      mode: SchemaMode,
      table?: string,
    ) => Effect.Effect<QueryResult, DbError>;
  }
>()("@agent-tools/DbService") {
  static readonly layer = Layer.effect(
    DbService,
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* ChildProcessSpawner.ChildProcessSpawner;
        const sqlClient = yield* DbSqlClient;
        const agentToolsConfig = yield* ConfigService;
        const dbConfig = yield* DbConfigService;

        if (!dbConfig) {
          const noConfigError = (env: string) =>
            new DbConnectionError({
              message:
                "No database configuration found. Add a 'database' section to agent-tools.json5.",
              environment: env,
            });
          return {
            executeQuery: (env: string, _sql: string, _limit?: number) =>
              Effect.fail(noConfigError(env)),
            executeSchemaQuery: (env: string, _mode: SchemaMode, _table?: string) =>
              Effect.fail(noConfigError(env)),
          };
        }

        const kubectlKubeconfig = dbConfig.kubectl?.kubeconfig;
        const kubectlContext = dbConfig.kubectl?.context;
        const kubectlNamespace = dbConfig.kubectl?.namespace;
        const kubectlService = dbConfig.kubectl?.service ?? "postgresql";
        const tunnelTimeoutMs = dbConfig.tunnelTimeoutMs ?? 5000;
        const apiProbeTimeoutMs = dbConfig.apiProbeTimeoutMs ?? 2000;
        const remotePort = dbConfig.remotePort ?? 5432;

        const zshrcEnvCache = yield* Ref.make<Record<string, string> | null>(null);
        const envTemplateRegex = /^\$\{([A-Za-z0-9_]+)\}$/;

        const loadEnvFromZshrc = Effect.fn("DbService.loadEnvFromZshrc")(function* () {
          const cached = yield* Ref.get(zshrcEnvCache);
          if (cached !== null) {
            return cached;
          }

          const home = process.env.HOME;
          if (!home || home.trim() === "") {
            yield* Ref.set(zshrcEnvCache, {});
            return {};
          }

          const zshrcPath = `${home}/.zshrc`;
          const content = yield* Effect.tryPromise(async () => {
            const file = Bun.file(zshrcPath);
            if (!(await file.exists())) {
              return "";
            }
            return await file.text();
          }).pipe(Effect.orElseSucceed(() => ""));

          const envVars: Record<string, string> = {};
          const regex = /^export\s+([A-Z_][A-Z0-9_]*)=["']?([^"'\n]+)["']?/gm;
          let match = regex.exec(content);

          while (match !== null) {
            envVars[match[1]] = match[2];
            match = regex.exec(content);
          }

          yield* Ref.set(zshrcEnvCache, envVars);
          return envVars;
        });

        const resolvePassword = Effect.fn("DbService.resolvePassword")(function* (
          config: DbConfig,
          env: string,
        ) {
          if (config.password) {
            return config.password;
          }

          if (config.passwordEnvVar) {
            const fromEnv = process.env[config.passwordEnvVar];
            if (fromEnv) {
              return fromEnv;
            }

            const zshrcEnv = yield* loadEnvFromZshrc();
            const fromZsh = zshrcEnv[config.passwordEnvVar];
            if (fromZsh) {
              return fromZsh;
            }

            return yield* new DbConnectionError({
              message: `Environment variable ${config.passwordEnvVar} is not set.`,
              environment: env,
            });
          }

          // Local databases typically don't need a password
          return "";
        });

        const resolveConfigString = Effect.fn("DbService.resolveConfigString")(function* (
          value: string,
          env: string,
          label: string,
          zshrcEnv: Record<string, string>,
        ) {
          const match = value.match(envTemplateRegex);
          if (!match) return value;

          const envVar = match[1];
          const fromEnv = Bun.env[envVar];
          if (fromEnv !== undefined) return fromEnv;

          const fromZsh = zshrcEnv[envVar];
          if (fromZsh !== undefined) return fromZsh;

          return yield* new DbConnectionError({
            message: `Environment variable ${envVar} (required for '${label}' config field) is not set in environment ${env}.`,
            environment: env,
          });
        });

        const resolveDbConfig = Effect.fn("DbService.resolveDbConfig")(function* (
          config: DbConfig,
          env: string,
        ) {
          const needsEnvResolution =
            envTemplateRegex.test(config.user) || envTemplateRegex.test(config.database);
          const zshrcEnv = needsEnvResolution ? yield* loadEnvFromZshrc() : {};
          return {
            ...config,
            user: yield* resolveConfigString(config.user, env, "user", zshrcEnv),
            database: yield* resolveConfigString(config.database, env, "database", zshrcEnv),
          };
        });

        const executeShellCommand = (command: ChildProcess.Command) =>
          Effect.scoped(
            Effect.gen(function* () {
              const proc = yield* executor.spawn(command);

              const stdoutChunk = yield* proc.stdout.pipe(Stream.decodeText(), Stream.runCollect);
              const stderrChunk = yield* proc.stderr.pipe(Stream.decodeText(), Stream.runCollect);

              const stdout = stdoutChunk.join("");
              const stderr = stderrChunk.join("");
              const exitCode = yield* proc.exitCode;

              return { stdout, stderr, exitCode };
            }),
          ).pipe(
            Effect.mapError(
              (platformError) =>
                new DbQueryError({
                  message: `Command execution failed: ${String(platformError)}`,
                  sql: "shell command",
                  stderr: String(platformError),
                }),
            ),
          );

        const checkPortOpen = (port: number) =>
          Effect.tryPromise(async () => {
            const socket = await Bun.connect({
              hostname: "127.0.0.1",
              port,
              socket: { data: () => undefined },
            });
            socket.end();
            return true;
          }).pipe(
            Effect.timeout(TUNNEL_CHECK_INTERVAL_MS),
            Effect.orElseSucceed(() => false),
          );

        const runWithVpnPrerequisites = <E>(
          port: number,
          prerequisiteConfig: DbConfig,
          effect: Effect.Effect<QueryResult, E>,
        ): Effect.Effect<QueryResult, E | DbTunnelError> =>
          runWithProfilePrerequisites(
            agentToolsConfig ?? {},
            prerequisiteConfig,
            (command, _label) => executeShellCommand(command),
            effect,
            { tryWithoutPrerequisites: true },
          ).pipe(
            Effect.mapError((error) =>
              isPrerequisiteRunError(error)
                ? new DbTunnelError({
                    message: error.message,
                    port,
                    hint: error.hint,
                  })
                : error,
            ),
          );

        const waitForPort = (port: number, timeoutMs: number, intervalMs: number) =>
          Effect.gen(function* () {
            const startTime = yield* Clock.currentTimeMillis;
            const deadline = Number(startTime) + timeoutMs;

            while (true) {
              const now = yield* Clock.currentTimeMillis;
              if (Number(now) >= deadline) {
                return false;
              }

              if (yield* checkPortOpen(port)) {
                return true;
              }

              yield* Effect.sleep(Duration.millis(intervalMs));
            }
          });

        const resolveKubeconfig = Effect.fn("DbService.resolveKubeconfig")(function* (
          port: number,
        ) {
          if (!kubectlKubeconfig) {
            return undefined;
          }

          return yield* resolveEnvTemplate(kubectlKubeconfig).pipe(
            Effect.mapError(
              ({ envVar }) =>
                new DbTunnelError({
                  message: `Environment variable ${envVar} (required for kubeconfig) is not set.`,
                  port,
                }),
            ),
          );
        });

        const startTunnelProcess = (config: DbConfig) =>
          Effect.gen(function* () {
            if (!kubectlContext || !kubectlNamespace) {
              return yield* Effect.fail(
                new DbTunnelError({
                  message:
                    "kubectl context and namespace are required for tunneling. Add kubectl config to agent-tools.json5 database section.",
                  port: config.port,
                }),
              );
            }

            const kubeconfig = yield* resolveKubeconfig(config.port);
            const kubeconfigArgs = kubeconfig ? ["--kubeconfig", kubeconfig] : [];

            const proc = yield* executor.spawn(
              ChildProcess.make(
                "kubectl",
                [
                  ...kubeconfigArgs,
                  "port-forward",
                  "--context",
                  kubectlContext,
                  "--namespace",
                  kubectlNamespace,
                  `svc/${kubectlService}`,
                  `${config.port}:${remotePort}`,
                ],
                { stdout: "pipe", stderr: "pipe" },
              ),
            );

            return proc;
          });

        /**
         * Cheap pre-flight check: is the Kubernetes API server reachable right now?
         * Returns true when the probe is disabled (apiProbeTimeoutMs <= 0) or no context is
         * configured, so behaviour is unchanged unless a probe can meaningfully run. A false
         * result lets the direct (no-VPN) tunnel attempt bail fast and fall back to the VPN
         * prerequisite instead of waiting out tunnelTimeoutMs on a silently hanging port-forward.
         */
        const probeApiServerReachable = Effect.fn("DbService.probeApiServerReachable")(function* (
          config: DbConfig,
        ) {
          if (!kubectlContext || apiProbeTimeoutMs <= 0) {
            return true;
          }

          const kubeconfig = yield* resolveKubeconfig(config.port).pipe(
            Effect.orElseSucceed(() => undefined),
          );

          const result = yield* executeShellCommand(
            ChildProcess.make(
              "kubectl",
              buildApiProbeArgs(kubeconfig, kubectlContext, apiProbeTimeoutMs),
              { stdout: "pipe", stderr: "pipe" },
            ),
          ).pipe(Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })));

          return result.exitCode === 0;
        });

        const toConnection = (config: DbConfig, password: string): DbConnection => ({
          host: config.host,
          port: config.port,
          user: config.user,
          database: config.database,
          password,
          readOnly: isFullyReadOnly(config),
        });

        const runSql = (config: DbConfig, password: string, sql: string) =>
          sqlClient.run(toConnection(config, password), sql);

        const fetchSingleColumn = (config: DbConfig, password: string, sql: string) =>
          runSql(config, password, sql).pipe(
            Effect.map((outcome) =>
              outcome.rows
                .map((row) => String(Object.values(row)[0] ?? ""))
                .filter((value) => value.length > 0),
            ),
            Effect.orElseSucceed(() => [] as string[]),
          );

        const fetchTableNamesForError = (config: DbConfig, password: string) =>
          fetchSingleColumn(
            config,
            password,
            `SELECT schemaname || '.' || tablename FROM pg_tables WHERE schemaname NOT IN (${SYSTEM_SCHEMAS_SQL}) ORDER BY schemaname, tablename;`,
          );

        const fetchColumnNamesForError = Effect.fn("DbService.fetchColumnNamesForError")(function* (
          config: DbConfig,
          password: string,
          tableName: string,
        ) {
          if (!isValidTableName(tableName)) {
            return [] as string[];
          }

          const tableReference = parseTableReference(tableName);
          const escapedSchemaName = tableReference.schemaName?.replaceAll("'", "''");
          const escapedTableName = tableReference.tableName.replaceAll("'", "''");
          const schemaFilter = escapedSchemaName
            ? `AND table_schema = '${escapedSchemaName}'`
            : `AND table_schema NOT IN (${SYSTEM_SCHEMAS_SQL})`;

          return yield* fetchSingleColumn(
            config,
            password,
            `SELECT column_name FROM information_schema.columns WHERE table_name = '${escapedTableName}' ${schemaFilter} ORDER BY table_schema, ordinal_position;`,
          );
        });

        const psqlFailureFields = (result: { stderr: string; exitCode: number }) => {
          const stderr = result.stderr.trim();
          return stderr
            ? { message: stderr, stderr }
            : {
                message: `psql exited with code ${result.exitCode} without writing any error output.`,
                hint: PSQL_SILENT_FAILURE_HINT,
              };
        };

        const executeSelectQuery = Effect.fn("DbService.executeSelectQuery")(function* (
          config: DbConfig,
          sql: string,
          password: string,
          startTimeMs: number,
          applyTransform = false,
          limit?: number,
        ) {
          const selectSql = sql.trim().replace(/;\s*$/, "");
          const outcome = yield* Effect.result(runSql(config, password, selectSql));
          const endTime = yield* Clock.currentTimeMillis;

          if (Result.isFailure(outcome)) {
            const failureMessage = outcome.failure.message.trim();
            const schemaError = detectSchemaError(failureMessage, sql);
            const baseResult: QueryResult = {
              success: false,
              error: failureMessage || "Query failed",
              executionTimeMs: Number(endTime) - startTimeMs,
            };

            if (schemaError.type === "table_not_found") {
              const availableTables = yield* fetchTableNamesForError(config, password);
              return {
                ...baseResult,
                availableTables,
                hint: `Table "${schemaError.missingName}" not found. Use one of the availableTables listed above.`,
              };
            }

            if (schemaError.type === "column_not_found" && schemaError.tableName) {
              const availableColumns = yield* fetchColumnNamesForError(
                config,
                password,
                schemaError.tableName,
              );
              return {
                ...baseResult,
                availableColumns,
                hint: `Column "${schemaError.missingName}" not found in table "${schemaError.tableName}". Use one of the availableColumns listed above.`,
              };
            }

            return yield* outcome.failure;
          }

          const rawData = outcome.success.rows;
          const transformed = applyTransform
            ? transformQueryResult(rawData, limit)
            : {
                data: rawData,
                showing: rawData.length,
                truncated: false,
                total: rawData.length,
              };

          return {
            success: true,
            data: transformed.data,
            rowCount: transformed.showing,
            executionTimeMs: Number(endTime) - startTimeMs,
            ...(transformed.truncated ? { truncated: true, total: transformed.total } : {}),
          };
        });

        const executeMutationQuery = Effect.fn("DbService.executeMutationQuery")(function* (
          config: DbConfig,
          sql: string,
          password: string,
          startTimeMs: number,
        ) {
          const outcome = yield* runSql(config, password, sql);
          const endTime = yield* Clock.currentTimeMillis;
          const rowCount = outcome.rowCount;

          return {
            success: true,
            message: `${outcome.command} ${rowCount}`.trim(),
            rowCount,
            executionTimeMs: Number(endTime) - startTimeMs,
          };
        });

        const executeFullSchemaQuery = Effect.fn("DbService.executeFullSchemaQuery")(function* (
          config: DbConfig,
          password: string,
          startTimeMs: number,
        ) {
          const tablesResult = yield* executeSelectQuery(
            config,
            getTableNames(),
            password,
            startTimeMs,
          );

          if (!tablesResult.success || !tablesResult.data) {
            return tablesResult;
          }

          const tables = tablesResult.data as {
            schema?: string;
            name: string;
            qualified_name?: string;
          }[];
          const fullSchema: Record<string, unknown>[] = [];

          for (const table of tables) {
            const columnsResult = yield* executeSelectQuery(
              config,
              getColumns(table.qualified_name ?? table.name),
              password,
              startTimeMs,
            ).pipe(Effect.catch(() => Effect.succeed(null)));

            if (columnsResult && columnsResult.success && columnsResult.data) {
              fullSchema.push({
                schema: table.schema,
                table: table.name,
                qualified_name: table.qualified_name ?? table.name,
                columns: columnsResult.data,
              });
            }
          }

          const endTime = yield* Clock.currentTimeMillis;

          return {
            success: true,
            data: fullSchema,
            rowCount: fullSchema.length,
            message: `Full schema: ${fullSchema.length} tables`,
            executionTimeMs: Number(endTime) - startTimeMs,
          };
        });

        const runQueryWithOptionalTunnel = <E>(
          config: DbConfig,
          queryEffect: Effect.Effect<QueryResult, E>,
        ): Effect.Effect<QueryResult, E | DbTunnelError> => {
          if (!config.needsTunnel) {
            return queryEffect;
          }

          return Effect.scoped(
            Effect.gen(function* () {
              const reachable = yield* probeApiServerReachable(config);
              if (!reachable) {
                return yield* new DbTunnelError({
                  message: `Kubernetes API server not reachable within ${apiProbeTimeoutMs}ms; skipping tunnel attempt (VPN likely not connected and not on the office network).`,
                  port: config.port,
                });
              }

              const tunnelProc = yield* startTunnelProcess(config).pipe(
                Effect.mapError(
                  (platformError) =>
                    new DbTunnelError({
                      message: `Failed to start tunnel: ${String(platformError)}`,
                      port: config.port,
                    }),
                ),
              );

              const ready = yield* waitForPort(
                config.port,
                tunnelTimeoutMs,
                TUNNEL_CHECK_INTERVAL_MS,
              );

              if (!ready) {
                yield* tunnelProc.kill().pipe(Effect.ignore);
                return yield* new DbTunnelError({
                  message: "Tunnel failed to open within timeout.",
                  port: config.port,
                });
              }

              const result = yield* queryEffect.pipe(
                Effect.ensuring(tunnelProc.kill().pipe(Effect.ignore)),
              );

              return result;
            }),
          );
        };

        const getConfigForEnv = Effect.fn("DbService.getConfigForEnv")(function* (env: string) {
          const envConfig = dbConfig.environments[env];
          if (!envConfig) {
            const available = Object.keys(dbConfig.environments).join(", ");
            // Tagged failure (not a bare throw) so the hint + nextCommand reach the agent (M3).
            return yield* new DbConnectionError({
              message: `Unknown environment "${env}". Available: ${available}`,
              environment: env,
              hint: "List configured environments with: db-tool envs",
              nextCommand: "db-tool envs",
            });
          }

          const accessMode = resolveDbAccessMode(
            env,
            envConfig.host,
            dbConfig.kubectl !== undefined,
            dbConfig.allowedMutations?.[env] ?? [],
          );

          return {
            host: accessMode.host,
            user: envConfig.user,
            database: envConfig.database,
            password: envConfig.password,
            passwordEnvVar: envConfig.passwordEnvVar,
            ...resolveEnvironmentScopedPrerequisites(dbConfig, envConfig),
            port: envConfig.port,
            needsTunnel: accessMode.needsTunnel,
            allowMutations: accessMode.allowMutations,
            allowedMutations: accessMode.allowedMutations,
            allowedMutationTargets: dbConfig.allowedMutationTargets?.[env] ?? {},
          };
        });

        const executeQuery = Effect.fn("DbService.executeQuery")(function* (
          env: string,
          sql: string,
          limit?: number,
        ) {
          const config = yield* getConfigForEnv(env);
          const startTimeMs = yield* Clock.currentTimeMillis;
          const resolvedConfig = yield* resolveDbConfig(config, env);
          const password = yield* resolvePassword(resolvedConfig, env);
          if (hasMultipleStatements(sql)) {
            return yield* new DbQueryError({
              message:
                "Multiple SQL statements in a single call are not allowed; the mutation guard only inspects the first statement.",
              sql,
              hint: "Send one statement per call.",
            });
          }

          const mutation = isMutationQuery(sql);
          const mutationOperation = mutation ? getAllowedMutationOperation(sql) : undefined;
          const mutationTarget = mutation ? getMutationTarget(sql) : undefined;
          const mutationAllowed =
            !mutation ||
            resolvedConfig.allowMutations ||
            (mutationOperation !== undefined &&
              resolvedConfig.allowedMutations.includes(mutationOperation)) ||
            (mutationOperation !== undefined &&
              mutationTarget !== undefined &&
              (resolvedConfig.allowedMutationTargets[mutationOperation] ?? []).includes(
                mutationTarget,
              ));

          if (!mutationAllowed) {
            const allowed =
              resolvedConfig.allowedMutations.length > 0
                ? resolvedConfig.allowedMutations.join(", ")
                : "none";
            return yield* new DbMutationBlockedError({
              message: `Mutation queries are not allowed on environment ${env}. Allowed mutation operations: ${allowed}.`,
              environment: env,
              hint: 'Configure database.<profile>.allowedMutationTargets.<env> with explicit targets such as { insert: ["ticker.TimeTickers"] }, or allowedMutations.<env> for broader operation-level access.',
            });
          }

          const queryEffect = mutation
            ? executeMutationQuery(resolvedConfig, sql, password, Number(startTimeMs))
            : executeSelectQuery(resolvedConfig, sql, password, Number(startTimeMs), true, limit);

          return yield* runWithVpnPrerequisites(
            resolvedConfig.port,
            resolvedConfig,
            runQueryWithOptionalTunnel(resolvedConfig, queryEffect),
          );
        });

        const executeSchemaQuery = Effect.fn("DbService.executeSchemaQuery")(function* (
          env: string,
          mode: SchemaMode,
          table?: string,
        ) {
          const config = yield* getConfigForEnv(env);
          const startTimeMs = yield* Clock.currentTimeMillis;
          const resolvedConfig = yield* resolveDbConfig(config, env);
          const password = yield* resolvePassword(resolvedConfig, env);

          if (mode === "columns" && !table) {
            const endTime = yield* Clock.currentTimeMillis;
            return {
              success: false,
              error: "--schema columns requires --table <name>",
              executionTimeMs: Number(endTime) - Number(startTimeMs),
            };
          }

          if (mode === "columns" && table) {
            if (!isValidTableName(table)) {
              const endTime = yield* Clock.currentTimeMillis;
              return {
                success: false,
                error:
                  "Invalid table name. Use only letters, numbers, underscores, and an optional schema prefix, and start each identifier with a letter or underscore.",
                executionTimeMs: Number(endTime) - Number(startTimeMs),
              };
            }
          }

          const queryEffect =
            mode === "tables"
              ? executeSelectQuery(resolvedConfig, getTableNames(), password, Number(startTimeMs))
              : mode === "columns"
                ? executeSelectQuery(
                    resolvedConfig,
                    getColumns(table ?? ""),
                    password,
                    Number(startTimeMs),
                  )
                : mode === "relationships"
                  ? executeSelectQuery(
                      resolvedConfig,
                      getRelationships(),
                      password,
                      Number(startTimeMs),
                    )
                  : executeFullSchemaQuery(resolvedConfig, password, Number(startTimeMs));

          const result = yield* runWithVpnPrerequisites(
            resolvedConfig.port,
            resolvedConfig,
            runQueryWithOptionalTunnel(resolvedConfig, queryEffect),
          );

          if (result.success) {
            const descriptor =
              mode === "columns" && table
                ? `Schema introspection: ${mode} for table '${table}'`
                : `Schema introspection: ${mode}`;
            return {
              ...result,
              message: descriptor,
            };
          }

          return result;
        });

        return { executeQuery, executeSchemaQuery };
      }),
    ),
  );
}
