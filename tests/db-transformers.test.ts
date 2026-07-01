import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_ROW_LIMIT, MAX_VALUE_LENGTH, transformQueryResult } from "#db/transformers";

describe("transformQueryResult", () => {
  it("truncates rows when result exceeds default limit", () => {
    const bigResult = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `row-${i}` }));

    const transformed = transformQueryResult(bigResult);

    expect(transformed.data).toHaveLength(DEFAULT_ROW_LIMIT);
    expect(transformed.truncated).toBe(true);
    expect(transformed.total).toBe(100);
    expect(transformed.showing).toBe(DEFAULT_ROW_LIMIT);
  });

  it("respects an explicit limit override", () => {
    const bigResult = Array.from({ length: 100 }, (_, i) => ({ id: i }));

    const transformed = transformQueryResult(bigResult, 75);

    expect(transformed.data).toHaveLength(75);
    expect(transformed.truncated).toBe(true);
    expect(transformed.total).toBe(100);
  });

  it("returns all rows when limit is 0 (no cap)", () => {
    const bigResult = Array.from({ length: 200 }, (_, i) => ({ id: i }));

    const transformed = transformQueryResult(bigResult, 0);

    expect(transformed.data).toHaveLength(200);
    expect(transformed.truncated).toBe(false);
    expect(transformed.showing).toBe(200);
  });

  it("does not truncate rows when under the default limit", () => {
    const smallResult = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `row-${i}` }));

    const transformed = transformQueryResult(smallResult);

    expect(transformed.data).toHaveLength(30);
    expect(transformed.truncated).toBe(false);
    expect(transformed.total).toBe(30);
    expect(transformed.showing).toBe(30);
  });

  it("strips columns that are null across all rows", () => {
    const nullCols = [
      { id: 1, name: "test", deleted_at: null, archived_at: null },
      { id: 2, name: "test2", deleted_at: null, archived_at: null },
    ];

    const transformed = transformQueryResult(nullCols);

    expect(transformed.data).toEqual([
      { id: 1, name: "test" },
      { id: 2, name: "test2" },
    ]);
  });

  it("truncates long string values", () => {
    const longValues = [{ id: 1, description: "a".repeat(300) }];

    const transformed = transformQueryResult(longValues);
    const description = transformed.data[0]?.description;

    expect(typeof description).toBe("string");
    expect(description).toBe(`${"a".repeat(MAX_VALUE_LENGTH)}...`);
  });

  it("returns stable metadata for empty result set", () => {
    const transformed = transformQueryResult([]);

    expect(transformed).toEqual({
      data: [],
      truncated: false,
      total: 0,
      showing: 0,
    });
  });

  it("handles mixed scenario with null columns, long values, and row limit", () => {
    const mixed = Array.from({ length: 75 }, (_, i) => ({
      id: i,
      name: `row-${i}`,
      deleted_at: null,
      description: `${"x".repeat(250)}-${i}`,
    }));

    const transformed = transformQueryResult(mixed);
    const firstRow = transformed.data[0];

    expect(transformed.data).toHaveLength(DEFAULT_ROW_LIMIT);
    expect(transformed.truncated).toBe(true);
    expect(transformed.total).toBe(75);
    expect(transformed.showing).toBe(DEFAULT_ROW_LIMIT);
    expect(firstRow).not.toHaveProperty("deleted_at");
    expect(typeof firstRow?.description).toBe("string");
    if (typeof firstRow?.description !== "string") {
      expect.fail("Expected first row description to be a string");
      return;
    }
    expect(firstRow.description.length).toBe(MAX_VALUE_LENGTH + 3);
  });

  it("does not truncate numbers and booleans", () => {
    const input = [{ id: 12345678, active: true, name: "test" }];

    const transformed = transformQueryResult(input);

    expect(transformed.data[0]).toEqual({ id: 12345678, active: true, name: "test" });
    expect(typeof transformed.data[0]?.id).toBe("number");
    expect(typeof transformed.data[0]?.active).toBe("boolean");
  });
});
