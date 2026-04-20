import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { formatOption, formatOutput } from "#shared";

import { GrafanaToolError } from "./errors";
import {
  envOption,
  formatGrafanaError,
  grafanaFetch,
  profileOption,
  resolveConfig,
} from "./shared";

type Datasource = {
  id: number;
  uid: string;
  name: string;
  type: string;
  url: string;
  isDefault: boolean;
};

const listCommand = Command.make(
  "list",
  { format: formatOption, env: envOption, profile: profileOption },
  ({ format, env, profile }) =>
    Effect.gen(function* () {
      const start = Date.now();
      const config = yield* resolveConfig(env, profile);

      const items = yield* Effect.tryPromise({
        try: () => grafanaFetch<Datasource[]>(config, "/api/datasources"),
        catch: (error) => new GrafanaToolError({ cause: error }),
      });

      const result = {
        success: true,
        message: `Found ${items.length} datasource(s)`,
        data: {
          datasources: items.map((item) => ({
            uid: item.uid,
            name: item.name,
            type: item.type,
            url: item.url,
            isDefault: item.isDefault,
          })),
          count: items.length,
        },
        executionTimeMs: Date.now() - start,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: "Failed to list datasources",
            error: formatGrafanaError(error),
            hint: "Check Grafana is running and accessible",
            executionTimeMs: 0,
          };

          yield* Console.log(formatOutput(result, format));
        }),
      ),
    ),
).pipe(Command.withDescription("List configured datasources"));

export const datasourcesCommand = Command.make("datasources", {}).pipe(
  Command.withDescription("Datasource operations"),
  Command.withSubcommands([listCommand]),
);
