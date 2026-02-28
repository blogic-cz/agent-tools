import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Stream } from "effect";

import { GitHubCommandError } from "../errors";

export type LocalCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ButStatusJson = {
  stacks: Array<{
    branches: Array<{ name: string }>;
  }>;
};

export type PRViewJsonResult = {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
};

export const runLocalCommand = Effect.fn("pr.runLocalCommand")(function* (
  binary: string,
  args: string[],
) {
  const executor = yield* ChildProcessSpawner.ChildProcessSpawner;

  const command = ChildProcess.make(binary, args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* executor.spawn(command);

      const stdoutChunk = yield* proc.stdout.pipe(Stream.decodeText(), Stream.runCollect);
      const stdout = stdoutChunk.join("");

      const stderrChunk = yield* proc.stderr.pipe(Stream.decodeText(), Stream.runCollect);
      const stderr = stderrChunk.join("");

      const exitCode = yield* proc.exitCode;

      const commandText = [binary, ...args].join(" ");
      if (exitCode !== 0) {
        return yield* Effect.fail(
          new GitHubCommandError({
            message: stderr.trim(),
            command: commandText,
            exitCode: exitCode as number,
            stderr: stderr.trim(),
          }),
        );
      }

      const commandResult: LocalCommandResult = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: exitCode as number,
      };
      return commandResult;
    }),
  ).pipe(
    Effect.mapError(
      (error) =>
        new GitHubCommandError({
          command: [binary, ...args].join(" "),
          exitCode: -1,
          stderr: String(error),
          message: String(error),
        }),
    ),
  );

  return result;
});
