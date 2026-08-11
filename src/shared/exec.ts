import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Schema, Stream } from "effect";

const DEFAULT_TIMEOUT_MS = 30000;

export class ExecError extends Schema.TaggedError<ExecError>()("ExecError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.Number,
  stderr: Schema.String,
}) {}

export const collectProcessOutput = (process: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.gen(function* () {
    const stdoutChunk = yield* process.stdout.pipe(Stream.decodeText(), Stream.runCollect);
    const stderrChunk = yield* process.stderr.pipe(Stream.decodeText(), Stream.runCollect);

    const stdout = stdoutChunk.join("");
    const stderr = stderrChunk.join("");
    const exitCode = yield* process.exitCode;

    return { stdout, stderr, exitCode };
  });

export const execEffect = (
  executable: string,
  args: readonly string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Effect.Effect<
  { stdout: string; stderr: string; exitCode: number },
  ExecError,
  ChildProcessSpawner.ChildProcessSpawner
> => {
  const commandStr = renderCommandLine([executable, ...args]);

  return Effect.scoped(
    Effect.gen(function* () {
      const executor = yield* ChildProcessSpawner.ChildProcessSpawner;

      const command = ChildProcess.make(executable, args, {
        stdout: "pipe",
        stderr: "pipe",
      });

      const process = yield* executor.spawn(command);

      const { stdout, stderr, exitCode } = yield* collectProcessOutput(process);

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
};

export const quoteShellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Split a command line the way a POSIX shell would word-split it, without running one.
 * Quotes group a value into a single argument and are removed; nothing else is interpreted,
 * so a metacharacter reaches the child as literal text instead of shell syntax.
 */
export const tokenizeCommandLine = (commandLine: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | undefined;

  for (const character of commandLine) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += character;
    started = true;
  }

  if (started) {
    tokens.push(current);
  }

  return tokens;
};

export const renderCommandLine = (argv: readonly string[]): string =>
  argv.map((arg) => (/^[A-Za-z0-9_./:=,@+-]+$/.test(arg) ? arg : quoteShellArg(arg))).join(" ");
