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
  | (MacosScutilVpnDriverConfig & { platform: "darwin"; serviceName: string })
  | (LinuxNmcliVpnDriverConfig & { platform: "linux"; connectionName: string })
  | (WindowsRasdialVpnDriverConfig & { platform: "win32"; entryName: string });

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
