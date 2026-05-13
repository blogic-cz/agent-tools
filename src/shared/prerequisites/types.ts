import type { Effect } from "effect";
import type { ChildProcess } from "effect/unstable/process";

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

export type PrerequisiteCommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type PrerequisiteCommandRunner<E> = (
  command: ChildProcess.Command,
  label: string,
) => Effect.Effect<PrerequisiteCommandResult, E, never>;
