import { describe, expect, it } from "vitest";

import {
  normalizeProfilePrerequisites,
  resolveEnvironmentScopedPrerequisites,
  resolveProfilePrerequisites,
} from "#shared/prerequisites/config";

describe("normalizeProfilePrerequisites", () => {
  it("turns vpn sugar into a canonical VPN prerequisite", () => {
    expect(normalizeProfilePrerequisites({ vpn: "exampleVpn" })).toEqual([
      { type: "vpn", key: "exampleVpn" },
    ]);
  });

  it("does not duplicate vpn sugar when the same prerequisite already exists", () => {
    expect(
      normalizeProfilePrerequisites({
        vpn: "exampleVpn",
        prerequisites: [{ type: "vpn", key: "exampleVpn", cleanup: "stop-if-started" }],
      }),
    ).toEqual([{ type: "vpn", key: "exampleVpn", cleanup: "stop-if-started" }]);
  });
});

describe("resolveEnvironmentScopedPrerequisites", () => {
  it("inherits profile prerequisites when the environment does not declare any", () => {
    expect(
      resolveEnvironmentScopedPrerequisites({ vpn: "profileVpn" }, {
        host: "db.internal",
      } as never),
    ).toEqual({ vpn: "profileVpn" });
  });

  it("uses only environment prerequisites when vpn is declared", () => {
    expect(
      resolveEnvironmentScopedPrerequisites(
        { vpn: "profileVpn", prerequisites: [{ type: "vpn", key: "profileVpn" }] },
        { vpn: "envVpn" },
      ),
    ).toEqual({ vpn: "envVpn" });
  });

  it("treats empty environment prerequisites as an explicit override", () => {
    expect(
      resolveEnvironmentScopedPrerequisites(
        { vpn: "profileVpn", prerequisites: [{ type: "vpn", key: "profileVpn" }] },
        { prerequisites: [] },
      ),
    ).toEqual({ prerequisites: [] });
  });
});

describe("resolveProfilePrerequisites", () => {
  it("validates referenced VPN keys", () => {
    const result = resolveProfilePrerequisites(
      { vpns: { exampleVpn: { name: "ExampleVPN" } } },
      { prerequisites: [{ type: "vpn", key: "exampleVpn" }] },
    );

    expect(result).toEqual({ success: true, prerequisites: [{ type: "vpn", key: "exampleVpn" }] });
  });

  it("fails with an actionable hint when the VPN key is missing", () => {
    const result = resolveProfilePrerequisites({}, { vpn: "exampleVpn" });

    expect(result).toEqual({
      success: false,
      error: 'VPN prerequisite "exampleVpn" is not defined.',
      hint: "Add vpns.exampleVpn to agent-tools.json5 or remove the prerequisite.",
    });
  });
});
