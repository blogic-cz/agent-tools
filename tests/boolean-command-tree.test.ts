import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";

it("every tool command tree makes boolean flags optional", () => {
  const result = spawnSync("bun", ["tests/fixtures/boolean-command-tree.ts"], {
    encoding: "utf8",
    timeout: 15000,
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  const trees = JSON.parse(result.stdout) as Array<{
    tool: string;
    booleans: number;
    required: string[];
  }>;
  expect(trees.map((tree) => tree.tool).sort()).toEqual([
    "api-tool",
    "audit-tool",
    "az-tool",
    "azdo-tool",
    "db-tool",
    "gh-tool",
    "k8s-tool",
    "logs-tool",
    "observability-tool",
    "session-tool",
  ]);
  expect(trees.find((tree) => tree.tool === "gh-tool")?.booleans).toBeGreaterThan(0);
  expect(trees.flatMap((tree) => tree.required)).toEqual([]);
});
