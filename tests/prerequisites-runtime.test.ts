// Synchronous node:fs temp directory setup keeps per-test runtime isolation deterministic;
// cleanup must complete before the next test restores AGENT_TOOLS_RUNTIME_DIR.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach, it as vitestIt } from "vitest";

import { joinPath } from "#shared/path";
import { runWithProfilePrerequisites } from "#shared/prerequisites/runtime";

const vpnName = "ExampleVPN";

const getTempRoot = () => process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

type BunEnvTestGlobal = typeof globalThis & {
  Bun?: { env: NodeJS.ProcessEnv; hash: (input: string) => number | bigint };
};

const testHash = (input: string) => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
};

(globalThis as BunEnvTestGlobal).Bun ??= {
  env: process.env,
  hash: testHash,
} as unknown as typeof Bun;

let runtimeDir: string | undefined;
let previousRuntimeDir: string | undefined;

beforeEach(() => {
  previousRuntimeDir = process.env.AGENT_TOOLS_RUNTIME_DIR;
  runtimeDir = mkdtempSync(joinPath(getTempRoot(), "agent-tools-prerequisites-runtime-"));
  process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeDir;
  Bun.env.AGENT_TOOLS_RUNTIME_DIR = runtimeDir;
});

afterEach(() => {
  if (previousRuntimeDir === undefined) {
    delete process.env.AGENT_TOOLS_RUNTIME_DIR;
    delete Bun.env.AGENT_TOOLS_RUNTIME_DIR;
  } else {
    process.env.AGENT_TOOLS_RUNTIME_DIR = previousRuntimeDir;
    Bun.env.AGENT_TOOLS_RUNTIME_DIR = previousRuntimeDir;
  }

  if (runtimeDir !== undefined) {
    rmSync(runtimeDir, { recursive: true, force: true });
  }

  runtimeDir = undefined;
  previousRuntimeDir = undefined;
});

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

const getVpnLockPath = () => {
  if (runtimeDir === undefined) {
    throw new Error("runtimeDir is not set");
  }

  const driverIdentity =
    process.platform === "darwin"
      ? { type: "macos-scutil", platform: "darwin", serviceName: vpnName }
      : process.platform === "linux"
        ? { type: "linux-nmcli", platform: "linux", connectionName: vpnName }
        : { type: "windows-rasdial", platform: "win32", entryName: vpnName };
  const key = Bun.hash(JSON.stringify(driverIdentity)).toString(16);
  return joinPath(runtimeDir, "vpn-prerequisites", key, "lock");
};

describe("joinPath", () => {
  vitestIt("preserves root path when joining absolute root segments", () => {
    expect(joinPath("/", "agent-tools")).toBe("/agent-tools");
    expect(joinPath("/", "agent-tools", "runtime")).toBe("/agent-tools/runtime");
    expect(joinPath("/")).toBe("/");
  });
});

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

  vitestIt("does not delete a fresh ownerless VPN lease lock while waiting", async () => {
    const observedCommands: string[] = [];
    const expected = expectedVpnCommands();
    const lockPath = getVpnLockPath();
    mkdirSync(lockPath, { recursive: true });

    const resultPromise = Effect.runPromise(
      runWithProfilePrerequisites(
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
            return Effect.succeed({ stdout: connectedOutput(), stderr: "", exitCode: 0 });
          }

          return Effect.fail(new Error(`unexpected command: ${label}`));
        },
        Effect.succeed("ok"),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(observedCommands).toEqual([]);
    expect(existsSync(lockPath)).toBe(true);

    rmSync(lockPath, { recursive: true, force: true });

    const result = await resultPromise;
    expect(result).toBe("ok");
    expect(observedCommands).toEqual([expected.status]);
  });

  it.effect("cleans up earlier VPN leases when a later prerequisite fails", () => {
    const observedCommands: string[] = [];
    const laterObservedCommands: string[] = [];
    let connected = false;
    let operationRan = false;
    const expected = expectedVpnCommands();

    const runCommand = (commands: string[]) => (_command: unknown, label: string) => {
      commands.push(label);

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
    };

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
        {
          prerequisites: [
            { type: "vpn", key: "workVpn" },
            { type: "vpn", key: "missingVpn" },
          ],
        },
        runCommand(observedCommands),
        Effect.sync(() => {
          operationRan = true;
          return "should-not-run";
        }),
      ).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.failure)).toContain('VPN prerequisite "missingVpn" is not defined');
      }
      expect(operationRan).toBe(false);
      expect(connected).toBe(false);
      expect(observedCommands).toEqual([
        expected.status,
        expected.start,
        expected.status,
        expected.stop,
      ]);

      connected = true;
      const laterResult = yield* runWithProfilePrerequisites(
        {
          vpns: {
            workVpn: {
              name: vpnName,
            },
          },
        },
        { vpn: "workVpn" },
        runCommand(laterObservedCommands),
        Effect.succeed("ok"),
      );

      expect(laterResult).toBe("ok");
      expect(connected).toBe(true);
      expect(laterObservedCommands).toEqual([expected.status]);
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
