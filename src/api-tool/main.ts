import { Command, Flag } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { createApiClient } from "./client";
import { decode, ClientSchema, RequestSchema } from "./types";
import { safeError } from "./errors";
import { VERSION } from "#shared";

const requestCommand = Command.make(
  "request",
  {
    config: Flag.String("config"),
    profile: Flag.String("profile"),
    path: Flag.String("path"),
    method: Flag.String("method").pipe(Flag.withDefault("GET")),
    query: Flag.String("query").pipe(Flag.withDefault("{}")),
    body: Flag.String("body").pipe(Flag.withDefault("")),
  },
  (args) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: async () => {
          const config = decode(ClientSchema, JSON.parse(await Bun.file(args.config).text()));
          const request = decode(RequestSchema, {
            profile: args.profile,
            method: args.method,
            path: args.path,
            query: JSON.parse(args.query),
            ...(args.body ? { body: JSON.parse(args.body) } : {}),
          });
          return createApiClient(config).request(request);
        },
        catch: safeError,
      });
      yield* Console.log(JSON.stringify(result));
    }),
).pipe(
  Command.withDescription("Send a JSON REST request through an operator-owned credential proxy"),
);
const command = Command.make("api-tool", {}).pipe(Command.withSubcommands([requestCommand]));
BunRuntime.runMain(
  Command.run(command, { version: VERSION, renderErrors: false }).pipe(
    Effect.provide(BunServices.layer),
    Effect.tapError((error) => Console.error(JSON.stringify(safeError(error)))),
  ),
  { disableErrorReporting: true },
);
