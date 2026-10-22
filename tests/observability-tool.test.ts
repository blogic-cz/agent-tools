import { describe, expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { Effect, Layer, Option, Result } from "effect";
import { vi } from "vitest";

import { ObservabilityToolError } from "#observability/errors";
import { ConfigService } from "#config/loader";
import { SecretEnvResolver } from "#shared/secret-env";
import {
  formatObservabilityError,
  observabilityDsQuery,
  observabilityFetch,
  resolveConfig,
  requireTempoUid,
} from "#observability/shared";
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

describe("outbound content checks", () => {
  it.effect("refuses credential-bearing query bodies before fetching Grafana", () =>
    Effect.gen(function* () {
      const fetch = vi.spyOn(globalThis, "fetch");
      const token = `ghp_${"A".repeat(36)}`;
      try {
        const result = yield* observabilityDsQuery(
          config(),
          "loki",
          "loki",
          `{app="api"} |= "${token}"`,
        ).pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(formatObservabilityError(result.failure)).toContain("credential pattern");
        }
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    }),
  );

  it.effect("checks URL encoded query content before fetching Grafana", () =>
    Effect.gen(function* () {
      const fetch = vi.spyOn(globalThis, "fetch");
      const token = `ghp_${"A".repeat(36)}`;
      try {
        const result = yield* observabilityFetch(
          config(),
          `/api/search?q=${encodeURIComponent(token)}`,
        ).pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    }),
  );

  it.effect(
    "checks decoded query body strings when JSON escaping changes an environment value",
    () =>
      Effect.gen(function* () {
        const fetch = vi.spyOn(globalThis, "fetch");
        const variable = "AGENT_TOOLS_CONTENT_TOKEN";
        const previous = process.env[variable];
        const secret = 'quoted"\\token\nvalue';
        process.env[variable] = secret;
        try {
          for (const options of [{ from: secret }, { to: secret }]) {
            const result = yield* observabilityDsQuery(
              config(),
              "loki",
              "loki",
              '{app="api"}',
              options,
            ).pipe(Effect.result);

            expect(Result.isFailure(result)).toBe(true);
          }
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          if (previous === undefined) delete process.env[variable];
          else process.env[variable] = previous;
          fetch.mockRestore();
        }
      }),
  );

  it.effect("keeps configured authorization headers out of payload scanning", () =>
    Effect.gen(function* () {
      const token = `ghp_${"A".repeat(36)}`;
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ results: {} }), { status: 200 }));
      try {
        const result = yield* observabilityFetch({ ...config(), token }, "/api/ds/query", {
          method: "POST",
          body: JSON.stringify({ queries: [{ expr: '{app="api"}' }] }),
        }).pipe(Effect.result);

        expect(Result.isSuccess(result)).toBe(true);
        expect(fetch).toHaveBeenCalledOnce();
        const init = fetch.mock.calls[0]?.[1];
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
      } finally {
        fetch.mockRestore();
      }
    }),
  );
});

