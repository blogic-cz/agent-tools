import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { formatOption, formatOutput } from "#shared";

import { GrafanaToolError } from "./errors";
import {
  buildHeaders,
  envOption,
  formatGrafanaError,
  profileOption,
  resolveConfig,
} from "./shared";

export const healthCommand = Command.make(
  "health",
  { format: formatOption, env: envOption, profile: profileOption },
  ({ format, env, profile }) =>
    Effect.gen(function* () {
      const start = Date.now();
      const config = yield* resolveConfig(env, profile);

      const data = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${config.url}/api/health`, {
            headers: buildHeaders(config.token),
          });

          return {
            status: response.status,
            ok: response.ok,
            body: await response.json().catch(() => null),
          };
        },
        catch: (error) => new GrafanaToolError({ cause: error }),
      });

      const result = {
        success: data.ok,
        message: data.ok
          ? `Grafana is healthy (${config.url})`
          : `Grafana unhealthy: HTTP ${data.status}`,
        data: {
          url: config.url,
          httpStatus: data.status,
          response: data.body,
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
            executionTimeMs: 0,
          };

          yield* Console.log(formatOutput(result, format));
        }),
      ),
    ),
).pipe(Command.withDescription("Check Grafana health and connectivity"));
