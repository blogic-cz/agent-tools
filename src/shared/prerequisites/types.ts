import type {
  LinuxNmcliVpnDriverConfig,
  MacosScutilVpnDriverConfig,
  VpnPrerequisite,
  WindowsRasdialVpnDriverConfig,
} from "#config/types";

export type PrerequisiteResolution =
  | { success: true; prerequisites: readonly VpnPrerequisite[] }
  | { success: false; error: string; hint: string };

export type SupportedPlatform = "darwin" | "linux" | "win32";

export type ResolvedVpnDriver =
  | (Required<MacosScutilVpnDriverConfig> & { platform: "darwin" })
  | (Required<LinuxNmcliVpnDriverConfig> & { platform: "linux" })
  | (Required<WindowsRasdialVpnDriverConfig> & { platform: "win32" });

export type VpnDriverResolution =
  | { success: true; driver: ResolvedVpnDriver }
  | { success: false; error: string; hint: string };
