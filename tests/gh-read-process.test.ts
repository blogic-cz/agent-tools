import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import { runReplayCases } from "./fixtures/gh-read-process";

it(
  "drains a failed batch before cleanup and does not start another batch",
  { timeout: 10000 },
  async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "gh-replay-failure-"));
    try {
      const cases = Array.from({ length: 5 }, (_, index) => ({
        argv: [
          "--input-type=module",
          "-e",
          index === 0
            ? "process.exit(1)"
            : `import { writeFile } from 'node:fs/promises';
             await new Promise(resolve => setTimeout(resolve, 100));
             await writeFile(${JSON.stringify(join(root, String(index)))}, String(process.pid));`,
        ],
        stdout: "",
        status: 0,
      }));
      await expect(
        runReplayCases({
          executable: process.execPath,
          cases,
          options: { encoding: "utf8", signal, timeout: 5000 },
        }),
      ).rejects.toThrow("Replay failed: --input-type=module -e process.exit(1)");
      expect((await readdir(root)).sort()).toEqual(["1", "2", "3"]);
      for (const name of ["1", "2", "3"]) {
        const pid = Number(await readFile(join(root, name), "utf8"));
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it(
  "waits for cancelled children to exit before cleanup",
  { timeout: 10000 },
  async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "gh-replay-abort-"));
    const controller = new AbortController();
    let running: Promise<void> | undefined;
    try {
      running = runReplayCases({
        executable: process.execPath,
        cases: Array.from({ length: 5 }, (_, index) => ({
          argv: [
            "--input-type=module",
            "-e",
            `import { writeFile } from 'node:fs/promises';
           process.on('SIGTERM', () => setTimeout(async () => {
             await writeFile(${JSON.stringify(join(root, `done-${index}`))}, String(process.pid));
             process.exit(0);
           }, 50));
           setInterval(() => {}, 1000);
           await writeFile(${JSON.stringify(join(root, `ready-${index}`))}, 'ready');`,
          ],
          stdout: "",
          status: 0,
        })),
        options: {
          encoding: "utf8",
          signal: AbortSignal.any([signal, controller.signal]),
          timeout: 5000,
        },
      });
      const observed = running.then(
        () => undefined,
        (error: unknown) => error,
      );
      while ((await readdir(root)).filter((name) => name.startsWith("ready-")).length < 4) {
        await setTimeout(10, undefined, { signal });
      }
      controller.abort();
      expect(await observed).toMatchObject({ message: expect.stringContaining("Replay failed:") });
      const names = await readdir(root);
      expect(names.filter((name) => name.startsWith("done-")).sort()).toEqual([
        "done-0",
        "done-1",
        "done-2",
        "done-3",
      ]);
      expect(names).not.toContain("ready-4");
      for (let index = 0; index < 4; index++) {
        const pid = Number(await readFile(join(root, `done-${index}`), "utf8"));
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }
    } finally {
      controller.abort();
      if (running !== undefined) await Promise.allSettled([running]);
      await rm(root, { recursive: true, force: true });
    }
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
