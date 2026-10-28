import { expect, it } from "vitest";
import { effectVersionError, checkEffectVersion } from "#shared/effect-version";

it("accepts the Effect peer range and reports incompatible or missing versions", () => {
  expect(effectVersionError("4.0.5")).toBeUndefined();
  expect(effectVersionError("4.0.0-beta.105")).toBe(
    "agent-tools requires effect ^4.0.5 but found 4.0.0-beta.105; install a matching effect version",
  );
  expect(effectVersionError(undefined)).toBe(
    "agent-tools requires effect ^4.0.5 but could not resolve the installed effect package; install a matching effect version",
  );
});

it("resolves a compatible Effect installation from the guard module", async () => {
  expect(await checkEffectVersion()).toBe(true);
});
