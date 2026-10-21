import { Database } from "bun:sqlite";

import { redactSensitiveText } from "#shared/content-security";
import type { RequestEvent, RequestRow, TelemetryStore } from "./telemetry";

const telemetryCommand = (args: readonly string[]): string => {
  const commandGroups = new Set([
    "pr",
    "issue",
    "repo",
    "label",
    "branch",
    "workflow",
    "release",
    "gist",
    "cache",
  ]);
  const pathLength = commandGroups.has(args[0]) ? 2 : 1;
  const path = args.slice(0, pathLength).filter((arg) => !arg.startsWith("-"));
  if (path.join(" ") === "pr stack" && args[2] && !args[2].startsWith("-")) {
    path.push(args[2]);
  }
  const flags: string[] = [];

  for (const arg of args.slice(path.length)) {
    if (arg === "--") break;
    if (arg.startsWith("-")) flags.push(arg.split("=", 1)[0]);
  }

  return [...path, ...flags.toSorted()].join(" ");
};

export const openRequestTelemetry = (dbPath: string): TelemetryStore => {
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout=0");
    db.run(`CREATE TABLE IF NOT EXISTS github_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, invocation TEXT NOT NULL,
      command TEXT NOT NULL, method TEXT NOT NULL, endpoint TEXT NOT NULL,
      status INTEGER, outcome TEXT NOT NULL, resource TEXT, used INTEGER,
      remaining INTEGER, reset INTEGER
    ) STRICT`);
    db.run("CREATE INDEX IF NOT EXISTS idx_github_requests_ts ON github_requests(ts)");
    db.run(
      "DELETE FROM github_requests WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')",
    );
  } catch (error) {
    db.close(false);
    throw error;
  }
  const invocation = crypto.randomUUID();
  const command = telemetryCommand(process.argv.slice(2));
  return {
    record: (event: RequestEvent) => {
      try {
        db.run(
          `INSERT INTO github_requests
          (ts, invocation, command, method, endpoint, status, outcome, resource, used, remaining, reset)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            event.ts,
            invocation,
            redactSensitiveText(command),
            event.method,
            event.endpoint,
            event.status,
            event.outcome,
            event.resource,
            event.used,
            event.remaining,
            event.reset,
          ],
        );
      } catch {
        /* Never wait for a writer or change command behavior. */
      }
    },
    read: (since) =>
      db
        .query<RequestRow, [string]>("SELECT * FROM github_requests WHERE ts >= ? ORDER BY ts, id")
        .all(since)
        .map((row) => Object.assign(row, { command: redactSensitiveText(row.command) })),
    close: () => db.close(false),
  };
};
