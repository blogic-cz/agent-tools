import { mock } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as Cli from "effect/cli";
import * as PlatformBun from "@effect/platform-bun";
import { Effect } from "effect";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const results: Array<{ tool: string; booleans: number; required: string[] }> = [];
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
  results.push(result);
};
mock.module("effect/cli", () => ({
  ...Cli,
  Command: {
    ...Cli.Command,
    run: (root: unknown) => {
      inspect(root);
      return Effect.void;
    },
  },
}));
mock.module("@effect/platform-bun", () => ({
  ...PlatformBun,
  BunRuntime: {
    ...PlatformBun.BunRuntime,
    runMain: () => undefined,
  },
}));
const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  bin: Record<string, string>;
};
const directories = [...new Set(Object.values(packageJson.bin).map((entry) => dirname(entry)))];
await Promise.all(
  directories.map((directory) => import(pathToFileURL(resolve(directory, "main.ts")).href)),
);
console.log(JSON.stringify(results));
