import { attemptProcess } from "../scripts/fixtures/process-probe";
import { expect, it } from "vitest";
import * as bun from "bun";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";

const capturedSpawn = Reflect.get(bun, "spawn");
const capturedShell = Reflect.get(await import("bun"), "$");
it.each([
  ["helper outside tests", attemptProcess],
  ["captured Bun spawn", () => capturedSpawn(["/bin/echo", "forbidden"])],
  ["Bun shell", () => Reflect.get(Bun, "$")`/bin/echo forbidden`],
  ["dynamic Bun shell", () => capturedShell`/bin/echo forbidden`],
  ["child process", () => Reflect.get(childProcess, "spawn")("/bin/echo")],
  ["Bun connect", () => Bun.connect({ hostname: "127.0.0.1", port: 1, socket: {} })],
  ["socket listen", () => net.createServer().listen(0)],
  ["socket connect", () => new net.Socket().connect(1, "127.0.0.1")],
  ["TLS connect", () => tls.connect(1, "127.0.0.1")],
])("refuses %s before any external operation", (_name, attempt) => {
  expect(attempt).toThrow(/Unit test attempted.*real (process|socket)/);
});
