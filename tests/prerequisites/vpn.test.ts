import { describe, expect, it } from "vitest";

import { missingVpnToolHint, resolveVpnDriverConfig } from "#shared/prerequisites/vpn";

describe("resolveVpnDriverConfig", () => {
  it("maps minimal VPN config to macos scutil on darwin", () => {
    const result = resolveVpnDriverConfig({ name: "ExampleVPN" }, "darwin");

    expect(result).toEqual({
      success: true,
      driver: { platform: "darwin", type: "macos-scutil", serviceName: "ExampleVPN" },
    });
  });

  it("maps minimal VPN config to nmcli on linux", () => {
    const result = resolveVpnDriverConfig({ name: "ExampleVPN" }, "linux");

    expect(result).toEqual({
      success: true,
      driver: { platform: "linux", type: "linux-nmcli", connectionName: "ExampleVPN" },
    });
  });

  it("maps minimal VPN config to rasdial on windows", () => {
    const result = resolveVpnDriverConfig({ name: "ExampleVPN" }, "win32");

    expect(result).toEqual({
      success: true,
      driver: { platform: "win32", type: "windows-rasdial", entryName: "ExampleVPN" },
    });
  });

  it("uses per-platform override before auto mapping", () => {
    const result = resolveVpnDriverConfig(
      {
        name: "ExampleVPN",
        drivers: { linux: { type: "linux-nmcli", connectionName: "ExampleVPN-prod" } },
      },
      "linux",
    );

    expect(result).toEqual({
      success: true,
      driver: { platform: "linux", type: "linux-nmcli", connectionName: "ExampleVPN-prod" },
    });
  });

  it("fails when auto is false without current-platform driver", () => {
    const result = resolveVpnDriverConfig({ name: "ExampleVPN", auto: false }, "darwin");

    expect(result).toEqual({
      success: false,
      error: "VPN auto detection is disabled, but no driver is configured for this platform.",
      hint: "Add vpns.<key>.drivers.darwin or enable auto detection.",
    });
  });

  it("returns actionable hints for missing platform tools", () => {
    const result = resolveVpnDriverConfig({ name: "ExampleVPN" }, "linux");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(missingVpnToolHint(result.driver)).toContain("nmcli was not found");
    }
  });
});
