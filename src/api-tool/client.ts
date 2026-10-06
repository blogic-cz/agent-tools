import {
  ClientSchema,
  decode,
  originUrl,
  RequestSchema,
  ResultSchema,
  MAX_RESULT_ENVELOPE_BYTES,
} from "./types";
import type { ApiRequest, ApiResult, ClientConfig } from "./types";
import { apiError, ErrorCode, safeError } from "./errors";
import { pinnedTransport } from "./transport";
import type { Transport } from "./transport";
import { Schema } from "effect";

export function createApiClient(value: ClientConfig, transport: Transport = pinnedTransport) {
  const config = decode(ClientSchema, value);
  originUrl(config.proxyOrigin, config.developmentLoopback);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(config.capability)) throw apiError("CONFIG_INVALID");
  return {
    request: async (input: ApiRequest): Promise<ApiResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 65000);
      try {
        const request = decode(RequestSchema, input);
        const body = JSON.stringify(request);
        if (Buffer.byteLength(body) > 1_000_000) throw apiError("LIMIT_EXCEEDED");
        const response = await transport({
          url: new URL("/request", config.proxyOrigin),
          method: "POST",
          headers: {
            authorization: `Bearer ${config.capability}`,
            "content-type": "application/json",
          },
          body,
          maxBytes: MAX_RESULT_ENVELOPE_BYTES,
          signal: controller.signal,
          allowedPrivateAddresses: [],
          developmentLoopback: config.developmentLoopback,
        });
        if (Buffer.byteLength(response.body) > MAX_RESULT_ENVELOPE_BYTES)
          throw apiError("LIMIT_EXCEEDED");
        if (response.status !== 200) {
          const parsed = decode(Schema.Struct({ code: ErrorCode }), JSON.parse(response.body));
          throw apiError(parsed.code);
        }
        return decode(ResultSchema, JSON.parse(response.body));
      } catch (error) {
        throw safeError(error);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
export type { ApiRequest, ApiResult, ClientConfig } from "./types";
export { ApiError } from "./errors";
