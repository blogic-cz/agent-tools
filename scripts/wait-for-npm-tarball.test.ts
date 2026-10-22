import { expect, it } from "vitest";
import { waitForNpmTarball } from "./wait-for-npm-tarball";

const tarballUrl = "https://registry.npmjs.org/@example-org/agent-tools/-/agent-tools-1.8.0.tgz";

const createClock = () => {
  let currentTime = 0;
  return {
    clock: {
      now: () => currentTime,
      sleep: async (milliseconds: number) => {
        currentTime += milliseconds;
      },
    },
    currentTime: () => currentTime,
  };
};

it("ends the wait when npm serves the tarball", async () => {
  const clock = createClock();
  let requests = 0;

  await waitForNpmTarball(tarballUrl, {
    fetchImpl: async () => {
      requests += 1;
      return new Response(null, { status: 200 });
    },
    clock: clock.clock,
    timeoutMs: 10_000,
  });

  expect(requests).toBe(1);
  expect(clock.currentTime()).toBe(0);
});

it("retries a 404 until npm serves the tarball", async () => {
  const clock = createClock();
  let requests = 0;

  await waitForNpmTarball(tarballUrl, {
    fetchImpl: async () => new Response(null, { status: ++requests === 1 ? 404 : 200 }),
    clock: clock.clock,
    timeoutMs: 10_000,
    intervalMs: 5_000,
  });

  expect(requests).toBe(2);
  expect(clock.currentTime()).toBe(5_000);
});

it("fails when npm does not serve the tarball before the bound", async () => {
  const clock = createClock();
  let requests = 0;

  await expect(
    waitForNpmTarball(tarballUrl, {
      fetchImpl: async () => {
        requests += 1;
        return new Response(null, { status: 404 });
      },
      clock: clock.clock,
      timeoutMs: 10_000,
      intervalMs: 5_000,
    }),
  ).rejects.toThrow(`npm did not serve ${tarballUrl} within 10000ms. Last result: HTTP 404`);

  expect(requests).toBe(2);
  expect(clock.currentTime()).toBe(10_000);
});
