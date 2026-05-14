import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { runWithProfilePrerequisites } from "#shared/prerequisites/runtime";

const vpnName = "ExampleVPN";

type BunEnvTestGlobal = typeof globalThis & { Bun?: { env: NodeJS.ProcessEnv } };

(globalThis as BunEnvTestGlobal).Bun ??= { env: process.env } as unknown as typeof Bun;

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

  if (process.platform === "darwin") {
    it.effect("passes macOS VPN shared secrets from configured env vars", () => {
      const observedCommands: string[] = [];
      const previousSecret = process.env.TEST_VPN_SECRET;
      process.env.TEST_VPN_SECRET = "vpn-secret";

      return Effect.gen(function* () {
        try {
          const result = yield* runWithProfilePrerequisites(
            {
              vpns: {
                workVpn: {
                  name: vpnName,
                  auto: false,
                  connectTimeoutMs: 1000,
                  driver: { type: "macos-scutil", secretEnvVar: "TEST_VPN_SECRET" },
                },
              },
            },
            { vpn: "workVpn" },
            (_command, label) => {
              observedCommands.push(label);

              if (label === `scutil --nc status ${vpnName}`) {
                const isConnected = observedCommands.some((command) =>
                  command.includes("--secret <redacted>"),
                );
                return Effect.succeed({
                  stdout: isConnected ? "Connected\n" : "Disconnected\n",
                  stderr: "",
                  exitCode: 0,
                });
              }

              if (label === `scutil --nc start ${vpnName} --secret <redacted>`) {
                return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
              }

              if (label === `scutil --nc stop ${vpnName}`) {
                return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
              }

              return Effect.fail(new Error(`unexpected command: ${label}`));
            },
            Effect.succeed("ok"),
          );

          expect(result).toBe("ok");
          expect(observedCommands).toContain(`scutil --nc start ${vpnName} --secret <redacted>`);
          expect(observedCommands.join("\n")).not.toContain("vpn-secret");
        } finally {
          if (previousSecret === undefined) {
            delete process.env.TEST_VPN_SECRET;
          } else {
            process.env.TEST_VPN_SECRET = previousSecret;
          }
        }
      });
    });

    it.effect("fails fast when a configured VPN secret env var is missing", () => {
      const previousSecret = process.env.TEST_MISSING_VPN_SECRET;
      delete process.env.TEST_MISSING_VPN_SECRET;

      return Effect.gen(function* () {
        try {
          const error = yield* Effect.flip(
            runWithProfilePrerequisites(
              {
                vpns: {
                  workVpn: {
                    name: vpnName,
                    auto: false,
                    driver: { type: "macos-scutil", secretEnvVar: "TEST_MISSING_VPN_SECRET" },
                  },
                },
              },
              { vpn: "workVpn" },
              (_command, label) => {
                if (label === `scutil --nc status ${vpnName}`) {
                  return Effect.succeed({ stdout: "Disconnected\n", stderr: "", exitCode: 0 });
                }

                return Effect.fail(new Error(`unexpected command: ${label}`));
              },
              Effect.succeed("ok"),
            ),
          );

          expect(String(error)).toContain("TEST_MISSING_VPN_SECRET");
        } finally {
          if (previousSecret !== undefined) {
            process.env.TEST_MISSING_VPN_SECRET = previousSecret;
          }
        }
      });
    });
  }

  it.effect("returns the direct retry error when fallback prerequisites fail", () => {
    const observedCommands: string[] = [];
    const expected = expectedVpnCommands();
    let attempts = 0;

    const operation = Effect.try({
      try: () => {
        attempts += 1;
        throw new Error(`direct miss ${attempts}`);
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
      ).pipe(Effect.result);

      expect(attempts).toBe(2);
      expect(observedCommands).toEqual([expected.status, expected.start, expected.status]);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(Error);
        expect((result.failure as Error).message).toBe("direct miss 2");
      }
    });
  });
});
