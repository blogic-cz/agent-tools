import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { expect, it } from "vitest";

it("recommends a typed error factory exported by the installed Effect version", async () => {
  const prompt = await readFile(
    new URL("../.github/prompts/code-review.md", import.meta.url),
    "utf8",
  );
  const rule = prompt.split("\n").find((line) => line.includes("for typed errors"));
  expect(rule).toBeDefined();
  const factory = rule?.match(/`Schema\.(\w+)`/)?.[1];
  expect(factory).toBeDefined();
  expect(Object.hasOwn(Schema, factory ?? "")).toBe(true);
});
