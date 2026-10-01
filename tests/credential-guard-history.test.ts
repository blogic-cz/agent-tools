import { describe, expect, it } from "vitest";
import { createCredentialGuard, isDangerousBashCommand } from "#guard";
import history from "./fixtures/credential-guard-history.json";

// These strings are policy inputs. Never execute the represented commands.
describe("credential guard archived command history", () => {
  it("keeps every authoritative case exactly once", () => {
    expect(history).toHaveLength(46);
    expect(new Set(history.map(({ command }) => command)).size).toBe(46);
    expect(history.map(({ id }) => id)).toEqual(
      Array.from({ length: 46 }, (_, index) => `history${String(index + 1).padStart(2, "0")}`),
    );
  });

  it.each(history)("$id: $label", (fixture) => {
    const guard = createCredentialGuard({
      allowedEnvironmentVariables: fixture.allowedEnvironmentVariables ?? [],
      additionalBlockedPaths: fixture.additionalBlockedPaths ?? [],
    });
    expect(guard.isDangerousBashCommand(fixture.command)).toBe(!fixture.expectedAllowed);
    expect(guard.getBlockedCliTool(fixture.command)?.name ?? null).toBe(
      fixture.expectedBlockedCliTool,
    );
    if (!fixture.allowedEnvironmentVariables && !fixture.additionalBlockedPaths) {
      expect(isDangerousBashCommand(fixture.command)).toBe(!fixture.expectedAllowed);
    }
    const invoke = () =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: fixture.command } });
    if (fixture.expectedAllowed) expect(invoke).not.toThrow();
    else expect(invoke).toThrow();
  });
});
