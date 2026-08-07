import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findOnPath,
  missingBinary,
  REQUIRED_BINARIES,
  resetBinaryPreflightCache,
} from "#shared/binary-preflight";

const presentEverywhere = async () => true;
const presentNowhere = async () => false;

describe("binary preflight", () => {
  it("covers every binary the package still spawns", () => {
    expect(Object.keys(REQUIRED_BINARIES).sort()).toEqual(["az", "gh", "git", "kubectl"]);
    for (const entry of Object.values(REQUIRED_BINARIES)) {
      expect(entry.tools.length).toBeGreaterThan(0);
      expect(entry.install.length).toBeGreaterThan(0);
    }
  });

  it("finds a binary provided by any PATH directory", async () => {
    const seen: string[] = [];
    const exists = async (candidate: string) => {
      seen.push(candidate);
      return candidate === join("/opt/bin", "kubectl");
    };

    expect(await findOnPath("kubectl", "/usr/bin:/opt/bin", exists)).toBe(true);
    expect(seen).toEqual([join("/usr/bin", "kubectl"), join("/opt/bin", "kubectl")]);
  });

  it("reports nothing missing when the binary is present", async () => {
    const result = await Effect.runPromise(missingBinary("kubectl", presentEverywhere));

    expect(result).toBeUndefined();
  });

  it("reports a typed missing binary when it is absent", async () => {
    const result = await Effect.runPromise(missingBinary("kubectl", presentNowhere));

    expect(result?.binary).toBe("kubectl");
    expect(result?.message).toContain("kubectl");
    expect(result?.message).toContain("not found on PATH");
  });

  it("carries an install hint that names the tool and the install command", async () => {
    const result = await Effect.runPromise(missingBinary("gh", presentNowhere));

    expect(result?.hint).toContain("gh-tool");
    expect(result?.hint).toContain("brew install gh");
  });

  it("ignores binaries that are not part of the required set", async () => {
    const result = await Effect.runPromise(missingBinary("but", presentNowhere));

    expect(result).toBeUndefined();
  });

  it("keeps an injected resolver independent of the process-wide cache", async () => {
    resetBinaryPreflightCache();

    await Effect.runPromise(missingBinary("az", presentEverywhere));
    const result = await Effect.runPromise(missingBinary("az", presentNowhere));

    expect(result?.binary).toBe("az");
  });

  it("memoizes the uninjected PATH lookup until the cache is reset", async () => {
    const originalPath = process.env.PATH;
    const binDir = mkdtempSync(join(tmpdir(), "agent-tools-preflight-"));
    const kubectlPath = join(binDir, "kubectl");
    writeFileSync(kubectlPath, "#!/bin/sh\nexit 0\n");
    chmodSync(kubectlPath, 0o755);

    try {
      resetBinaryPreflightCache();
      process.env.PATH = binDir;
      expect(await Effect.runPromise(missingBinary("kubectl"))).toBeUndefined();

      process.env.PATH = "";
      expect(await Effect.runPromise(missingBinary("kubectl"))).toBeUndefined();

      resetBinaryPreflightCache();
      expect((await Effect.runPromise(missingBinary("kubectl")))?.binary).toBe("kubectl");
    } finally {
      process.env.PATH = originalPath;
      resetBinaryPreflightCache();
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
