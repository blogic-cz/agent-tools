import { describe, expect, it } from "vitest";

import {
  encodeProjectPath,
  extractSessionTitle,
  extractTextFromContent,
  parseJsonlLine,
} from "#session/claude-code";
import { extractPiText, extractPiTitle, getPiSessionId, parsePiLine } from "#session/pi";

describe("session-tool Claude Code helpers", () => {
  it("encodeProjectPath replaces slashes with dashes", () => {
    expect(encodeProjectPath("/Users/foo/bar")).toBe("-Users-foo-bar");
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
});

function parsePiRecords(records: unknown[]) {
  return records
    .map((record) => parsePiLine(JSON.stringify(record)))
    .filter((record): record is NonNullable<typeof record> => record !== null);
}