describe("summarizeSearchHits", () => {
  it("maps Tempo search hits to rows, newest first", () => {
    const rows = summarizeSearchHits({
      traces: [
        {
          traceID: "aaa",
          rootServiceName: "example-fe",
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
      rootServiceName: "example-fe",
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

describe("secret response error handling", () => {
  it.effect("rejects empty process and zsh tokens before fetching Grafana", () =>
    Effect.gen(function* () {
      const tokenEnvVar = "AGENT_TOOLS_OBSERVABILITY_EMPTY_TOKEN";
      const previous = process.env[tokenEnvVar];
      const oldFetch = globalThis.fetch;
      const fetch = vi.fn<typeof globalThis.fetch>();
      globalThis.fetch = fetch;
      try {
        for (const source of ["process", "zsh"] as const) {
          if (source === "process") process.env[tokenEnvVar] = "";
          else delete process.env[tokenEnvVar];

          let lookupCalls = 0;
          const lookup = async () => {
            lookupCalls += 1;
            return { _tag: "found" as const, value: "" };
          };
          const configLayer = Layer.succeed(ConfigService, {
            observability: {
              default: {
                environments: {
                  local: { url: "https://grafana.invalid", tokenEnvVar },
                },
              },
            },
          });
          const resolverLayer = SecretEnvResolver.testLayer(lookup);
          const result = yield* resolveConfig("local", Option.none()).pipe(
            Effect.result,
            Effect.provide(Layer.merge(configLayer, resolverLayer)),
          );

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            const rendered = formatObservabilityError(result.failure);
            expect(rendered).toContain(tokenEnvVar);
            expect(rendered).not.toContain("fake-secret-");
          }
          expect(lookupCalls).toBe(1);
          expect(fetch).not.toHaveBeenCalled();
          fetch.mockClear();
        }
      } finally {
        globalThis.fetch = oldFetch;
        if (previous === undefined) delete process.env[tokenEnvVar];
        else process.env[tokenEnvVar] = previous;
      }
    }),
  );

  it.effect("redacts an echoed token from the error cause", () =>
    Effect.gen(function* () {
      const token = `fake-secret-${crypto.randomUUID()}`;
      const tokenEnvVar = "AGENT_TOOLS_OBSERVABILITY_TEST_TOKEN";
      const previous = process.env[tokenEnvVar];
      delete process.env[tokenEnvVar];
      const configLayer = Layer.succeed(ConfigService, {
        observability: {
          default: {
            environments: {
              local: { url: "https://grafana.invalid", tokenEnvVar },
            },
          },
        },
      });
      const resolverLayer = SecretEnvResolver.testLayer(async () => ({
        _tag: "found",
        value: token,
      }));
      const oldFetch = globalThis.fetch;
      globalThis.fetch = vi.fn<() => Promise<Response>>(
        async () => new Response(token, { status: 401 }),
      ) as unknown as typeof fetch;
      try {
        const result = yield* resolveConfig("local", Option.none()).pipe(
          Effect.result,
          Effect.provide(Layer.merge(configLayer, resolverLayer)),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          const rendered = formatObservabilityError(result.failure);
          expect(rendered).toContain("[REDACTED]");
          expect(rendered).not.toContain(token);
        }
      } finally {
        globalThis.fetch = oldFetch;
        if (previous === undefined) delete process.env[tokenEnvVar];
        else process.env[tokenEnvVar] = previous;
      }
    }),
  );

  it("captures CLI stdout and stderr without an echoed token", () => {
    const token = `fake-secret-${crypto.randomUUID()}`;
    const script = `
      import { Cause, Effect, Layer, Option, Result } from "effect";
      import { ConfigService } from "./src/config/loader.ts";
      import { SecretEnvResolver } from "./src/shared/secret-env.ts";
      import { formatObservabilityError, resolveConfig } from "./src/observability-tool/shared.ts";
      import { renderCauseToStderr } from "./src/shared/error-renderer.ts";
      const token = ${JSON.stringify(token)};
      const tokenEnvVar = "AGENT_TOOLS_OBSERVABILITY_CLI_TOKEN";
      delete process.env[tokenEnvVar];
      globalThis.fetch = async () => new Response(token, { status: 401 });
      const config = Layer.succeed(ConfigService, { observability: { default: { environments: { local: { url: "https://grafana.invalid", tokenEnvVar } } } } });
      const resolver = SecretEnvResolver.testLayer(async () => ({ _tag: "found", value: token }));
      await Effect.runPromise(Effect.gen(function* () {
        const result = yield* resolveConfig("local", Option.none()).pipe(Effect.result);
        if (Result.isFailure(result)) {
          console.log(formatObservabilityError(result.failure));
          yield* renderCauseToStderr(Cause.fail(result.failure));
        }
      }).pipe(Effect.provide(Layer.merge(config, resolver))));
    `;
    const result = spawnSync("bun", ["-e", script], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stderr).toContain("ObservabilityToolError");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(token);
  });
});
