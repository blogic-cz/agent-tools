export type TarballWaitClock = {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

export type TarballWaitOptions = {
  fetchImpl?: typeof fetch;
  clock?: TarballWaitClock;
  timeoutMs?: number;
  intervalMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 1000;
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export const waitForNpmTarball = async (
  url: string,
  {
    fetchImpl = fetch,
    clock = {
      now: Date.now,
      sleep,
    },
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
  }: TarballWaitOptions = {},
): Promise<void> => {
  const deadline = clock.now() + timeoutMs;
  let lastResult = "no response";

  const poll = async (): Promise<void> => {
    if (clock.now() >= deadline) {
      throw new Error(`npm did not serve ${url} within ${timeoutMs}ms. Last result: ${lastResult}`);
    }

    const remainingMs = deadline - clock.now();

    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(remainingMs) });
      if (response.status === 200) {
        await response.body?.cancel();
        console.log(`npm serves ${url}`);
        return;
      }
      lastResult = `HTTP ${response.status}`;
    } catch (error) {
      lastResult = error instanceof Error ? error.message : String(error);
    }

    const waitMs = Math.min(intervalMs, deadline - clock.now());
    if (waitMs > 0) await clock.sleep(waitMs);
    return poll();
  };

  await poll();
};

if (import.meta.main) {
  const url = Bun.argv[2];
  if (!url) throw new Error("Usage: bun scripts/wait-for-npm-tarball.ts <tarball-url>");
  await waitForNpmTarball(url);
}
