import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ObservabilityToolError } from "#observability/errors";
import { formatObservabilityError, requireTempoUid } from "#observability/shared";
import { searchTempoByQuery, summarizeSearchHits } from "#observability/trace";
import type { ObservabilityEnvConfig } from "#observability/types";

const config = (tempoUid?: string): ObservabilityEnvConfig => ({
  url: "https://grafana.example.com",
  prometheusUid: "prometheus",
  lokiUid: "loki",
  tempoUid,
});

describe("requireTempoUid", () => {
  it.effect("returns the datasource UID when Grafana has Tempo", () =>
    Effect.gen(function* () {
      const tempoUid = yield* requireTempoUid(config("tempo"));

      expect(tempoUid).toBe("tempo");
    }),
  );

  it.effect("fails with ObservabilityToolError on a Grafana instance without Tempo", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(requireTempoUid(config(undefined)));

      expect(error).toBeInstanceOf(ObservabilityToolError);
      expect((error.cause as Error).message).toContain("No Tempo datasource found");
    }),
  );
});

describe("summarizeSearchHits", () => {
  it("maps Tempo search hits to rows, newest first", () => {
    const rows = summarizeSearchHits({
      traces: [
        {
          traceID: "aaa",
          rootServiceName: "nexus-fe",
          rootTraceName: "POST",
          startTimeUnixNano: "1789024819658000000",
          durationMs: 24,
          spanSets: [{ matched: 2 }],
        },
        {
          traceID: "bbb",
          startTimeUnixNano: "1789111219658000000",
          spanSets: [{ spans: [{ spanID: "1" }] }],
        },
        { rootServiceName: "no-id" },
      ],
    });

    expect(rows.map((row) => row.traceId)).toEqual(["bbb", "aaa"]);
    expect(rows[1]).toMatchObject({
      traceId: "aaa",
      startedAt: "2026-09-10T07:20:19.658Z",
      rootServiceName: "nexus-fe",
      rootTraceName: "POST",
      durationMs: 24,
      matchedSpans: 2,
    });
    expect(rows[0]?.matchedSpans).toBe(1);
  });
});

describe("searchTempoByQuery", () => {
  it.effect("refuses a window wider than the 168h Tempo limit before calling Grafana", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        searchTempoByQuery(
          config("tempo"),
          "{ status = error }",
          { start: "now-30d", end: "now" },
          20,
        ),
      );

      expect(error).toBeInstanceOf(ObservabilityToolError);
      expect(formatObservabilityError(error)).toContain("exceeds the 168h Tempo limit");
    }),
  );

  it.effect("refuses a reversed window", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        searchTempoByQuery(
          config("tempo"),
          "{ status = error }",
          { start: "now", end: "now-6h" },
          20,
        ),
      );

      expect(formatObservabilityError(error)).toContain("ends at or before it starts");
    }),
  );

  it.effect("refuses an unparseable start instead of searching a zero-width window", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        searchTempoByQuery(
          config("tempo"),
          "{ status = error }",
          { start: "2026-09-09T00:00:00Z", end: "now" },
          20,
        ),
      );

      expect(formatObservabilityError(error)).toContain('Unparseable time "2026-09-09T00:00:00Z"');
    }),
  );

  it.effect("refuses when the Grafana instance has no Tempo datasource", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        searchTempoByQuery(
          config(undefined),
          "{ status = error }",
          { start: "now-1h", end: "now" },
          20,
        ),
      );

      expect((error.cause as Error).message).toContain("No Tempo datasource found");
    }),
  );
});

describe("formatObservabilityError", () => {
  it("reads the text of a structured cause instead of rendering [object Object]", () => {
    const error = new ObservabilityToolError({
      cause: {
        message: "Search window exceeds the 168h Tempo limit",
        code: "SEARCH_RANGE_TOO_WIDE",
      },
    });

    expect(formatObservabilityError(error)).toBe("Search window exceeds the 168h Tempo limit");
  });
});
