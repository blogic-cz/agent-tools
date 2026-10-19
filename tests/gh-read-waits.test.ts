import { expect, it } from "@effect/vitest";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { waits } from "#gh/read/waits";

it.effect("clamps waits to five seconds", () =>
  Effect.gen(function* () {
    const times: number[] = [];
    const read = Effect.gen(function* () {
      times.push(Number(yield* Clock.currentTimeMillis));
      return times.length;
    });
    const fiber = yield* Effect.forkChild(
      waits.until(read, (value) => value === 2, { intervalMs: 1, timeoutMs: 10000 }),
    );
    yield* TestClock.adjust("4999 millis");
    expect(times).toEqual([0]);
    yield* TestClock.adjust("1 millis");
    expect(yield* Fiber.join(fiber)).toEqual({ kind: "done", value: 2 });
    expect(times).toEqual([0, 5000]);
  }),
);
it.effect("returns the last value at the deadline without an extra upstream call", () =>
  Effect.gen(function* () {
    let reads = 0;
    const fiber = yield* Effect.forkChild(
      waits.until(
        Effect.sync(() => ++reads),
        () => false,
        { intervalMs: 1, timeoutMs: 6000 },
      ),
    );
    yield* TestClock.adjust("6000 millis");
    expect(yield* Fiber.join(fiber)).toEqual({ kind: "timedOut", last: 2 });
    expect(reads).toBe(2);
    expect(Number(yield* Clock.currentTimeMillis)).toBe(6000);
  }),
);
it.effect("finishes immediately when the first value meets the condition", () =>
  Effect.gen(function* () {
    expect(
      yield* waits.until(Effect.succeed("completed"), () => true, { intervalMs: 1, timeoutMs: 0 }),
    ).toEqual({ kind: "done", value: "completed" });
    expect(Number(yield* Clock.currentTimeMillis)).toBe(0);
  }),
);
