import { describe, expect, it } from "vitest";

import {
  normalizeProfilePrerequisites,
  resolveProfilePrerequisites,
} from "#shared/prerequisites/config";

describe("normalizeProfilePrerequisites", () => {
  it("turns vpn sugar into a canonical VPN prerequisite", () => {
    expect(normalizeProfilePrerequisites({ vpn: "blogic" })).toEqual([
      { type: "vpn", key: "blogic" },
    ]);
  });

  it("does not duplicate vpn sugar when the same prerequisite already exists", () => {
    expect(
      normalizeProfilePrerequisites({
        vpn: "blogic",
        prerequisites: [{ type: "vpn", key: "blogic", cleanup: "stop-if-started" }],
      }),
    ).toEqual([{ type: "vpn", key: "blogic", cleanup: "stop-if-started" }]);
  });
});

describe("resolveProfilePrerequisites", () => {
  it("validates referenced VPN keys", () => {
    const result = resolveProfilePrerequisites(
      { vpns: { blogic: { name: "BLVPN" } } },
      { prerequisites: [{ type: "vpn", key: "blogic" }] },
    );

    expect(result).toEqual({ success: true, prerequisites: [{ type: "vpn", key: "blogic" }] });
  });

  it("fails with an actionable hint when the VPN key is missing", () => {
    const result = resolveProfilePrerequisites({}, { vpn: "blogic" });

    expect(result).toEqual({
      success: false,
      error: 'VPN prerequisite "blogic" is not defined.',
      hint: "Add vpns.blogic to agent-tools.json5 or remove the prerequisite.",
    });
  });
});
