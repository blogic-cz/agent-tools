import type { VpnConfig, VpnDriverConfig } from "#config/types";
import type {
  ResolvedVpnDriver,
  SupportedPlatform,
  VpnDriverResolution,
} from "#shared/prerequisites/types";

const isSupportedPlatform = (platform: NodeJS.Platform): platform is SupportedPlatform =>
  platform === "darwin" || platform === "linux" || platform === "win32";

const resolveExplicitDriver = (
  config: VpnConfig,
  platform: SupportedPlatform,
  driver: VpnDriverConfig,
): VpnDriverResolution => {
  if (driver.type === "macos-scutil") {
    if (platform !== "darwin") {
      return {
        success: false,
        error: `VPN driver "${driver.type}" is not supported on ${platform}.`,
        hint: "Configure a driver for the current OS or enable auto detection.",
      };
    }

    return {
      success: true,
      driver: { platform, type: driver.type, serviceName: driver.serviceName ?? config.name },
    };
  }

  if (driver.type === "linux-nmcli") {
    if (platform !== "linux") {
      return {
        success: false,
        error: `VPN driver "${driver.type}" is not supported on ${platform}.`,
        hint: "Configure a driver for the current OS or enable auto detection.",
      };
    }

    return {
      success: true,
      driver: { platform, type: driver.type, connectionName: driver.connectionName ?? config.name },
    };
  }

  if (driver.type === "windows-rasdial") {
    if (platform !== "win32") {
      return {
        success: false,
        error: `VPN driver "" is not supported on .`,
        hint: "Configure a driver for the current OS or enable auto detection.",
      };
    }

    return {
      success: true,
      driver: { platform, type: driver.type, entryName: driver.entryName ?? config.name },
    };
  }

  const exhaustive: never = driver;
  return exhaustive;
};

export function resolveVpnDriverConfig(
  config: VpnConfig,
  platform: NodeJS.Platform = process.platform,
): VpnDriverResolution {
  if (!isSupportedPlatform(platform)) {
    return {
      success: false,
      error: `VPN auto detection is not supported on ${platform}.`,
      hint: "Configure an explicit supported VPN driver for this platform.",
    };
  }

  const platformDriver = config.drivers?.[platform];
  if (platformDriver) {
    return resolveExplicitDriver(config, platform, platformDriver);
  }

  if (config.driver) {
    return resolveExplicitDriver(config, platform, config.driver);
  }

  const auto = config.auto ?? true;
  if (!auto) {
    return {
      success: false,
      error: "VPN auto detection is disabled, but no driver is configured for this platform.",
      hint: `Add vpns.<key>.drivers.${platform} or enable auto detection.`,
    };
  }

  if (platform === "darwin") {
    return { success: true, driver: { platform, type: "macos-scutil", serviceName: config.name } };
  }

  if (platform === "linux") {
    return {
      success: true,
      driver: { platform, type: "linux-nmcli", connectionName: config.name },
    };
  }

  return { success: true, driver: { platform, type: "windows-rasdial", entryName: config.name } };
}

export function missingVpnToolHint(driver: ResolvedVpnDriver): string {
  if (driver.type === "macos-scutil") {
    return "scutil was not found or is unavailable. Ensure macOS system tools are available and the VPN service name matches the Network service name.";
  }

  if (driver.type === "linux-nmcli") {
    return "nmcli was not found. Install or enable NetworkManager CLI, or configure an explicit supported VPN driver.";
  }

  return "rasdial was not found or is unavailable. Ensure Windows RAS tooling is available and the VPN entry name matches the configured connection.";
}
