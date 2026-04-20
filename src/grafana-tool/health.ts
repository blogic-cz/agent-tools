import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { formatOption, formatOutput } from "#shared";

import {
  envOption,
  formatGrafanaError,
  grafanaFetch,
  profileOption,
  resolveConfig,
} from "./shared";

export const healthCommand = Command.make(
  "health",
  { format: formatOption, env: envOption, profile: profileOption },
  ({ format, env, profile }) => {
    const start = Date.now();

    return Effect.gen(function* () {
      const config = yield* resolveConfig(env, profile);

      const body = yield* grafanaFetch<{ database?: string; version?: string; commit?: string }>(
        config,
        "/api/health",
      );

      const result = {
        success: true,
        message: `Grafana is healthy (${config.url})`,
        data: {
          url: config.url,
          httpStatus: 200,
          response: body,
          env,
        },
        executionTimeMs: Date.now() - start,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: "Grafana is unreachable",
            error: formatGrafanaError(error),
            hint: "Check Grafana is running and accessible",
            executionTimeMs: Date.now() - start,
          };

          yield* Console.log(formatOutput(result, format));
        }),
      ),
    );
  },
).pipe(Command.withDescription("Check Grafana health and connectivity"));
