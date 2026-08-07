import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";

import { isTcpPortOpen } from "#shared/tcp";

const listenOnEphemeralPort = (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, port });
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

describe("isTcpPortOpen", () => {
  it("reports an open port", async () => {
    const { server, port } = await listenOnEphemeralPort();

    try {
      await expect(isTcpPortOpen("127.0.0.1", port, 1000)).resolves.toBe(true);
    } finally {
      await close(server);
    }
  });

  it("reports a closed port", async () => {
    const { server, port } = await listenOnEphemeralPort();
    await close(server);

    await expect(isTcpPortOpen("127.0.0.1", port, 1000)).resolves.toBe(false);
  });

  it("reports false instead of throwing on an unroutable address", async () => {
    await expect(isTcpPortOpen("192.0.2.1", 5432, 200)).resolves.toBe(false);
  });
});
