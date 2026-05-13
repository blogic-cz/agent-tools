import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { runWithProfilePrerequisites } from "#shared/prerequisites/runtime";

const vpnName = "ExampleVPN";

const expectedVpnCommands = () => {
  if (process.platform === "darwin") {
    return {
      status: `scutil --nc status ${vpnName}`,
      start: `scutil --nc start ${vpnName}`,
      stop: `scutil --nc stop ${vpnName}`,
    };
  }

  if (process.platform === "linux") {
    return {
      status: "nmcli -t -f NAME connection show --active",
      start: `nmcli connection up ${vpnName}`,
      stop: `nmcli connection down ${vpnName}`,
    };
  }

  return {
    status: "rasdial",
    start: `rasdial ${vpnName}`,
    stop: `rasdial ${vpnName} /disconnect`,
  };
};

const connectedOutput = () => {
  if (process.platform === "darwin") {
    return "Connected\n";
  }

  if (process.platform === "linux") {
    return `${vpnName}\n`;
  }

  return `${vpnName}\n`;
};

describe("runWithProfilePrerequisites", () => {
  it.effect("starts and stops a disconnected VPN prerequisite around the operation", () => {
    const observedCommands: string[] = [];
    let connected = false;
    const expected = expectedVpnCommands();

    return Effect.gen(function* () {
      const result = yield* runWithProfilePrerequisites(
        {
          vpns: {
            workVpn: {
              name: vpnName,
              connectTimeoutMs: 1000,
            },
          },
        },
        { vpn: "workVpn" },
        (_command, label) => {
          observedCommands.push(label);

          if (label === expected.status) {
            return Effect.succeed({
              stdout: connected ? connectedOutput() : "Disconnected\n",
              stderr: "",
              exitCode: 0,
            });
          }

          if (label === expected.start) {
            connected = true;
            return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
          }

          if (label === expected.stop) {
            connected = false;
            return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
          }

          return Effect.fail(new Error(`unexpected command: ${label}`));
        },
        Effect.succeed("ok"),
      );

      expect(result).toBe("ok");
      expect(observedCommands).toEqual([
        expected.status,
        expected.start,
        expected.status,
        expected.stop,
      ]);
    });
  });

  it.effect("leaves an already connected VPN running", () => {
    const observedCommands: string[] = [];
    const expected = expectedVpnCommands();

    return Effect.gen(function* () {
      const result = yield* runWithProfilePrerequisites(
        {
          vpns: {
            workVpn: {
              name: vpnName,
            },
          },
        },
        { vpn: "workVpn" },
        (_command, label) => {
          observedCommands.push(label);

          if (label === expected.status) {
            return Effect.succeed({ stdout: connectedOutput(), stderr: "", exitCode: 0 });
          }

          return Effect.fail(new Error(`unexpected command: ${label}`));
        },
        Effect.succeed("ok"),
      );

      expect(result).toBe("ok");
      expect(observedCommands).toEqual([expected.status]);
    });
  });

  it.effect("skips VPN commands when the operation already succeeds", () => {
    const observedCommands: string[] = [];

    return Effect.gen(function* () {
      const result = yield* runWithProfilePrerequisites(
        {
          vpns: {
            workVpn: {
              name: vpnName,
            },
          },
        },
        { vpn: "workVpn" },
        (_command, label) => {
          observedCommands.push(label);
          return Effect.fail(new Error(`unexpected command: ${label}`));
        },
        Effect.succeed("ok"),
        { tryWithoutPrerequisites: true },
      );

      expect(result).toBe("ok");
      expect(observedCommands).toEqual([]);
    });
  });

  it.effect("retries the operation when fallback prerequisites fail after a direct miss", () => {
    const observedCommands: string[] = [];
    const expected = expectedVpnCommands();
    let attempts = 0;

    const operation = Effect.try({
      try: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("direct miss");
        }
        return "ok";
      },
      catch: (error) => error as Error,
    });

    return Effect.gen(function* () {
      const result = yield* runWithProfilePrerequisites(
        {
          vpns: {
            workVpn: {
              name: vpnName,
              connectTimeoutMs: 0,
            },
          },
        },
        { vpn: "workVpn" },
        (_command, label) => {
          observedCommands.push(label);

          if (label === expected.status) {
            return Effect.succeed({ stdout: "Disconnected\n", stderr: "", exitCode: 0 });
          }

          if (label === expected.start) {
            return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
          }

          return Effect.fail(new Error(`unexpected command: ${label}`));
        },
        operation,
        { tryWithoutPrerequisites: true },
      );

      expect(result).toBe("ok");
      expect(attempts).toBe(2);
      expect(observedCommands).toEqual([expected.status, expected.start, expected.status]);
    });
  });
});
