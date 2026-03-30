import { describe, expect, it } from "@effect/vitest";

import type { BuildJob } from "#az/types";

import { transformBuildLogContent, transformCmdOutput, transformTimeline } from "#az/transformers";

function createBuildJob(overrides?: Partial<BuildJob>): BuildJob {
  return {
    id: "job-1",
    type: "Job",
    name: "Build",
    state: "completed",
    result: "succeeded",
    startTime: "2024-01-01T10:00:00Z",
    finishTime: "2024-01-01T10:05:00Z",
    errorCount: 0,
    warningCount: 0,
    log: { id: 1, url: "https://example.com/log/1" },
    ...overrides,
  };
}

describe("transformBuildLogContent", () => {
  it("deduplicates and strips Azure build noise while surfacing errors first", () => {
    const rawLog = [
      "2024-01-01T10:00:00Z ##[section]Starting: Build",
      "2024-01-01T10:00:01Z Downloading package A 1.0.0...",
      "2024-01-01T10:00:02Z ##[debug]Resolving cache",
      "2024-01-01T10:00:03Z Building app...",
      "2024-01-01T10:00:04Z ##[error]Build failed: module not found",
      "2024-01-01T10:00:05Z Error: Cannot find module '@app/core'",
      "2024-01-01T10:00:06Z",
      "2024-01-01T10:00:07Z ##[section]Finishing: Build",
    ].join("\n");

    const transformed = transformBuildLogContent(rawLog);

    expect(transformed).toContain("##[error]Build failed: module not found");
    expect(transformed).toContain("Error: Cannot find module '@app/core'");
    expect(transformed).toContain("Building app...");

    expect(transformed).not.toContain("##[section]");
    expect(transformed).not.toContain("##[debug]");
    expect(transformed).not.toContain("Downloading package");

    const lines = transformed.split("\n");
    expect(lines[0]).toContain("##[error]Build failed");
    expect(lines[1]).toContain("Error: Cannot find module");
  });

  it("returns empty string for empty input", () => {
    expect(transformBuildLogContent("")).toBe("");
  });
});

describe("transformCmdOutput", () => {
  it("returns parsed JSON object when output is valid JSON", () => {
    const input = '{"value": [{"id": 1, "name": "pipeline-1"}]}';
    const transformed = transformCmdOutput(input);

    expect(typeof transformed).toBe("object");
    if (
      typeof transformed === "string" ||
      Array.isArray(transformed) ||
      !("value" in transformed)
    ) {
      expect.fail("Expected parsed JSON object");
    }
    expect(transformed.value).toEqual([{ id: 1, name: "pipeline-1" }]);
  });

  it("parses table-like output into structured headers and rows", () => {
    const input = [
      "NAME          STATUS    AGE",
      "pipeline-1    active    5d",
      "pipeline-2    paused    2h",
    ].join("\n");

    const transformed = transformCmdOutput(input);
    if (typeof transformed === "string" || Array.isArray(transformed)) {
      expect.fail("Expected parsed table object");
    }

    expect(transformed.headers).toEqual(["NAME", "STATUS", "AGE"]);
    expect(transformed.rows).toEqual([
      { NAME: "pipeline-1", STATUS: "active", AGE: "5d" },
      { NAME: "pipeline-2", STATUS: "paused", AGE: "2h" },
    ]);
  });

  it("passes through short plain text unchanged", () => {
    expect(transformCmdOutput("Created successfully")).toBe("Created successfully");
  });

  it("deduplicates long repeated text output", () => {
    const line = "Processing package restore";
    const input = Array.from({ length: 60 }, () => line).join("\n");

    const transformed = transformCmdOutput(input);

    expect(typeof transformed).toBe("string");
    if (typeof transformed !== "string") {
      expect.fail("Expected string output after deduplication");
    }
    expect(transformed).toBe("Processing package restore [×60]");
  });
});

describe("transformTimeline", () => {
  it("keeps Stage/Job records and retains non-stage records with errors", () => {
    const records: BuildJob[] = [
      createBuildJob({ id: "stage-1", type: "Stage", name: "Build" }),
      createBuildJob({ id: "job-1", type: "Job", name: "Build .NET" }),
      createBuildJob({ id: "task-1", type: "Task", name: "NuGet restore" }),
      createBuildJob({
        id: "task-2",
        type: "Task",
        name: "dotnet build",
        result: "failed",
        errorCount: 2,
      }),
      createBuildJob({ id: "checkpoint-1", type: "Checkpoint", name: "approval" }),
    ];

    const transformed = transformTimeline(records);

    expect(transformed.map((r) => r.name)).toEqual(["Build", "Build .NET", "dotnet build"]);
    expect(transformed).toHaveLength(3);
  });
});
