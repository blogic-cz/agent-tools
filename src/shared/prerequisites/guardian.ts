import type { SanitizedVpnDriver } from "#shared/prerequisites/store";
import { VpnStore } from "#shared/prerequisites/store";
import { parseVpnStatus, vpnCommandSpec } from "#shared/prerequisites/driver-commands";
import type { VpnCleanupPolicy } from "#shared/prerequisites/types";

export type GuardianInitMessage = {
  readonly type: "INIT";
  readonly driver: SanitizedVpnDriver;
  readonly runtimeRoot: string;
  readonly leaseId: string;
  readonly guardianId: string;
  readonly ownerPid: number;
  readonly cleanup: VpnCleanupPolicy;
  readonly idleDisconnectMs: number;
  readonly disconnectTimeoutMs: number;
};
export type GuardianReleaseMessage = { readonly type: "RELEASE"; readonly leaseId: string };
export type GuardianInboundMessage = GuardianInitMessage | GuardianReleaseMessage;
export type GuardianOutboundMessage =
  | { readonly type: "READY"; readonly leaseId: string; readonly guardianId: string }
  | { readonly type: "RELEASED"; readonly leaseId: string }
  | { readonly type: "ERROR"; readonly message: string };

export type GuardianCommandRunner = (
  action: "status" | "stop",
  timeoutMs: number,
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

const safeEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

export const makeGuardianCommandRunner =
  (driver: SanitizedVpnDriver): GuardianCommandRunner =>
  async (action, timeoutMs) => {
    const spec = vpnCommandSpec(driver, action);
    const child = Bun.spawn([spec.executable, ...spec.args], {
      env: safeEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { stdout, stderr, exitCode };
  };

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export async function stopWhenIdle(
  store: VpnStore,
  init: GuardianInitMessage,
  runCommand: GuardianCommandRunner,
  now: () => number = Date.now,
): Promise<void> {
  const snapshot = store.snapshot();
  if (snapshot.lifecycle !== "IDLE" || snapshot.idleDeadline === null) return;
  const delay = snapshot.idleDeadline - now();
  if (delay > 0) await sleep(delay);

  const operationId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const guard = store.claimStop(operationId, token, process.pid, now());
  if (!guard) return;

  const deadline = now() + init.disconnectTimeoutMs;
  let evidence = "VPN stop did not produce confirmed disconnected status.";
  try {
    const remaining = deadline - now();
    if (remaining > 0) {
      const stop = await runCommand("stop", remaining);
      if (stop.exitCode !== 0) {
        evidence = `VPN stop command failed (exit ${stop.exitCode}); ownership is unknown and stop will not be retried.`;
      } else {
        const stillConnected =
          "VPN still reported connected after stop when the disconnect deadline expired.";
        const confirmDisconnected = async (): Promise<true | string> => {
          const statusRemaining = deadline - now();
          if (statusRemaining <= 0) {
            return "VPN stop was dispatched, but the disconnect deadline expired before status could be confirmed.";
          }
          const status = await runCommand("status", statusRemaining);
          const connected = parseVpnStatus(init.driver, status);
          if (connected === false) return true;
          if (connected === undefined) {
            return status.exitCode === 0
              ? "VPN status output after stop was unparseable; ownership is unknown."
              : `VPN status command after stop failed (exit ${status.exitCode}); ownership is unknown.`;
          }
          const sleepRemaining = deadline - now();
          if (sleepRemaining <= 0) return stillConnected;
          await sleep(Math.min(250, sleepRemaining));
          return deadline - now() > 0 ? confirmDisconnected() : stillConnected;
        };
        const confirmed = await confirmDisconnected();
        if (confirmed === true) {
          store.commitStop(guard, true, "VPN stop confirmed disconnected.", now());
          return;
        }
        evidence = confirmed;
      }
    } else {
      evidence = "VPN disconnect deadline expired before a command could safely start.";
    }
  } catch {
    evidence = "VPN stop or confirmation timed out or failed; ownership is unknown.";
  }
  store.commitStop(guard, false, evidence, now());
}

export function runGuardian(
  init: GuardianInitMessage,
  send: (message: GuardianOutboundMessage) => void,
  runCommand: GuardianCommandRunner = makeGuardianCommandRunner(init.driver),
): Promise<{ release: () => Promise<void> }> {
  return new Promise((resolve) => {
    const store = VpnStore.open(init.driver, { root: init.runtimeRoot });
    let released = false;
    store.reserveLease({
      leaseId: init.leaseId,
      guardianId: init.guardianId,
      ownerPid: init.ownerPid,
      cleanup: init.cleanup,
      now: Date.now(),
    });

    const release = async () => {
      if (released) return;
      released = true;
      try {
        const result = store.releaseLease({
          leaseId: init.leaseId,
          guardianId: init.guardianId,
          idleDisconnectMs: init.idleDisconnectMs,
          now: Date.now(),
        });
        const stop =
          result.released && result.deadline !== null
            ? stopWhenIdle(store, init, runCommand)
            : undefined;
        if (stop && init.idleDisconnectMs === 0) await stop;
        send({ type: "RELEASED", leaseId: init.leaseId });
        if (stop && init.idleDisconnectMs > 0) await stop;
      } finally {
        store.close();
      }
    };

    resolve({ release });
  });
}
