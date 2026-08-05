import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { expect, it } from "vitest";

it("passes Bun-native SQLite VPN lifecycle tests", { timeout: 60_000 }, () => {
  const result = spawnSync("bun", ["test", "./tests/fixtures/prerequisites-runtime.bun.ts"], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: process.env,
  });

  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  expect(output).toContain("44 pass");
});
