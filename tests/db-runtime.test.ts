import { stubBun } from "./helpers/stub-bun";
import { afterEach, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService } from "#config";
import type { DatabaseConfig } from "#config";
import { DbConfigService } from "#db/config-service";
import { DbGuardianInProcess, DbService } from "#db/service";
import { DbSqlClient, type DbConnection } from "#db/sql-client";
import { SecretEnvResolver } from "#shared/secret-env";
import { processResultLayer } from "./helpers/process-result";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const connection: DbConnection = {
  host: "127.0.0.1",
  port: 15432,
  user: "test",
  database: "testdb",
  password: "",
  readOnly: true,
};
it("db-tool applies the PostgreSQL read-only startup setting and reads rows", async () => {
  const configurations: unknown[] = [];
  const queries: string[] = [];
  const close = vi.fn<() => Promise<void>>(async () => undefined);
  stubBun(
    Object.assign(Object.create(Bun), {
      SQL: class {
        constructor(options: unknown) {
          configurations.push(options);
        }
        unsafe(sql: string) {
          queries.push(sql);
          return Promise.resolve(
            sql === "SHOW transaction_read_only"
              ? [{ transaction_read_only: "on" }]
              : [{ value: 1 }],
          );
        }
        close = close;
      },
    }),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DbSqlClient;
      return yield* sql.run(connection, "SELECT 1");
    }).pipe(Effect.provide(DbSqlClient.layer)),
  );
  expect(configurations).toEqual([
    {
      hostname: "127.0.0.1",
      port: 15432,
      username: "test",
      database: "testdb",
      password: "",
      max: 1,
      connection: { default_transaction_read_only: "on" },
    },
  ]);
  expect(queries).toEqual(["SHOW transaction_read_only", "SELECT 1"]);
  expect(result).toEqual({ rows: [{ value: 1 }], rowCount: 1, command: "" });
  expect(close).toHaveBeenCalledOnce();
});
it("db-tool preserves mutation rowCount and command from the SQL driver", async () => {
  stubBun(
    Object.assign(Object.create(Bun), {
      SQL: class {
        unsafe() {
          return Promise.resolve(Object.assign([], { count: 2, command: "INSERT" }));
        }
        close() {
          return Promise.resolve();
        }
      },
    }),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* DbSqlClient;
      return yield* sql.run(
        { ...connection, readOnly: false },
        "INSERT INTO ticker VALUES (1), (2)",
      );
    }).pipe(Effect.provide(DbSqlClient.layer)),
  );
  expect(result.rows).toHaveLength(0);
  expect(result.rowCount).toBe(2);
  expect(result.command).toBe("INSERT");
});
for (const [name, settings] of [
  ["db-tool opens a tunnel to the default PostgreSQL service", {}],
  ["db-tool opens a tunnel to a configured service", { service: "database" }],
  [
    "db-tool passes configured kubeconfig to kubectl tunnel",
    { service: "database", kubeconfig: "/tmp/unit-kubeconfig" },
  ],
] as const) {
  it(`${name}`, async () => {
    vi.stubEnv("UNIT_KUBECONFIG", "/tmp/unit-kubeconfig");
    stubBun(
      Object.assign(Object.create(Bun), {
        connect: () => Promise.resolve({ end: () => undefined }),
      }),
    );
    const commands: string[][] = [];
    const config: DatabaseConfig = {
      kubectl: { context: "test", namespace: "test-ns", ...settings },
      environments: { test: { host: "127.0.0.1", port: 15432, user: "test", database: "testdb" } },
    };
    const layer = DbService.layer.pipe(
      Layer.provide(
        processResultLayer((args) => {
          commands.push([...args]);
          return { stdout: "ok", stderr: "", exitCode: 0 };
        }),
      ),
      Layer.provide(Layer.succeed(ConfigService, {})),
      Layer.provide(Layer.succeed(DbConfigService, config)),
      Layer.provide(
        SecretEnvResolver.testLayer(async (name) =>
          name === "UNIT_KUBECONFIG"
            ? { _tag: "found", value: "/tmp/unit-kubeconfig" }
            : { _tag: "absent" },
        ),
      ),
      Layer.provide(
        Layer.succeed(DbSqlClient, {
          run: () => Effect.succeed({ rows: [{ value: 1 }], rowCount: 1, command: "SELECT" }),
        }),
      ),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService;
        return yield* db.executeQuery("test", "SELECT 1");
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toMatchObject({ success: true, data: [{ value: 1 }] });
    const tunnel = commands.find((args) => args.includes("port-forward"));
    expect(tunnel).toContain(`svc/${"service" in settings ? settings.service : "postgresql"}`);
    if ("kubeconfig" in settings)
      expect(tunnel?.slice(0, 2)).toEqual(["--kubeconfig", "/tmp/unit-kubeconfig"]);
  });
}
it("db-tool starts VPN prerequisites when direct database access fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "db-vpn-unit-"));
  roots.push(root);
  vi.stubEnv("AGENT_TOOLS_RUNTIME_DIR", root);
  stubBun(
    Object.assign(Object.create(Bun), { connect: () => Promise.resolve({ end: () => undefined }) }),
  );
  let connected = false;
  const commands: string[][] = [];
  const runner = processResultLayer((args) => {
    commands.push([...args]);
    if (args.includes("get"))
      return { stdout: "", stderr: connected ? "" : "offline", exitCode: connected ? 0 : 1 };
    if (args.includes("port-forward")) return { stdout: "", stderr: "", exitCode: 0 };
    if (args.includes("status") || args.includes("--active") || args.length === 0)
      return {
        stdout:
          process.platform === "darwin"
            ? connected
              ? "Connected\n"
              : "Disconnected\n"
            : process.platform === "linux"
              ? connected
                ? "ExampleVPN\n"
                : ""
              : connected
                ? "Connected to\nExampleVPN\nCommand completed successfully.\n"
                : "No connections\nCommand completed successfully.\n",
        stderr: "",
        exitCode: 0,
      };
    connected = !(args.includes("stop") || args.includes("down") || args.includes("/disconnect"));
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  const layer = DbService.layer.pipe(
    Layer.provide(Layer.succeed(DbGuardianInProcess, true)),
    Layer.provide(runner),
    Layer.provide(
      Layer.succeed(ConfigService, { vpns: { work: { name: "ExampleVPN", idleDisconnectMs: 0 } } }),
    ),
    Layer.provide(
      Layer.succeed(DbConfigService, {
        vpn: "work",
        kubectl: { context: "test", namespace: "test-ns" },
        environments: {
          test: { host: "127.0.0.1", port: 15432, user: "test", database: "testdb" },
        },
      }),
    ),
    Layer.provide(SecretEnvResolver.testLayer(async () => ({ _tag: "absent" }))),
    Layer.provide(
      Layer.succeed(DbSqlClient, {
        run: () => Effect.succeed({ rows: [{ value: 1 }], rowCount: 1, command: "SELECT" }),
      }),
    ),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* DbService;
      return yield* db.executeQuery("test", "SELECT 1");
    }).pipe(Effect.provide(layer)),
  );
  expect(result).toMatchObject({ success: true, data: [{ value: 1 }] });
  expect(commands.filter((args) => args.includes("get"))).toHaveLength(2);
  expect(commands.some((args) => args.includes("port-forward"))).toBe(true);
});
