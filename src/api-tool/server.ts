import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createProxy } from "./proxy";
import { pinnedTransport } from "./transport";
import type { Transport } from "./transport";
import { apiError, safeError } from "./errors";
import { claimGrants, readPrivateFile, readSecretStore } from "./store";
import { validateOperator } from "./types";
import type { OperatorConfig } from "./types";

export function createRequestHandler(proxy: ReturnType<typeof createProxy>, maxConcurrent: number) {
  let active = 0;
  return (request: IncomingMessage, response: ServerResponse): void => {
    const failure = (error: unknown): void => {
      if (!response.destroyed) {
        response.writeHead(400, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ code: safeError(error).code }));
      }
    };
    if (
      request.method !== "POST" ||
      request.url !== "/request" ||
      request.headers["content-type"] !== "application/json" ||
      request.headers["content-encoding"] !== undefined ||
      active >= maxConcurrent
    ) {
      request.resume();
      failure(apiError("POLICY_DENIED"));
      return;
    }
    const auth = request.headers.authorization;
    if (!auth || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(auth)) {
      request.resume();
      failure(apiError("UNAUTHORIZED"));
      return;
    }
    try {
      proxy.authorize(auth.slice(7));
    } catch (error) {
      request.resume();
      failure(error);
      return;
    }
    active++;
    const run = async (): Promise<void> => {
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 1_000_000) throw apiError("LIMIT_EXCEEDED");
          chunks.push(buffer);
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw apiError("CONFIG_INVALID");
        }
        const serialized = await proxy.requestSerialized(auth.slice(7), input);
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(serialized);
      } catch (error) {
        failure(error);
      } finally {
        active--;
      }
    };
    void run();
  };
}

export async function startProxy(configValue: unknown, transport: Transport = pinnedTransport) {
  const config: OperatorConfig = validateOperator(configValue);
  const secrets = await readSecretStore(config.secretsFile);
  const proxy = createProxy({ config, secrets, transport });
  const handler = createRequestHandler(proxy, config.maxConcurrent);
  const server =
    config.listen.kind === "tls"
      ? createHttpsServer(
          {
            cert: await readPrivateFile(config.listen.certFile),
            key: await readPrivateFile(config.listen.keyFile),
            minVersion: "TLSv1.2",
          },
          handler,
        )
      : createHttpServer(handler);
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.timeout = 70000;
  server.maxConnections = config.maxConcurrent * 2;
  await claimGrants(config);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.listen.port, config.listen.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch {
    throw apiError("CONFIG_INVALID");
  }
  return server;
}
