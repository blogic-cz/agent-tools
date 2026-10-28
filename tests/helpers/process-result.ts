import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

type Result = { stdout: string; stderr: string; exitCode: number };
export const processResultLayer = (run: (args: readonly string[]) => Result) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
      const result = run(command.args);
      const output = (text: string) => Stream.fromIterable([new TextEncoder().encode(text)]);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: output(result.stdout),
          stderr: output(result.stderr),
          all: output(result.stdout + result.stderr),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      );
    }),
  );
