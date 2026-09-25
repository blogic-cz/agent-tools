import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";

it("accepts the Effect peer range and reports incompatible or missing versions", () => {
  const result = spawnSync(
    "bun",
    [
      "-e",
      `import { effectVersionError } from "./src/shared/effect-version.ts";
console.log(JSON.stringify({
  valid: effectVersionError("4.0.0-rc.117") ?? null,
  incompatible: effectVersionError("4.0.0-beta.105"),
  missing: effectVersionError(undefined),
}));`,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    valid: null,
    incompatible:
      "agent-tools requires effect ^4.0.0-rc.117 but found 4.0.0-beta.105; install a matching effect version",
    missing:
      "agent-tools requires effect ^4.0.0-rc.117 but could not resolve the installed effect package; install a matching effect version",
  });
});

it("resolves a compatible Effect installation from the guard module", () => {
  const result = spawnSync(
    "bun",
    [
      "-e",
      `import { checkEffectVersion } from "./src/shared/effect-version.ts";
console.log(await checkEffectVersion());`,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim()).toBe("true");
});
