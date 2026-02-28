import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Schema, Stream } from "effect";

const DEFAULT_TIMEOUT_MS = 30000;

export class ExecError extends Schema.TaggedErrorClass<ExecError>()("ExecError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.Number,
  stderr: Schema.String,
}) {}

export const execEffect = (
  commandStr: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Effect.Effect<
  { stdout: string; stderr: string; exitCode: number },
  ExecError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const executor = yield* ChildProcessSpawner.ChildProcessSpawner;

      const command = ChildProcess.make("sh", ["-c", commandStr], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const process = yield* executor.spawn(command);

      const stdoutChunk = yield* process.stdout.pipe(Stream.decodeText(), Stream.runCollect);
      const stderrChunk = yield* process.stderr.pipe(Stream.decodeText(), Stream.runCollect);

      const stdout = stdoutChunk.join("");
      const stderr = stderrChunk.join("");
      const exitCode = yield* process.exitCode;

      if (exitCode !== 0) {
        return yield* new ExecError({
          message: stderr || `Command failed with exit code ${exitCode}`,
          command: commandStr,
          exitCode,
          stderr,
        });
      }

      return { stdout, stderr, exitCode };
    }),
  ).pipe(
    Effect.timeout(timeoutMs),
    Effect.catch((error: unknown) =>
      Effect.fail(
        new ExecError({
          message: `Command execution failed: ${String(error)}`,
          command: commandStr,
          exitCode: -1,
          stderr: String(error),
        }),
      ),
    ),
  );
