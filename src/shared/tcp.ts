// node:net, not Bun.connect: vitest runs under Node, where the Bun globals do not exist, and the
// suite reaches this module. See AGENTS.md.
import { createConnection } from "node:net";

export const isTcpPortOpen = (host: string, port: number, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });

    const settle = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
