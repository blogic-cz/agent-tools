import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { logFormatted, logText } from "#shared";

type WriteCall = { chunk: string; done: () => void };

const captureStdout = () => {
  const calls: WriteCall[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string, callback?: () => void) => {
    calls.push({ chunk, done: callback ?? (() => {}) });
    return true;
  }) as typeof process.stdout.write;
  return { calls, restore: () => (process.stdout.write = original) };
};

describe("stdout writes wait for the stream callback", () => {
  it("logText stays pending until the write callback fires", async () => {
    const stdout = captureStdout();
    let settled = false;
    try {
      const running = Effect.runPromise(logText("payload")).then(() => (settled = true));
      await Promise.resolve();

      expect(stdout.calls).toHaveLength(1);
      expect(stdout.calls[0]?.chunk).toBe("payload\n");
      expect(settled).toBe(false);

      stdout.calls[0]?.done();
      await running;
      expect(settled).toBe(true);
    } finally {
      stdout.restore();
    }
  });

  it("logFormatted routes through logText", async () => {
    const stdout = captureStdout();
    try {
      const running = Effect.runPromise(logFormatted({ a: 1 }, "json"));
      await Promise.resolve();

      expect(stdout.calls[0]?.chunk).toBe('{\n  "a": 1\n}\n');

      stdout.calls[0]?.done();
      await running;
    } finally {
      stdout.restore();
    }
  });
});
