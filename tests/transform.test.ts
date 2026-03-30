import { describe, expect, it } from "@effect/vitest";

import {
  aggregateByField,
  deduplicateLines,
  formatCountSummary,
  parseTextTable,
  stripEmptyColumns,
  truncateRows,
} from "#shared";

describe("deduplicateLines", () => {
  it("deduplicates consecutive identical lines", () => {
    const input = "error connecting\nerror connecting\nerror connecting";

    expect(deduplicateLines(input)).toBe("error connecting [×3]");
  });

  it("deduplicates lines that differ only by timestamp", () => {
    const input = [
      "2024-01-01T10:00:00Z Connection failed",
      "2024-01-01T10:00:01Z Connection failed",
    ].join("\n");

    expect(deduplicateLines(input)).toBe("2024-01-01T10:00:00Z Connection failed [×2]");
  });

  it("deduplicates lines that differ only by UUID", () => {
    const input = [
      "Processing request abc12345-1234-1234-1234-123456789abc",
      "Processing request def12345-5678-5678-5678-123456789def",
    ].join("\n");

    expect(deduplicateLines(input)).toBe(
      "Processing request abc12345-1234-1234-1234-123456789abc [×2]",
    );
  });

  it("does not deduplicate non-consecutive identical lines", () => {
    const input = "error connecting\nsuccess\nerror connecting";

    expect(deduplicateLines(input)).toBe("error connecting\nsuccess\nerror connecting");
  });

  it("returns empty string for empty input", () => {
    expect(deduplicateLines("")).toBe("");
  });
});

describe("parseTextTable", () => {
  it("parses a basic kubectl table", () => {
    const input = [
      "NAME          READY   STATUS    RESTARTS   AGE",
      "pod-1         1/1     Running   0          5d",
      "pod-2         0/1     Error     3          2h",
    ].join("\n");

    expect(parseTextTable(input)).toEqual({
      headers: ["NAME", "READY", "STATUS", "RESTARTS", "AGE"],
      rows: [
        { NAME: "pod-1", READY: "1/1", STATUS: "Running", RESTARTS: "0", AGE: "5d" },
        { NAME: "pod-2", READY: "0/1", STATUS: "Error", RESTARTS: "3", AGE: "2h" },
      ],
    });
  });

  it("parses multi-word headers as underscore keys", () => {
    const input = ["NAME   NOMINATED NODE   READINESS GATES", "pod-1  <none>          <none>"].join(
      "\n",
    );

    expect(parseTextTable(input)).toEqual({
      headers: ["NAME", "NOMINATED_NODE", "READINESS_GATES"],
      rows: [{ NAME: "pod-1", NOMINATED_NODE: "<none>", READINESS_GATES: "<none>" }],
    });
  });

  it("handles headers-only table", () => {
    const input = "NAME   STATUS\n";

    expect(parseTextTable(input)).toEqual({
      headers: ["NAME", "STATUS"],
      rows: [],
    });
  });
});

describe("aggregateByField", () => {
  it("counts and sorts by occurrence descending", () => {
    const input = [{ status: "Running" }, { status: "Running" }, { status: "Error" }];

    expect(aggregateByField(input, "status")).toEqual({ Running: 2, Error: 1 });
  });
});

describe("formatCountSummary", () => {
  it("formats a readable summary", () => {
    const counts = { Running: 30, Error: 3, Pending: 2 };

    expect(formatCountSummary(counts, 35, "pods")).toBe("35 pods: 30 Running, 3 Error, 2 Pending");
  });
});

describe("truncateRows", () => {
  it("truncates rows when limit is smaller than array length", () => {
    expect(truncateRows([1, 2, 3, 4, 5], 3)).toEqual({
      rows: [1, 2, 3],
      truncated: true,
      total: 5,
      showing: 3,
    });
  });

  it("does not truncate when limit exceeds array length", () => {
    expect(truncateRows([1, 2], 5)).toEqual({
      rows: [1, 2],
      truncated: false,
      total: 2,
      showing: 2,
    });
  });
});

describe("stripEmptyColumns", () => {
  it("removes columns that are empty across all rows", () => {
    const input = [
      { a: "x", b: null, c: "y" },
      { a: "z", b: null, c: "w" },
    ];

    expect(stripEmptyColumns(input)).toEqual([
      { a: "x", c: "y" },
      { a: "z", c: "w" },
    ]);
  });
});
