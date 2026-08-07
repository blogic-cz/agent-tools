import { describe, expect, it } from "vitest";

import { describeMissingBinary, missingBinaryFromSpawnFailure } from "#shared/binary-preflight";

describe("missingBinaryFromSpawnFailure", () => {
  it("recognises a known binary that the platform could not spawn", () => {
    const missing = missingBinaryFromSpawnFailure(
      "kubectl",
      "PlatformError: NotFound: ChildProcess.spawn (kubectl get pods)",
    );

    expect(missing?.binary).toBe("kubectl");
    expect(missing?.hint).toContain("brew install kubectl");
  });

  it("stays silent when the spawn failed for any other reason", () => {
    expect(missingBinaryFromSpawnFailure("kubectl", "PlatformError: PermissionDenied")).toBe(
      undefined,
    );
  });

  it("stays silent for a binary the preflight does not describe", () => {
    expect(missingBinaryFromSpawnFailure("cowsay", "NotFound")).toBe(undefined);
  });

  it("names the tools that need the binary", () => {
    expect(describeMissingBinary("gh").hint).toContain("gh-tool");
    expect(describeMissingBinary("psql").hint).toContain("libpq is keg-only");
  });
});
