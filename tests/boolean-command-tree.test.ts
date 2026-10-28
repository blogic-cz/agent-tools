import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const inspect = (root: unknown) => {
  const result = {
    tool: object(root) ? String(root.name) : "unknown",
    booleans: 0,
    required: [] as string[],
  };
  const visit = (node: unknown, path: string) => {
    if (!object(node)) throw new Error("Invalid command node");
    const currentPath = `${path} ${String(node.name)}`.trim();
    const config = node.config;
    if (object(config) && Array.isArray(config.flags))
      for (const flag of config.flags) {
        let current: unknown = flag;
        let optional = false;
        for (let depth = 0; depth < 16 && object(current); depth += 1) {
          if (current._tag === "Optional") optional = true;
          if (current._tag === "Single") {
            if (object(current.primitiveType) && current.primitiveType._tag === "Boolean") {
              result.booleans += 1;
              if (!optional) result.required.push(`${currentPath} --${String(current.name)}`);
            }
            break;
          }
          current = current.param;
        }
      }
    if (Array.isArray(node.subcommands))
      for (const group of node.subcommands) {
        if (object(group) && Array.isArray(group.commands))
          for (const child of group.commands) visit(child, currentPath);
      }
  };
  visit(root, "");
  return result;
};

it("every tool command tree makes boolean flags optional", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    bin: Record<string, string>;
  };
  const directories = [...new Set(Object.values(packageJson.bin).map((entry) => dirname(entry)))];
  const trees = await Promise.all(
    directories.map(async (directory) => {
      const module = await import(pathToFileURL(resolve(directory, "main.ts")).href);
      return inspect(module.mainCommand);
    }),
  );
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
