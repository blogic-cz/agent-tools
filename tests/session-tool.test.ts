import { Effect } from "effect";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  encodeProjectPath,
  extractSessionTitle,
  extractTextFromContent,
  parseJsonlLine,
} from "#session/claude-code";
import {
  extractPiText,
  extractPiTitle,
  getPiSessionId,
  getPiSessions,
  parsePiLine,
  PI_SUMMARY_HEAD_MAX_BYTES,
  PI_SUMMARY_TAIL_MAX_BYTES,
  readPiMessages,
  readPiSessionMetadata,
} from "#session/pi";
import {
  projectSessionFilter,
  sessionSummariesFromMessages,
  sortSessionSummaries,
} from "#session/summaries";

describe("session-tool Claude Code helpers", () => {
  it("encodeProjectPath replaces slashes with dashes", () => {
    expect(encodeProjectPath("/Users/foo/bar")).toBe("-Users-foo-bar");
  });

  it("encodeProjectPath replaces Windows separators and drive colon with dashes", () => {
    expect(encodeProjectPath("C:\\Work\\SAB\\nexus")).toBe("C--Work-SAB-nexus");
  });

  it("encodeProjectPath handles mixed separators", () => {
    expect(encodeProjectPath("C:/Work/SAB/nexus")).toBe("C--Work-SAB-nexus");
  });

  it("parseJsonlLine parses user record", () => {
    const line = JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T10:00:00.000Z",
      uuid: "11111111-1111-4111-8111-111111111111",
      message: {
        role: "user",
        content: "hello from user",
      },
    });

    expect(parseJsonlLine(line)).toEqual({
      type: "user",
      timestamp: "2026-01-01T10:00:00.000Z",
      uuid: "11111111-1111-4111-8111-111111111111",
      message: {
        role: "user",
        content: "hello from user",
      },
    });
  });

  it("parseJsonlLine parses assistant record", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-01-01T10:00:01.000Z",
      uuid: "22222222-2222-4222-8222-222222222222",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello from assistant" }],
      },
    });

    expect(parseJsonlLine(line)).toEqual({
      type: "assistant",
      timestamp: "2026-01-01T10:00:01.000Z",
      uuid: "22222222-2222-4222-8222-222222222222",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello from assistant" }],
      },
    });
  });

  it("parseJsonlLine parses summary record", () => {
    const line = JSON.stringify({
      type: "summary",
      summary: "My Claude session title",
    });

    expect(parseJsonlLine(line)).toEqual({
      type: "summary",
      summary: "My Claude session title",
    });
  });

  it("parseJsonlLine returns null for system records", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
    });

    expect(parseJsonlLine(line)).toBeNull();
  });

  it("extractTextFromContent keeps string content as-is", () => {
    expect(extractTextFromContent("simple user message")).toBe("simple user message");
  });

  it("extractTextFromContent keeps only text blocks", () => {
    const content = [
      { type: "text", text: "first line" },
      { type: "thinking", thinking: "private chain of thought" },
      { type: "tool_use", id: "tool-1", name: "bash", input: { command: "pwd" } },
      { type: "text", text: "second line" },
      { type: "tool_result", tool_use_id: "tool-1", content: "output" },
    ] as const;

    expect(extractTextFromContent(content)).toBe("first line\nsecond line");
  });

  it("extractSessionTitle uses summary when present", () => {
    const records = [
      { type: "summary", summary: "Summary title" },
      {
        type: "user",
        timestamp: "2026-01-01T10:00:00.000Z",
        uuid: "11111111-1111-4111-8111-111111111111",
        message: { role: "user", content: "fallback user text" },
      },
    ] as const;

    expect(extractSessionTitle(records)).toBe("Summary title");
  });

  it("extractSessionTitle falls back to first user message", () => {
    const longMessage = "a".repeat(150);
    const records = [
      {
        type: "assistant",
        timestamp: "2026-01-01T10:00:01.000Z",
        uuid: "22222222-2222-4222-8222-222222222222",
        message: { role: "assistant", content: [{ type: "text", text: "assistant text" }] },
      },
      {
        type: "user",
        timestamp: "2026-01-01T10:00:00.000Z",
        uuid: "11111111-1111-4111-8111-111111111111",
        message: { role: "user", content: longMessage },
      },
    ] as const;

    expect(extractSessionTitle(records)).toBe("a".repeat(100));
  });
});

