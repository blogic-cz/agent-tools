import { beforeEach, vi } from "vitest";
const blocked = ((input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return Promise.reject(
    new Error(
      `Unit test attempted a real network request to ${url}. ` +
        `Route the call through GitHubService so the mock layer covers it, or stub globalThis.fetch in the test.`,
    ),
  );
}) as typeof globalThis.fetch;

globalThis.fetch = blocked;

const refuseProcess = () => {
  throw new Error(
    "Unit test attempted to start a real process. Inject the external process runner.",
  );
};
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("node:child_process")),
  spawn: refuseProcess,
  spawnSync: refuseProcess,
  exec: refuseProcess,
  execSync: refuseProcess,
  execFile: refuseProcess,
  execFileSync: refuseProcess,
  fork: refuseProcess,
}));
beforeEach(() => {
  vi.spyOn(Bun, "spawn").mockImplementation(refuseProcess);
  vi.spyOn(Bun, "spawnSync").mockImplementation(refuseProcess);
});
