import { vi } from "vitest";
import childProcess from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
const blocked = ((input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return Promise.reject(
    new Error(
      `Unit test attempted a real network request to ${url}. ` +
        `Route the call through GitHubService so the mock layer covers it, or stub globalThis.fetch in the test.`,
    ),
  );
}) as typeof globalThis.fetch;

globalThis.fetch = blocked;

function refuseProcess() {
  throw new Error(
    "Unit test attempted to start a real process. Inject the external process runner.",
  );
}
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("node:child_process")),
  spawn: refuseProcess,
  spawnSync: refuseProcess,
  exec: refuseProcess,
  execSync: refuseProcess,
  execFile: refuseProcess,
  execFileSync: refuseProcess,
  fork: refuseProcess,
}));
function refuseSocket(): never {
  throw new Error("Unit test attempted a real socket. Inject the transport boundary.");
}
Object.assign(Bun, {
  spawn: refuseProcess,
  spawnSync: refuseProcess,
  $: refuseProcess,
  connect: refuseSocket,
  listen: refuseSocket,
  serve: refuseSocket,
});
Object.assign(childProcess, {
  spawn: refuseProcess,
  spawnSync: refuseProcess,
  exec: refuseProcess,
  execSync: refuseProcess,
  execFile: refuseProcess,
  execFileSync: refuseProcess,
  fork: refuseProcess,
});
net.Server.prototype.listen = refuseSocket;
net.Socket.prototype.connect = refuseSocket;
tls.connect = refuseSocket;
dgram.Socket.prototype.bind = refuseSocket;
dgram.Socket.prototype.connect = refuseSocket;
syncBuiltinESMExports();
