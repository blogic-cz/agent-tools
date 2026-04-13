import { Database, constants } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Cause, Context, Effect, Layer } from "effect";

import { loadConfig } from "#config";

const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const IN_MEMORY_DB_PATH = ":memory:";

export type AuditLogEntry = {
  id: number;
  ts: string;
  tool: string;
  project: string;
  args: string;
  duration: number;
  success: boolean;
  error: string | null;
  exitCode: number | null;
};

export type AuditRecord = {
  tool: string;
  project: string;
  args: string;
  duration: number;
  success: boolean;
  error?: string;
  exitCode?: number | null;
};

type AuditServiceShape = {
  readonly dbPath: string;
  readonly record: (entry: AuditRecord) => Effect.Effect<void, never, never>;
  readonly listRecent: (limit?: number) => Effect.Effect<readonly AuditLogEntry[], never, never>;
  readonly purgeOlderThanDays: (days: number) => Effect.Effect<number, never, never>;
};

type AuditServiceOptions = {
  readonly dbPath?: string;
  readonly retentionDays?: number;
};

type ResolvedAuditOptions = {
  dbPath: string;
  retentionDays: number;
};

type AuditRow = {
  id: number;
  ts: string;
  tool: string;
  project: string;
  args: string;
  duration: number;
  success: number;
  error: string | null;
  exit_code: number | null;
};

type TableInfoRow = {
  name: string;
};

export class AuditService extends Context.Service<AuditService, AuditServiceShape>()(
  "@agent-tools/AuditService",
) {}

export const resolveAuditDbPath = (): string => join(homedir(), ".agent-tools", "audit.sqlite");

const expandHomePath = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

const isInMemoryDatabase = (dbPath: string): boolean =>
  dbPath === "" || dbPath === IN_MEMORY_DB_PATH;

const toAuditEntry = (row: AuditRow): AuditLogEntry => ({
  id: row.id,
  ts: row.ts,
  tool: row.tool,
  project: row.project,
  args: row.args,
  duration: row.duration,
  success: row.success === 1,
  error: row.error,
  exitCode: row.exit_code,
});

const safeToolName = (tool: string): string => tool.trim() || "unknown";

const deriveToolNameFromArgv = (): string => {
  const executablePath = process.argv[1];
  if (!executablePath) {
    return "unknown";
  }

  const fileName = basename(executablePath, ".ts");
  return fileName.replace(/^agent-tools-/, "").replace(/-tool$/, "");
};

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") {
      return message;
    }
  }

  return String(error);
};

const formatCause = (cause: Cause.Cause<unknown>): string => {
  const firstFailure = cause.reasons.find(Cause.isFailReason);
  if (firstFailure !== undefined) {
    return formatUnknownError(firstFailure.error);
  }

  const firstDefect = cause.reasons.find(Cause.isDieReason);
  if (firstDefect !== undefined) {
    return formatUnknownError(firstDefect.defect);
  }

  if (Cause.hasInterruptsOnly(cause)) {
    return "Interrupted";
  }

  return "Unknown error";
};

const extractExitCode = (cause: Cause.Cause<unknown>): number | null => {
  const firstFailure = cause.reasons.find(Cause.isFailReason);
  if (
    firstFailure === undefined ||
    typeof firstFailure.error !== "object" ||
    firstFailure.error === null
  ) {
    return null;
  }

  const exitCode = Reflect.get(firstFailure.error, "exitCode");
  return typeof exitCode === "number" ? exitCode : null;
};

const createTableSql = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    tool TEXT NOT NULL,
    project TEXT NOT NULL,
    args TEXT NOT NULL,
    duration INTEGER NOT NULL,
    success INTEGER NOT NULL,
    error TEXT,
    exit_code INTEGER
  ) STRICT
