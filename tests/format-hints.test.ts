import { describe, expect, it } from "@effect/vitest";
import { formatOutput } from "../src/shared";
import type { BaseResult } from "../src/shared/types";

describe("error recovery hints in output formatting", () => {
  it("includes hint field in JSON output", () => {
    const result: BaseResult = {
      success: false,
      error: "Connection failed",
      executionTimeMs: 100,
      hint: "Check network connectivity",
      nextCommand: "retry command",
      retryable: true,
    };

    const json = formatOutput(result, "json");
    const parsed = JSON.parse(json);

    expect(parsed.hint).toBe("Check network connectivity");
    expect(parsed.nextCommand).toBe("retry command");
    expect(parsed.retryable).toBe(true);
  });

  it("includes hint field in TOON output", () => {
    const result: BaseResult = {
      success: false,
      error: "Connection failed",
      executionTimeMs: 100,
      hint: "Check network connectivity",
      nextCommand: "retry command",
      retryable: true,
    };

    const toon = formatOutput(result, "toon");

    expect(toon).toContain("hint");
    expect(toon).toContain("Check network connectivity");
    expect(toon).toContain("nextCommand");
    expect(toon).toContain("retryable");
  });

  it("omits optional hint fields when not provided", () => {
    const result: BaseResult = {
      success: false,
      error: "Connection failed",
      executionTimeMs: 100,
    };

    const json = formatOutput(result, "json");
    const parsed = JSON.parse(json);

    expect(parsed.hint).toBeUndefined();
    expect(parsed.nextCommand).toBeUndefined();
    expect(parsed.retryable).toBeUndefined();
  });

  it("includes hint in successful result", () => {
    const result: BaseResult = {
      success: true,
      executionTimeMs: 50,
      hint: "Operation completed successfully",
    };

    const json = formatOutput(result, "json");
    const parsed = JSON.parse(json);

    expect(parsed.success).toBe(true);
    expect(parsed.hint).toBe("Operation completed successfully");
  });
});
