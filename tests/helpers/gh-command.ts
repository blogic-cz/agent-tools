import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { ConfigService } from "#config";
import { mainCommand } from "#gh/main";
import { GitHubService } from "#gh/read/transport";
import { withRedactedOutput } from "#shared/output-boundary";
import { processResultLayer } from "./process-result";

export const ghCommand = (
  argv: readonly string[],
  reply: (args: readonly string[]) => { stdout: string; stderr: string; exitCode: number },
) => {
  const platform = Layer.mergeAll(
    BunServices.layer,
    processResultLayer(reply),
    Layer.succeed(ConfigService, undefined),
  );
  const services = GitHubService.layer.pipe(Layer.provideMerge(platform));
  return withRedactedOutput(
    Command.runWith(mainCommand, { version: "test", renderErrors: false })(argv),
  ).pipe(Effect.provide(services));
};
