import { ChildProcess } from "effect/unstable/process";

import type { ResolvedVpnDriver } from "#shared/prerequisites/types";
import type { SanitizedVpnDriver } from "#shared/prerequisites/store";

export type VpnDriverAction = "status" | "start" | "stop";
export type VpnCommandSpec = { readonly executable: string; readonly args: readonly string[] };

export const sanitizeVpnDriver = (driver: ResolvedVpnDriver): SanitizedVpnDriver => {
  if (driver.type === "macos-scutil") {
    return { type: driver.type, platform: driver.platform, serviceName: driver.serviceName };
  }
  if (driver.type === "linux-nmcli") {
    return { type: driver.type, platform: driver.platform, connectionName: driver.connectionName };
  }
  return { type: driver.type, platform: driver.platform, entryName: driver.entryName };
};

export const vpnCommandSpec = (
  driver: SanitizedVpnDriver,
  action: VpnDriverAction,
): VpnCommandSpec => {
  if (driver.type === "macos-scutil") {
    return {
      executable: "scutil",
      args:
        action === "status"
          ? ["--nc", "status", driver.serviceName]
          : ["--nc", action, driver.serviceName],
    };
  }
  if (driver.type === "linux-nmcli") {
    return {
      executable: "nmcli",
      args:
        action === "status"
          ? ["-t", "-e", "no", "-f", "NAME", "connection", "show", "--active"]
          : ["connection", action === "start" ? "up" : "down", driver.connectionName],
    };
  }
  return {
    executable: "rasdial",
    args:
      action === "status"
        ? []
        : action === "start"
          ? [driver.entryName]
          : [driver.entryName, "/disconnect"],
  };
};

export const makeParentVpnCommand = (
  driver: ResolvedVpnDriver,
  action: VpnDriverAction,
  secret?: string,
) => {
  const spec = vpnCommandSpec(sanitizeVpnDriver(driver), action);
  const secretArgs = action === "start" && secret ? ["--secret", secret] : [];
  const args = [...spec.args, ...secretArgs];
  const labelArgs = [...spec.args, ...(secretArgs.length > 0 ? ["--secret", "<redacted>"] : [])];
  return {
    command: ChildProcess.make(spec.executable, args, { stdout: "pipe", stderr: "pipe" }),
    label: [spec.executable, ...labelArgs].join(" "),
  };
};

export const parseVpnStatus = (
  driver: SanitizedVpnDriver,
  result: { readonly stdout: string; readonly exitCode: number },
): boolean | undefined => {
  if (result.exitCode !== 0) return undefined;
  const lines = result.stdout.split(/\r?\n/);
  if (driver.type === "macos-scutil") {
    if (lines.includes("Connected")) return true;
    if (lines.includes("Disconnected")) return false;
    return undefined;
  }
  if (driver.type === "linux-nmcli") {
    return lines.some((line) => line === driver.connectionName);
  }
  const records = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  const successFooter = "Command completed successfully.";
  if (records.at(-1) !== successFooter) return undefined;
  const body = records.slice(0, -1);
  if (body.length === 1 && body[0] === "No connections") return false;
  if (body[0] !== "Connected to" || body.length === 1) return undefined;
  return body.slice(1).includes(driver.entryName);
};
