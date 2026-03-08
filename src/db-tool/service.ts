import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Clock, Duration, Effect, Layer, Ref, ServiceMap, Stream } from "effect";

import type { DbConfig, QueryResult, SchemaMode } from "./types";

import { DbConfigService, DbConfigServiceLayer, TUNNEL_CHECK_INTERVAL_MS } from "./config-service";
import {
  DbConnectionError,
  DbMutationBlockedError,
  DbParseError,
  DbQueryError,
  DbTunnelError,
  type DbError,
} from "./errors";
import { getColumns, getRelationships, getTableNames } from "./schema";
import { detectSchemaError, isValidTableName, isMutationQuery } from "./security";

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function resolveDbAccessMode(
  env: string,
  host: string,
  hasKubectlConfig: boolean,
): Pick<DbConfig, "allowMutations" | "host" | "needsTunnel"> {
  const isLocalHost = LOCALHOST_HOSTS.has(host);
  const isLocalEnvironment = env === "local";

  return {
    host,
    needsTunnel: hasKubectlConfig && !isLocalEnvironment && isLocalHost,
    allowMutations: isLocalEnvironment,
  };
}

export class DbService extends ServiceMap.Service<
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

        const kubectlContext = dbConfig.kubectl?.context;
        const kubectlNamespace = dbConfig.kubectl?.namespace;
        const tunnelTimeoutMs = dbConfig.tunnelTimeoutMs ?? 5000;
        const remotePort = dbConfig.remotePort ?? 5432;

        const zshrcEnvCache = yield* Ref.make<Record<string, string> | null>(null);

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

            const proc = yield* executor.spawn(
              ChildProcess.make(
                "kubectl",
                [
                  "port-forward",
                  "--context",
                  kubectlContext,
                  "--namespace",
                  kubectlNamespace,
                  "svc/postgresql",
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
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;",
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

          const escapedTableName = tableName.replaceAll("'", "''");

          const command = buildPsqlCommand(
            config,
            `SELECT column_name FROM information_schema.columns WHERE table_name = '${escapedTableName}' AND table_schema = 'public' ORDER BY ordinal_position;`,
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

          const data = yield* Effect.try({
            try: () => JSON.parse(trimmedOutput) as Record<string, unknown>[],
            catch: () =>
              new DbParseError({
                message: "Failed to parse query result as JSON.",
                rawOutput: trimmedOutput.slice(0, 500),
              }),
          });

          return {
            success: true,
            data,
            rowCount: data.length,
            executionTimeMs: Number(endTime) - startTimeMs,
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
            name: string;
          }[];
          const fullSchema: Record<string, unknown>[] = [];

          for (const table of tables) {
            const columnsResult = yield* executeSelectQuery(
              config,
              getColumns(table.name),
              password,
              startTimeMs,
            ).pipe(Effect.catch(() => Effect.succeed(null)));

            if (columnsResult && columnsResult.success && columnsResult.data) {
              fullSchema.push({
                table: table.name,
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
          };
        };

        const executeQuery = Effect.fn("DbService.executeQuery")(function* (
          env: string,
          sql: string,
        ) {
          const config = getConfigForEnv(env);
          const startTimeMs = yield* Clock.currentTimeMillis;
          const password = yield* resolvePassword(config, env);
          const mutation = isMutationQuery(sql);

          if (mutation && !config.allowMutations) {
            return yield* new DbMutationBlockedError({
              message:
                "Mutation queries (UPDATE, INSERT, DELETE, etc.) are not allowed on this environment. Use a local environment for mutations.",
              environment: env,
            });
          }

          const queryEffect = mutation
            ? executeMutationQuery(config, sql, password, Number(startTimeMs))
            : executeSelectQuery(config, sql, password, Number(startTimeMs));

          return yield* runQueryWithOptionalTunnel(config, queryEffect);
        });

        const executeSchemaQuery = Effect.fn("DbService.executeSchemaQuery")(function* (
          env: string,
          mode: SchemaMode,
          table?: string,
        ) {
          const config = getConfigForEnv(env);
          const startTimeMs = yield* Clock.currentTimeMillis;
          const password = yield* resolvePassword(config, env);

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
                  "Invalid table name. Use only letters, numbers, and underscores, and start with a letter or underscore.",
                executionTimeMs: Number(endTime) - Number(startTimeMs),
              };
            }
          }

          const queryEffect =
            mode === "tables"
              ? executeSelectQuery(config, getTableNames(), password, Number(startTimeMs))
              : mode === "columns"
                ? executeSelectQuery(config, getColumns(table ?? ""), password, Number(startTimeMs))
                : mode === "relationships"
                  ? executeSelectQuery(config, getRelationships(), password, Number(startTimeMs))
                  : executeFullSchemaQuery(config, password, Number(startTimeMs));

          const result = yield* runQueryWithOptionalTunnel(config, queryEffect);

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
