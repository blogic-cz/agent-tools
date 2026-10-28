import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { AuditService, makeAuditServiceLayer, resolveAuditDbPath, withAudit } from "#shared/audit";

const roots: string[] = [];
const directory = async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-tools-audit-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("AuditService", () => {
  it("records and lists audit entries", async () => {
    const dbPath = join(await directory(), "audit.sqlite");
    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const audit = yield* AuditService;
        yield* audit.record({
          tool: "gh",
          project: "/tmp/project-a",
          args: "pr status --format json",
          duration: 15,
          success: true,
        });
        return yield* audit.listRecent();
      }).pipe(Effect.provide(makeAuditServiceLayer({ dbPath }))),
    );
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
  });

  it("purges entries older than the requested number of days", async () => {
    const dbPath = join(await directory(), "audit.sqlite");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const audit = yield* AuditService;
        yield* audit.record({
          tool: "session",
          project: "/tmp/project-b",
          args: "list",
          duration: 8,
          success: true,
        });
        const db = new Database(dbPath);
        try {
          db.run(
            "INSERT INTO audit_log (ts, tool, project, args, duration, success) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-120 days'), ?, ?, ?, ?, ?)",
            ["old", "/tmp/old-project", "old command", 1, 1],
          );
          const removed = yield* audit.purgeOlderThanDays(90);
          return {
            removed,
            remaining: db
              .query("SELECT count(*) AS count FROM audit_log WHERE tool = ?")
              .get("old"),
          };
        } finally {
          db.close();
        }
      }).pipe(Effect.provide(makeAuditServiceLayer({ dbPath, retentionDays: 3650 }))),
    );
    expect(result.removed).toBe(1);
    expect(result.remaining).toEqual({ count: 0 });
  });

  it("withAudit records successful executions", async () => {
    const dbPath = join(await directory(), "audit.sqlite");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const value = yield* withAudit("gh", Effect.succeed("ok"));
        const audit = yield* AuditService;
        return { value, entries: yield* audit.listRecent() };
      }).pipe(Effect.provide(makeAuditServiceLayer({ dbPath }))),
    );
    expect(result.value).toBe("ok");
    expect(result.entries[0]).toMatchObject({ tool: "gh", success: true });
    expect(typeof result.entries[0]?.project).toBe("string");
  });

  it("redacts rejected arguments and errors before audit persistence and on legacy reads", async () => {
    const dbPath = join(await directory(), "audit.sqlite");
    const token = `ghp_${"A".repeat(36)}`;
    vi.stubGlobal(
      "process",
      Object.assign(Object.create(process), { argv: [process.argv[0], "synthetic-cli", token] }),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const audit = yield* AuditService;
        yield* withAudit("gh", Effect.fail(new Error("Rejected " + token))).pipe(
          Effect.catch(() => Effect.void),
        );
        const db = new Database(dbPath);
        try {
          db.run(
            "INSERT INTO audit_log (tool, project, args, duration, success, error, exit_code) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ["old", "/tmp/" + token, "old " + token, 1, 0, "legacy " + token, 1],
          );
          return {
            raw: db.query("SELECT tool, project, args, error FROM audit_log ORDER BY id").all(),
            entries: yield* audit.listRecent(),
          };
        } finally {
          db.close();
        }
      }).pipe(Effect.provide(makeAuditServiceLayer({ dbPath }))),
    );
    expect(JSON.stringify(result.raw[0])).not.toContain(token);
    expect(JSON.stringify(result.raw[1])).toContain(token);
    expect(JSON.stringify(result.entries)).not.toContain(token);
    expect(result.entries[0]?.error).toContain("[REDACTED]");
    expect(result.entries[0]?.args).toContain("[REDACTED]");
    expect(result.entries[0]?.project).toContain("[REDACTED]");
    expect(result.entries[1]?.error).toContain("[REDACTED]");
    expect(result.entries[1]?.args).toContain("[REDACTED]");
  });

  it("audit layer failures never change program behavior", async () => {
    const root = await directory();
    const file = join(root, "file");
    await writeFile(file, "not a directory");
    const layer = makeAuditServiceLayer({ dbPath: join(file, "audit.sqlite") });
    expect(
      await Effect.runPromise(withAudit("gh", Effect.succeed("ok")).pipe(Effect.provide(layer))),
    ).toBe("ok");
    await expect(
      Effect.runPromise(
        withAudit("gh", Effect.fail(new Error("boom"))).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("boom");
  });

  it("reads dbPath and retentionDays from agent-tools.json5", async () => {
    const root = await directory();
    const dbPath = join(root, "audit-store", "custom.sqlite");
    await writeFile(
      join(root, "agent-tools.json5"),
      JSON.stringify({ audit: { retentionDays: 14, dbPath } }),
    );
    const previous = process.cwd();
    process.chdir(root);
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const value = yield* withAudit("audit", Effect.succeed("ok"));
          const audit = yield* AuditService;
          return { value, dbPath: audit.dbPath, entries: yield* audit.listRecent() };
        }).pipe(Effect.provide(makeAuditServiceLayer())),
      );
      expect(result.dbPath).toBe(dbPath);
      expect(result.dbPath).not.toBe(resolveAuditDbPath());
      await access(dbPath);
      expect(result.entries[0]).toMatchObject({ tool: "audit" });
    } finally {
      process.chdir(previous);
    }
  });
});
