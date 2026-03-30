import { describe, expect, it } from "@effect/vitest";

import { transformLogOutput } from "#logs/transformers";

describe("transformLogOutput", () => {
  it("reorders JSON logs by severity and deduplicates repeated errors", () => {
    const jsonLogs = [
      '{"ts":"2024-01-01T10:00:00Z","level":"info","msg":"Starting server"}',
      '{"ts":"2024-01-01T10:00:01Z","level":"error","msg":"Connection refused","err":"ECONNREFUSED"}',
      '{"ts":"2024-01-01T10:00:02Z","level":"info","msg":"Retrying..."}',
      '{"ts":"2024-01-01T10:00:03Z","level":"warn","msg":"High memory usage"}',
      '{"ts":"2024-01-01T10:00:04Z","level":"error","msg":"Connection refused","err":"ECONNREFUSED"}',
    ].join("\n");

    expect(transformLogOutput(jsonLogs)).toBe(
      [
        "--- errors (2) ---",
        "[2024-01-01T10:00:01Z] [ERROR] Connection refused [×2]",
        "--- warnings (1) ---",
        "[2024-01-01T10:00:03Z] [WARN] High memory usage",
        "--- info (2) ---",
        "[2024-01-01T10:00:00Z] [INFO] Starting server",
        "[2024-01-01T10:00:02Z] [INFO] Retrying...",
      ].join("\n"),
    );
  });

  it("deduplicates plain text logs with timestamp normalization", () => {
    const textLogs = [
      "2024-01-01 10:00:00 ERROR Connection refused to database",
      "2024-01-01 10:00:01 ERROR Connection refused to database",
      "2024-01-01 10:00:02 ERROR Connection refused to database",
      "2024-01-01 10:00:03 INFO Server started",
      "2024-01-01 10:00:04 INFO Listening on port 3000",
    ].join("\n");

    expect(transformLogOutput(textLogs)).toBe(
      [
        "2024-01-01 10:00:00 ERROR Connection refused to database [×3]",
        "2024-01-01 10:00:03 INFO Server started",
        "2024-01-01 10:00:04 INFO Listening on port 3000",
      ].join("\n"),
    );
  });

  it("treats mixed malformed content as plain text", () => {
    const mixed = ["not json line", "{bad json}", "plain text"].join("\n");

    expect(transformLogOutput(mixed)).toBe(mixed);
  });

  it("returns empty string for empty input", () => {
    expect(transformLogOutput("")).toBe("");
  });

  it("keeps a single plain line unchanged", () => {
    expect(transformLogOutput("just one log line")).toBe("just one log line");
  });

  it("parses JSON logs with alternative field names", () => {
    const log = '{"time":"2024-01-01T00:00:00Z","severity":"WARNING","text":"disk almost full"}';

    expect(transformLogOutput(log)).toBe(
      ["--- warnings (1) ---", "[2024-01-01T00:00:00Z] [WARN] disk almost full"].join("\n"),
    );
  });
});
