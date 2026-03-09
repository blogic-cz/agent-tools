import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const PROJECT_ROOT = join(__dirname, "..");

const createTempDir = (name: string): string => mkdtempSync(join(tmpdir(), `agent-tools-${name}-`));

const removeTempDir = (path: string): void => {
  rmSync(path, { recursive: true, force: true });
};

const runBunScript = (script: string, env: Record<string, string> = {}) =>
  spawnSync("bun", ["-e", script], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });

describe("AuditService", () => {
  it("records and lists audit entries", () => {
    const tempDir = createTempDir("audit-record");
    const dbPath = join(tempDir, "audit.sqlite");

    try {
      const result = runBunScript(
        `
import { Effect } from "effect";
import { AuditService, makeAuditServiceLayer } from "./src/shared/audit.ts";

const dbPath = process.env.DB_PATH;

const program = Effect.gen(function* () {
          const audit = yield* AuditService;
          yield* audit.record({ tool: "gh", project: "/tmp/project-a", args: "pr status --format json", duration: 15, success: true });
          const entries = yield* audit.listRecent();
          return entries;
}).pipe(Effect.provide(makeAuditServiceLayer({ dbPath })));

const entries = await Effect.runPromise(program);
console.log(JSON.stringify(entries));
        `.trim(),
        { DB_PATH: dbPath },
      );

      expect(result.status).toBe(0);
      const entries = JSON.parse(result.stdout.trim()) as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        tool: "gh",
        project: "/tmp/project-a",
        args: "pr status --format json",
        duration: 15,
        success: true,
        error: null,
        exitCode: null,
      });
    } finally {
      removeTempDir(tempDir);
    }
  });

  it("purges entries older than the requested number of days", () => {
    const tempDir = createTempDir("audit-purge");
    const dbPath = join(tempDir, "audit.sqlite");

    try {
      const result = runBunScript(
        `
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { AuditService, makeAuditServiceLayer } from "./src/shared/audit.ts";

const dbPath = process.env.DB_PATH;

await Effect.runPromise(
  Effect.gen(function* () {
    const audit = yield* AuditService;
    yield* audit.record({ tool: "session", project: "/tmp/project-b", args: "list", duration: 8, success: true });
  }).pipe(Effect.provide(makeAuditServiceLayer({ dbPath, retentionDays: 3650 }))),
);

const db = new Database(dbPath, { strict: true });
db.run(
  "INSERT INTO audit_log (ts, tool, project, args, duration, success, error, exit_code) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-120 days'), ?, ?, ?, ?, ?, ?, ?)",
  ["old", "/tmp/old-project", "old command", 1, 1, null, null],
);
db.close(false);

const removed = await Effect.runPromise(
  Effect.gen(function* () {
  const audit = yield* AuditService;
  return yield* audit.purgeOlderThanDays(90);
  }).pipe(Effect.provide(makeAuditServiceLayer({ dbPath, retentionDays: 3650 }))),
);

      const verifyDb = new Database(dbPath, { strict: true });
const remaining = verifyDb.query("SELECT count(*) AS count FROM audit_log WHERE tool = ?").get("old");
verifyDb.close(false);

console.log(JSON.stringify({ removed, remaining }));
        `.trim(),
        { DB_PATH: dbPath },
      );

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as {
        removed: number;
        remaining?: { count?: number };
      };
      expect(parsed.removed).toBeGreaterThanOrEqual(1);
      expect(parsed.remaining?.count ?? 0).toBe(0);
    } finally {
      removeTempDir(tempDir);
    }
  });

  it("withAudit records successful executions", () => {
    const tempDir = createTempDir("audit-wrapper-success");
    const dbPath = join(tempDir, "audit.sqlite");

    try {
      const result = runBunScript(
        `
import { Effect } from "effect";
import { AuditService, makeAuditServiceLayer, withAudit } from "./src/shared/audit.ts";

const dbPath = process.env.DB_PATH;

const program = Effect.gen(function* () {
  const value = yield* withAudit("gh", Effect.succeed("ok"));
  const audit = yield* AuditService;
  const entries = yield* audit.listRecent();
  return { value, entries };
}).pipe(Effect.provide(makeAuditServiceLayer({ dbPath })));

console.log(JSON.stringify(await Effect.runPromise(program)));
        `.trim(),
        { DB_PATH: dbPath },
      );

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as {
        value: string;
        entries: Array<Record<string, unknown>>;
      };
      expect(parsed.value).toBe("ok");
      expect(parsed.entries[0]).toMatchObject({ tool: "gh", success: true });
      expect(typeof parsed.entries[0]?.project).toBe("string");
    } finally {
      removeTempDir(tempDir);
    }
  });

  it("audit layer failures never change program behavior", () => {
    const result = runBunScript(
      `
import { Effect } from "effect";
import { makeAuditServiceLayer, withAudit } from "./src/shared/audit.ts";

const dbPath = "/dev/null/audit.sqlite";
const successValue = await Effect.runPromise(
  withAudit("gh", Effect.succeed("ok")).pipe(Effect.provide(makeAuditServiceLayer({ dbPath }))),
);

let errorMessage = "";
try {
  await Effect.runPromise(
    withAudit("gh", Effect.fail(new Error("boom"))).pipe(Effect.provide(makeAuditServiceLayer({ dbPath }))),
  );
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
}

console.log(JSON.stringify({ successValue, errorMessage }));
      `.trim(),
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      successValue: string;
      errorMessage: string;
    };
    expect(parsed.successValue).toBe("ok");
    expect(parsed.errorMessage).toBe("boom");
  });

  it("reads dbPath and retentionDays from agent-tools.json5", () => {
    const tempDir = createTempDir("audit-config");
    const auditDir = join(tempDir, "audit-store");
    const dbPath = join(auditDir, "custom.sqlite");

    try {
      writeFileSync(
        join(tempDir, "agent-tools.json5"),
        JSON.stringify({
          audit: {
            retentionDays: 14,
            dbPath,
          },
        }),
      );

      const auditModulePath = JSON.stringify(join(PROJECT_ROOT, "src/shared/audit.ts"));

      const result = runBunScript(
        `
import { existsSync } from "node:fs";
import { Effect } from "effect";
import { AuditService, withAudit, resolveAuditDbPath, makeAuditServiceLayer } from ${auditModulePath};

process.chdir(${JSON.stringify(tempDir)});

const program = Effect.gen(function* () {
  const value = yield* withAudit("audit", Effect.succeed("ok"));
  const audit = yield* AuditService;
  const entries = yield* audit.listRecent();
  return { value, dbPath: audit.dbPath, defaultPath: resolveAuditDbPath(), exists: existsSync(audit.dbPath), entries };
}).pipe(Effect.provide(makeAuditServiceLayer()));

console.log(JSON.stringify(await Effect.runPromise(program)));
        `.trim(),
      );

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as {
        dbPath: string;
        defaultPath: string;
        exists: boolean;
        entries: Array<Record<string, unknown>>;
      };
      expect(parsed.dbPath).toBe(dbPath);
      expect(parsed.dbPath).not.toBe(parsed.defaultPath);
      expect(parsed.exists).toBe(true);
      expect(parsed.entries[0]).toMatchObject({ tool: "audit" });
    } finally {
      removeTempDir(tempDir);
    }
  });
});
