import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Clock, Context, Duration, Effect, Layer, Ref, Stream } from "effect";

import type { DbConfig, DbMutationOperation, QueryResult, SchemaMode } from "./types";

import { ConfigService } from "#config";
import { isPrerequisiteRunError } from "#shared/prerequisites/errors";
import { resolveEnvTemplate } from "#shared/env-template";
import { runWithProfilePrerequisites } from "#shared/prerequisites/runtime";
import { DbConfigService, DbConfigServiceLayer, TUNNEL_CHECK_INTERVAL_MS } from "./config-service";
import {
  DbConnectionError,
  DbMutationBlockedError,
  DbParseError,
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

export class DbService extends Context.Service<
  DbService,
  {
    readonly executeQuery: (env: string, sql: string) => Effect.Effect<QueryResult, DbError>;
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
            executeQuery: (env: string, _sql: string) => Effect.fail(noConfigError(env)),
            executeSchemaQuery: (env: string, _mode: SchemaMode, _table?: string) =>
              Effect.fail(noConfigError(env)),
          };
        }

        const kubectlKubeconfig = dbConfig.kubectl?.kubeconfig;
        const kubectlContext = dbConfig.kubectl?.context;
        const kubectlNamespace = dbConfig.kubectl?.namespace;
        const kubectlService = dbConfig.kubectl?.service ?? "postgresql";
        const tunnelTimeoutMs = dbConfig.tunnelTimeoutMs ?? 5000;
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
                  stderr: undefined,
                }),
            ),
          );

        const checkPortOpen = (port: number) =>
          executeShellCommand(
            ChildProcess.make("nc", ["-z", "localhost", String(port)], {
              stdout: "pipe",
              stderr: "pipe",
            }),
          );

        const runWithVpnPrerequisites = <E>(
          port: number,
          effect: Effect.Effect<QueryResult, E>,
        ): Effect.Effect<QueryResult, E | DbTunnelError> =>
          runWithProfilePrerequisites(
            agentToolsConfig ?? {},
            dbConfig,
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

              const result = yield* checkPortOpen(port).pipe(
                Effect.catch(() => Effect.succeed({ exitCode: 1 })),
              );

              if (result.exitCode === 0) {
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

        const buildPsqlCommand = (
          config: DbConfig,
          sql: string,
          password: string,
          useTuplesOnly: boolean,
        ) => {
          const args = [
            "-h",
            config.host,
            "-p",
            String(config.port),
            "-U",
            config.user,
            "-d",
            config.database,
          ];

          const commandArgs = useTuplesOnly
            ? [...args, "-t", "-A", "-c", sql]
            : [...args, "-c", sql];

          return ChildProcess.make("psql", commandArgs, {
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              ...(password ? { PGPASSWORD: password } : {}),
            } as Record<string, string>,
          });
        };

        const fetchTableNamesForError = Effect.fn("DbService.fetchTableNamesForError")(function* (
          config: DbConfig,
          password: string,
        ) {
          const command = buildPsqlCommand(
            config,
            `SELECT schemaname || '.' || tablename FROM pg_tables WHERE schemaname NOT IN (${SYSTEM_SCHEMAS_SQL}) ORDER BY schemaname, tablename;`,
            password,
            true,
          );
          const result = yield* executeShellCommand(command).pipe(
            Effect.catch(() =>
              Effect.succeed({
                stdout: "",
                stderr: "",
                exitCode: 1,
              }),
            ),
          );
          if (result.exitCode !== 0) {
            return [] as string[];
          }

          return result.stdout
            .trim()
            .split("\n")
            .filter((name) => name.length > 0);
        });

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

          const command = buildPsqlCommand(
            config,
            `SELECT column_name FROM information_schema.columns WHERE table_name = '${escapedTableName}' ${schemaFilter} ORDER BY table_schema, ordinal_position;`,
            password,
            true,
          );
          const result = yield* executeShellCommand(command).pipe(
            Effect.catch(() =>
              Effect.succeed({
                stdout: "",
                stderr: "",
                exitCode: 1,
              }),
            ),
          );
          if (result.exitCode !== 0) {
            return [] as string[];
          }

          return result.stdout
            .trim()
            .split("\n")
            .filter((name) => name.length > 0);
        });

        const executeSelectQuery = Effect.fn("DbService.executeSelectQuery")(function* (
          config: DbConfig,
          sql: string,
          password: string,
          startTimeMs: number,
          applyTransform = false,
        ) {
          const wrappedSql = `SELECT json_agg(t) FROM (${sql}) t;`;
          const command = buildPsqlCommand(config, wrappedSql, password, true);
          const result = yield* executeShellCommand(command);
          const endTime = yield* Clock.currentTimeMillis;

          if (result.exitCode !== 0) {
            const schemaError = detectSchemaError(result.stderr, sql);
            const baseResult: QueryResult = {
              success: false,
              error: result.stderr.trim() || `psql exited with code ${result.exitCode}`,
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

            return yield* new DbQueryError({
              message: baseResult.error ?? "Query failed",
              sql,
              stderr: result.stderr.trim() || undefined,
            });
          }

          const trimmedOutput = result.stdout.trim();
          if (!trimmedOutput || trimmedOutput === "null") {
            return {
              success: true,
              data: [],
              rowCount: 0,
              executionTimeMs: Number(endTime) - startTimeMs,
            };
          }

          const rawData = yield* Effect.try({
            try: () => JSON.parse(trimmedOutput) as Record<string, unknown>[],
            catch: () =>
              new DbParseError({
                message: "Failed to parse query result as JSON.",
                rawOutput: trimmedOutput.slice(0, 500),
              }),
          });

          const transformed = applyTransform
            ? transformQueryResult(rawData)
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
          const command = buildPsqlCommand(config, sql, password, false);
          const result = yield* executeShellCommand(command);
          const endTime = yield* Clock.currentTimeMillis;

          if (result.exitCode !== 0) {
            return yield* new DbQueryError({
              message: result.stderr.trim() || `psql exited with code ${result.exitCode}`,
              sql,
              stderr: result.stderr.trim() || undefined,
            });
          }

          const output = result.stdout.trim();
          const rowCountMatch = output.match(/(?:UPDATE|DELETE|INSERT \d+)\s+(\d+)/i);
          const rowCount = rowCountMatch ? parseInt(rowCountMatch[1], 10) : 0;

          return {
            success: true,
            message: output,
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

        const getConfigForEnv = (env: string): DbConfig => {
          const envConfig = dbConfig.environments[env];
          if (!envConfig) {
            const available = Object.keys(dbConfig.environments).join(", ");
            throw new Error(`Unknown environment "${env}". Available: ${available}`);
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
            port: envConfig.port,
            needsTunnel: accessMode.needsTunnel,
            allowMutations: accessMode.allowMutations,
            allowedMutations: accessMode.allowedMutations,
          };
        };

        const executeQuery = Effect.fn("DbService.executeQuery")(function* (
          env: string,
          sql: string,
        ) {
          const config = getConfigForEnv(env);
          const startTimeMs = yield* Clock.currentTimeMillis;
          const resolvedConfig = yield* resolveDbConfig(config, env);
          const password = yield* resolvePassword(resolvedConfig, env);
          const mutation = isMutationQuery(sql);
          const mutationOperation = mutation ? getAllowedMutationOperation(sql) : undefined;
          const mutationAllowed =
            !mutation ||
            resolvedConfig.allowMutations ||
            (mutationOperation !== undefined &&
              resolvedConfig.allowedMutations.includes(mutationOperation));

          if (!mutationAllowed) {
            const allowed =
              resolvedConfig.allowedMutations.length > 0
                ? resolvedConfig.allowedMutations.join(", ")
                : "none";
            return yield* new DbMutationBlockedError({
              message: `Mutation queries are not allowed on environment ${env}. Allowed mutation operations: ${allowed}.`,
              environment: env,
              hint: 'Configure database.<profile>.allowedMutations.<env> with explicit operations such as ["insert"] if this environment should allow controlled mutations.',
            });
          }

          const queryEffect = mutation
            ? executeMutationQuery(resolvedConfig, sql, password, Number(startTimeMs))
            : executeSelectQuery(resolvedConfig, sql, password, Number(startTimeMs), true);

          return yield* runWithVpnPrerequisites(
            resolvedConfig.port,
            runQueryWithOptionalTunnel(resolvedConfig, queryEffect),
          );
        });

        const executeSchemaQuery = Effect.fn("DbService.executeSchemaQuery")(function* (
          env: string,
          mode: SchemaMode,
          table?: string,
        ) {
          const config = getConfigForEnv(env);
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

export const DbServiceLayer = DbService.layer.pipe(Layer.provide(DbConfigServiceLayer));
