import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCheckStatusCache, writeCheckStatusCache } from "#gh/pr/check-status-cache";

const checks = [{ name: "Build", state: "PENDING", bucket: "pending", link: "run" }];
let directory: string;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("shared PR check status cache", () => {
  it("shares fresh pending snapshots and separates principal, head, and expiry", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-tools-check-cache-"));
    await writeCheckStatusCache(
      "principal-a",
      "owner/repo",
      42,
      "head-a",
      checks,
      10_000,
      directory,
    );

    expect(
      await readCheckStatusCache(
        "principal-a",
        "owner/repo",
        42,
        "head-a",
        14_000,
        true,
        directory,
      ),
    ).toEqual(checks);
    expect(
      await readCheckStatusCache(
        "principal-a",
        "owner/repo",
        42,
        "head-a",
        16_000,
        true,
        directory,
      ),
    ).toBeNull();
    expect(
      await readCheckStatusCache(
        "principal-b",
        "owner/repo",
        42,
        "head-a",
        11_000,
        false,
        directory,
      ),
    ).toBeNull();
    expect(
      await readCheckStatusCache(
        "principal-a",
        "owner/repo",
        42,
        "head-b",
        11_000,
        false,
        directory,
      ),
    ).toBeNull();
    expect(
      await readCheckStatusCache(
        "principal-a",
        "owner/repo",
        42,
        "head-a",
        41_000,
        false,
        directory,
      ),
    ).toBeNull();
  });

  it("publishes complete snapshots from concurrent writers", async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-tools-check-cache-"));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeCheckStatusCache(
          "principal",
          "owner/repo",
          42,
          "head",
          checks,
          1_000 + index,
          directory,
        ),
      ),
    );

    const files = await readdir(directory);
    const snapshots = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))),
    );
    expect(snapshots).toHaveLength(8);
    expect(snapshots.every((snapshot) => snapshot.checks[0].name === "Build")).toBe(true);
  });
});
