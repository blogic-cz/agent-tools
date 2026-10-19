import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "vitest";

const runFile = promisify(execFile);

export const runReplayCases = async ({
  executable,
  cases,
  options,
}: {
  executable: string;
  cases: readonly { argv: string[]; stdout: string; status: number }[];
  options: ExecFileOptionsWithStringEncoding & { signal: AbortSignal };
}) => {
  const batches = Array.from({ length: Math.ceil(cases.length / 4) }, (_, index) =>
    cases.slice(index * 4, index * 4 + 4),
  );
  await batches.reduce(async (previous, batch) => {
    await previous;
    options.signal.throwIfAborted();
    let firstFailure: Error | undefined;
    await Promise.allSettled(
      batch.map(async (entry) => {
        let closed = Promise.resolve();
        try {
          const task = runFile(executable, entry.argv, options);
          closed = new Promise<void>((resolve) => {
            task.child.once("close", () => resolve());
          });
          const result = await task;
          await closed;
          expect(task.child.exitCode).toBe(entry.status);
          expect(result.stderr).toBe("");
          expect(result.stdout).toBe(entry.stdout);
        } catch (cause) {
          firstFailure ??= new Error(`Replay failed: ${entry.argv.join(" ")}`, { cause });
        } finally {
          await closed;
        }
      }),
    );
    if (firstFailure !== undefined) throw firstFailure;
  }, Promise.resolve());
};
