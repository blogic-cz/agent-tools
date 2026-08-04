import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ObservabilityToolError } from "#observability/errors";
import { requireTempoUid } from "#observability/shared";
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