`;

const initializeDatabase = (db: Database, retentionDays: number): void => {
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run("PRAGMA busy_timeout=5000");
  db.run(createTableSql);
  const columns = db.query<TableInfoRow, []>("PRAGMA table_info(audit_log)").all();
  if (!columns.some((column) => column.name === "project")) {
    db.run("ALTER TABLE audit_log ADD COLUMN project TEXT");
  }
  db.run("UPDATE audit_log SET project = '' WHERE project IS NULL");
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_log_tool_ts ON audit_log(tool, ts DESC)");
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_log_project_ts ON audit_log(project, ts DESC)");
  db.run("DELETE FROM audit_log WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)", [
    `-${retentionDays} days`,
  ]);
};

const openDatabase = (dbPath: string, retentionDays: number): Database => {
  if (!isInMemoryDatabase(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath, { create: true, strict: true });
  initializeDatabase(db, retentionDays);

  if (!isInMemoryDatabase(dbPath)) {
    try {
      db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
    } catch {
      return db;
    }
  }

  return db;
};

const resolveAuditOptions = (options: AuditServiceOptions): Effect.Effect<ResolvedAuditOptions> =>
  Effect.tryPromise({
    try: () => loadConfig(),
    catch: () => undefined,
  }).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.map((config) => ({
      dbPath: expandHomePath(options.dbPath ?? config?.audit?.dbPath ?? resolveAuditDbPath()),
      retentionDays:
        options.retentionDays ?? config?.audit?.retentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    })),
  );

const createAuditService = (dbPath: string, db: Database | null): AuditServiceShape => ({
  dbPath,
  record: (entry) =>
    db === null
      ? Effect.void
      : Effect.sync(() => {
          db.run(
            "INSERT INTO audit_log (tool, project, args, duration, success, error, exit_code) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
              safeToolName(entry.tool),
              entry.project,
              entry.args,
              entry.duration,
              entry.success ? 1 : 0,
              entry.error ?? null,
              entry.exitCode ?? null,
            ],
          );
        }),
  listRecent: (limit = 20) =>
    db === null
      ? Effect.succeed([])
      : Effect.sync(() => {
          const rows = db
            .query<AuditRow, [number]>(
              "SELECT id, ts, tool, project, args, duration, success, error, exit_code FROM audit_log ORDER BY id DESC LIMIT ?",
            )
            .all(limit);
          return rows.map(toAuditEntry);
        }),
  purgeOlderThanDays: (days) =>
    db === null
      ? Effect.succeed(0)
      : Effect.sync(() => {
          const result = db.run(
            "DELETE FROM audit_log WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)",
            [`-${days} days`],
          );
          return result.changes;
        }),
});

export const makeAuditServiceLayer = (options: AuditServiceOptions = {}) => {
  return Layer.effect(
    AuditService,
    Effect.flatMap(resolveAuditOptions(options), ({ dbPath, retentionDays }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          try {
            return openDatabase(dbPath, retentionDays);
          } catch {
            return null;
          }
        }),
        (db) =>
          db === null
            ? Effect.void
            : Effect.sync(() => {
                db.close(false);
              }).pipe(Effect.ignore),
      ).pipe(Effect.map((db) => createAuditService(dbPath, db))),
    ),
  );
};

export const AuditServiceLayer = makeAuditServiceLayer();

const safelyRecord = (entry: AuditRecord) =>
  Effect.gen(function* () {
    const audit = yield* AuditService;
    yield* audit.record(entry);
  }).pipe(Effect.ignore);

export const withAudit = <A, E, R>(
  toolName: string,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | AuditService> =>
  Effect.suspend(() => {
    const startedAt = Date.now();
    const project = process.cwd();
    const args = process.argv.slice(2).join(" ");
    const tool = safeToolName(toolName || deriveToolNameFromArgv());

    return Effect.matchCauseEffect(program, {
      onFailure: (cause) =>
        Effect.flatMap(
          safelyRecord({
            tool,
            project,
            args,
            duration: Date.now() - startedAt,
            success: false,
            error: formatCause(cause),
            exitCode: extractExitCode(cause),
          }),
          () => Effect.failCause(cause),
        ),
      onSuccess: (value) =>
        Effect.flatMap(
          safelyRecord({
            tool,
            project,
            args,
            duration: Date.now() - startedAt,
            success: true,
          }),
          () => Effect.succeed(value),
        ),
    });
  });
