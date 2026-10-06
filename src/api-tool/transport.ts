import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { apiError } from "./errors";

export type TransportRequest = {
  url: URL;
  method: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  maxBytes: number;
  signal: AbortSignal;
  allowedPrivateAddresses: readonly string[];
  developmentLoopback?: boolean;
};
export type TransportResult = { status: number; body: string };
export type Transport = (request: TransportRequest) => Promise<TransportResult>;
export type Resolver = (host: string) => Promise<readonly { address: string; family: number }[]>;

export function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(apiError("DEADLINE_EXCEEDED"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(apiError("DEADLINE_EXCEEDED"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        return resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        return reject(error);
      },
    );
  });
}

export function allowedAddress(
  address: string,
  privateAllow: readonly string[],
  developmentLoopback = false,
): boolean {
  if (developmentLoopback && address === "127.0.0.1") return true;
  const family = isIP(address);
  if (!family) return false;
  if (family === 6) {
    const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
    if (
      normalized.startsWith("::ffff:") ||
      normalized.startsWith("fe80:") ||
      normalized === "fd00:ec2::254"
    )
      return false;
    if (privateAllow.includes(normalized)) return true;
    return (
      /^[23][0-9a-f]{3}:/.test(normalized) &&
      !/^200[12]:/.test(normalized) &&
      !normalized.startsWith("3fff:")
    );
  }
  const parts = address.split(".").map(Number);
  const [a = 0, b = 0] = parts;
  if ((a === 169 && b === 254) || address === "168.63.129.16" || a === 0 || a >= 224) return false;
  if (privateAllow.includes(address)) return true;
  return !(
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function makePinnedTransport(
  resolve: Resolver = (host) => lookup(host, { all: true, verbatim: true }),
): Transport {
  return async (input) => {
    const host = input.url.hostname.replace(/^\[|\]$/g, "");
    if (
      input.url.protocol !== "https:" &&
      !(input.developmentLoopback && input.url.protocol === "http:" && host === "127.0.0.1")
    )
      throw apiError("DESTINATION_DENIED");
    let addresses: Awaited<ReturnType<Resolver>>;
    try {
      addresses = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await beforeAbort(resolve(host), input.signal);
    } catch {
      throw apiError(input.signal.aborted ? "DEADLINE_EXCEEDED" : "DESTINATION_DENIED");
    }
    if (input.signal.aborted) throw apiError("DEADLINE_EXCEEDED");
    const pinned = addresses[0];
    if (
      !pinned ||
      addresses.some(
        (item) =>
          !allowedAddress(item.address, input.allowedPrivateAddresses, input.developmentLoopback),
      )
    )
      throw apiError("DESTINATION_DENIED");
    return new Promise((resolveResult, reject) => {
      const request = (input.url.protocol === "https:" ? httpsRequest : httpRequest)(
        input.url,
        {
          method: input.method,
          headers: input.headers,
          signal: input.signal,
          agent: false,
          family: pinned.family,
          rejectUnauthorized: true,
          lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(apiError("DESTINATION_DENIED"));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > input.maxBytes) {
              response.destroy();
              reject(apiError("LIMIT_EXCEEDED"));
            } else chunks.push(chunk);
          });
          response.on("error", () => reject(apiError("UPSTREAM_FAILED")));
          response.on("end", () =>
            resolveResult({ status, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      request.on("error", () =>
        reject(apiError(input.signal.aborted ? "DEADLINE_EXCEEDED" : "UPSTREAM_FAILED")),
      );
      request.end(input.body);
    });
  };
}
export const pinnedTransport = makePinnedTransport();