describe("session-tool pi helpers", () => {
  it("parsePiLine parses session record", () => {
    const line = JSON.stringify({
      type: "session",
      version: 3,
      id: "019f6625-1f54-7588-83dc-6eed11fc7ec0",
      timestamp: "2026-07-15T14:18:56.724Z",
      cwd: "/Users/foo/project",
    });

    expect(parsePiLine(line)).toEqual({
      type: "session",
      id: "019f6625-1f54-7588-83dc-6eed11fc7ec0",
      timestamp: "2026-07-15T14:18:56.724Z",
      cwd: "/Users/foo/project",
    });
  });

  it("parsePiLine parses message record", () => {
    const line = JSON.stringify({
      type: "message",
      id: "5f3f9406",
      parentId: "b1eda0a8",
      timestamp: "2026-07-15T14:18:57.552Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });

    expect(parsePiLine(line)).toEqual({
      type: "message",
      id: "5f3f9406",
      parentId: "b1eda0a8",
      timestamp: "2026-07-15T14:18:57.552Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
  });

  it("parsePiLine returns null for non-session/message records", () => {
    expect(parsePiLine(JSON.stringify({ type: "model_change", provider: "x" }))).toBeNull();
    expect(parsePiLine("not json")).toBeNull();
  });

  it("extractPiText keeps only text blocks", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "reasoning", summary: "hidden" },
      { type: "tool_use", id: "t1", name: "bash" },
      { type: "text", text: "second" },
    ];

    expect(extractPiText(content)).toBe("first\nsecond");
    expect(extractPiText("plain string")).toBe("plain string");
  });

  it("extractPiTitle falls back to first user message", () => {
    const longMessage = "b".repeat(150);
    const records = parsePiRecords([
      {
        type: "message",
        timestamp: "t2",
        message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
      },
      { type: "message", timestamp: "t1", message: { role: "user", content: longMessage } },
    ]);

    expect(extractPiTitle(records)).toBe("b".repeat(100));
  });

  it("getPiSessionId extracts the uuid from the filename", () => {
    expect(
      getPiSessionId(
        "/x/--dir--/2026-07-15T14-18-56-724Z_019f6625-1f54-7588-83dc-6eed11fc7ec0.jsonl",
      ),
    ).toBe("019f6625-1f54-7588-83dc-6eed11fc7ec0");
  });

  it("reads bounded head and tail metadata from a large session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-tool-pi-"));
    const file = join(dir, "2026-01-01T00-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl");
    try {
      await writeFile(
        file,
        [
          JSON.stringify({
            type: "session",
            id: "11111111-1111-4111-8111-111111111111",
            timestamp: "2026-01-01T00:00:00.000Z",
            cwd: "/project",
          }),
          "malformed",
          JSON.stringify({ type: "model_change", timestamp: "2026-01-01T12:00:00.000Z" }),
          JSON.stringify({
            type: "message",
            timestamp: "2026-01-02T00:00:00.000Z",
            message: { role: "user", content: "bounded title" },
          }),
          "x".repeat(1_000_000),
          JSON.stringify({ type: "custom", timestamp: "2026-01-03T00:00:00.000Z" }),
        ].join("\n"),
      );

      const metadata = await readPiSessionMetadata(file);
      expect(metadata).toMatchObject({
        sessionID: "11111111-1111-4111-8111-111111111111",
        title: "bounded title",
        createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
        updatedAt: Date.parse("2026-01-03T00:00:00.000Z"),
        cwd: "/project",
        source: "pi",
      });
      expect(metadata.bytesRead).toBeLessThanOrEqual(
        PI_SUMMARY_HEAD_MAX_BYTES + PI_SUMMARY_TAIL_MAX_BYTES + 1,
      );
      expect(metadata.parsedLines).toBeLessThan(10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a complete record when the tail starts exactly at a line boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-tool-pi-"));
    const file = join(dir, "tail-boundary.jsonl");
    const tailRecord = JSON.stringify({
      type: "custom",
      timestamp: "2026-01-03T00:00:00.000Z",
    });
    const tail = `${tailRecord}\n${"z".repeat(PI_SUMMARY_TAIL_MAX_BYTES - tailRecord.length - 1)}`;
    const header = `${JSON.stringify({
      type: "session",
      id: "tail-boundary",
      timestamp: "2026-01-01T00:00:00.000Z",
    })}\n`;
    const prefix = `${header}${"x".repeat(PI_SUMMARY_HEAD_MAX_BYTES)}\n`;
    try {
      await writeFile(file, prefix + tail);
      const metadata = await readPiSessionMetadata(file);
      expect(metadata.updatedAt).toBe(Date.parse("2026-01-03T00:00:00.000Z"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops a UTF-8-split boundary line but keeps following tail records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-tool-pi-"));
    const file = join(dir, "tail-utf8.jsonl");
    const record = JSON.stringify({
      type: "custom",
      timestamp: "2026-01-04T00:00:00.000Z",
    });
    const boundaryLine = "🙂".repeat(100);
    const suffixBase = `${boundaryLine}\n${record}\n`;
    const suffix = `${suffixBase}${"z".repeat(
      PI_SUMMARY_TAIL_MAX_BYTES + 1 - Buffer.byteLength(suffixBase),
    )}`;
    const prefix = `${JSON.stringify({
      type: "session",
      id: "tail-utf8",
      timestamp: "2026-01-01T00:00:00.000Z",
    })}\n${"x".repeat(PI_SUMMARY_HEAD_MAX_BYTES)}\n`;
    try {
      await writeFile(file, prefix + suffix);
      const metadata = await readPiSessionMetadata(file);
      expect(metadata.updatedAt).toBe(Date.parse("2026-01-04T00:00:00.000Z"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps full Pi message reads independent from bounded list metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-tool-pi-"));
    const file = join(dir, "full-read.jsonl");
    try {
      await writeFile(
        file,
        [
          JSON.stringify({ type: "session", id: "full-read" }),
          "x".repeat(600_000),
          JSON.stringify({
            type: "message",
            timestamp: "2026-01-02T00:00:00.000Z",
            message: { role: "user", content: "middle message remains searchable" },
          }),
          "y".repeat(600_000),
        ].join("\n"),
      );

      const messages = await Effect.runPromise(readPiMessages([file]));
      expect(messages.map((message) => message.body)).toContain(
        "middle message remains searchable",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses file mtime when session timestamps are unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-tool-pi-"));
    const file = join(dir, "fallback.jsonl");
    const modified = new Date("2026-02-03T04:05:06.000Z");
    try {
      await writeFile(
        file,
        `${JSON.stringify({ type: "session", id: "fallback", timestamp: "invalid" })}\nmalformed`,
      );
      await utimes(file, modified, modified);

      const metadata = await readPiSessionMetadata(file);
      expect(metadata.createdAt).toBe(modified.getTime());
      expect(metadata.updatedAt).toBe(modified.getTime());
      expect(metadata.title).toBe("Untitled session");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("filters projects from bounded Pi headers", async () => {
    const base = await mkdtemp(join(tmpdir(), "session-tool-pi-"));
    const sessions = join(base, "project");
    await mkdir(sessions);
    const matching = join(sessions, "matching.jsonl");
    const other = join(sessions, "other.jsonl");
    try {
      await writeFile(
        matching,
        `${JSON.stringify({ type: "session", id: "matching", cwd: "/target" })}\n${"x".repeat(500_000)}`,
      );
      await writeFile(
        other,
        `${JSON.stringify({ type: "session", id: "other", cwd: "/other" })}\n${"x".repeat(500_000)}`,
      );

      await expect(Effect.runPromise(getPiSessions(base, "/target"))).resolves.toEqual([matching]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps project session IDs scoped to their source", () => {
    const collision = "11111111-1111-4111-8111-111111111111";
    const filters = new Map([
      ["pi" as const, new Set([collision])],
      ["codex" as const, new Set<string>()],
    ]);

    expect(projectSessionFilter(filters, "pi", false)).toEqual(new Set([collision]));
    expect(projectSessionFilter(filters, "codex", false)).toEqual(new Set());
    expect(projectSessionFilter(filters, "codex", true)).toBeNull();
  });

  it("keeps created and updated session times distinct and sorts deterministically", () => {
    const summaries = sessionSummariesFromMessages([
      {
        sessionID: "b",
        id: "late",
        title: "latest title",
        body: "late",
        created: 30,
        role: "assistant",
        source: "codex",
      },
      {
        sessionID: "b",
        id: "early",
        title: "early title",
        body: "early",
        created: 10,
        role: "user",
        source: "codex",
      },
    ]);
    expect(summaries).toEqual([
      {
        sessionID: "b",
        title: "latest title",
        createdAt: 10,
        updatedAt: 30,
        source: "codex",
      },
    ]);
    expect(
      sortSessionSummaries([
        ...summaries,
        {
          sessionID: "a",
          title: "tie",
          createdAt: 10,
          updatedAt: 30,
          source: "codex",
        },
      ]).map((summary) => summary.sessionID),
    ).toEqual(["a", "b"]);
  });
});

function parsePiRecords(records: unknown[]) {
  return records
    .map((record) => parsePiLine(JSON.stringify(record)))
    .filter((record): record is NonNullable<typeof record> => record !== null);
}
