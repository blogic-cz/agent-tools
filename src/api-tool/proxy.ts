import { createHash } from "node:crypto";
import { Schema } from "effect";
import { apiError, safeError } from "./errors";
import {
  decode,
  matchesPrefix,
  relativePath,
  RequestSchema,
  validateOperator,
  MAX_PATH_BYTES,
  MAX_RESULT_ENVELOPE_BYTES,
} from "./types";
import type { ApiResult, Grant, Profile } from "./types";
import { createCredentialRetention } from "./retention";
import { beforeAbort } from "./transport";
import type { Transport } from "./transport";

export const capabilityDigest = (capability: string): string =>
  createHash("sha256").update(capability).digest("hex");
type Budget = {
  grant: Grant;
  requests: number;
  bytes: number;
  active: number;
  startedAt: number;
  revoked: boolean;
};
export function createProxy(options: {
  config: unknown;
  secrets: Readonly<Record<string, string>>;
  transport: Transport;
  now?: () => number;
}) {
  const config = validateOperator(options.config);
  const now = options.now ?? Date.now;
  const budgets = new Map(
    config.grants.map((grant) => [
      grant.digest,
      { grant, requests: 0, bytes: 0, active: 0, startedAt: now(), revoked: grant.revoked },
    ]),
  );
  let active = 0;
  const secret = (ref: string): string => {
    const value = Object.hasOwn(options.secrets, ref) ? options.secrets[ref] : undefined;
    if (
      !value ||
      value.length > 16384 ||
      /[\uD800-\uDFFF]/u.test(value) ||
      value.includes("\r") ||
      value.includes("\n") ||
      value.includes(String.fromCharCode(0))
    )
      throw apiError("CREDENTIAL_UNAVAILABLE");
    return value;
  };
  const references = (profile: Profile): readonly string[] => {
    switch (profile.auth.kind) {
      case "bearer":
      case "apiKey":
        return [profile.auth.secretRef];
      case "basic":
        return [profile.auth.usernameRef, profile.auth.passwordRef];
      case "login":
        return Object.values(profile.auth.fields);
    }
  };
  if (Object.keys(options.secrets).length > 128) throw apiError("CONFIG_INVALID");
  const initial = Object.keys(options.secrets).map(secret);
  const basicCredentials = new Map<Profile, string>();
  const loginBodies = new Map<Profile, string>();
  for (const profile of Object.values(config.profiles)) {
    for (const ref of references(profile)) secret(ref);
    if (profile.auth.kind === "basic") {
      const encoded = Buffer.from(
        `${secret(profile.auth.usernameRef)}:${secret(profile.auth.passwordRef)}`,
      ).toString("base64");
      basicCredentials.set(profile, encoded);
      initial.push(encoded);
    }
    if (profile.auth.kind === "login") {
      const body = JSON.stringify(
        Object.fromEntries(
          Object.entries(profile.auth.fields).map(([field, ref]) => [field, secret(ref)]),
        ),
      );
      if (Buffer.byteLength(profile.auth.path) + Buffer.byteLength(body) > profile.maxRequestBytes)
        throw apiError("CONFIG_INVALID");
      loginBodies.set(profile, body);
    }
  }
  const retention = createCredentialRetention(initial);
  const protectedOutput = (result: ApiResult): string => {
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > MAX_RESULT_ENVELOPE_BYTES) throw apiError("LIMIT_EXCEEDED");
    if (retention.protects(serialized)) throw apiError("DISCLOSURE_DENIED");
    return serialized;
  };
  const admit = (budget: Budget, profile: Profile): void => {
    const reserve = profile.maxRequestBytes + profile.maxResponseBytes;
    const total = profile.auth.kind === "login" ? reserve * 2 : reserve;
    if (budget.revoked || now() >= budget.grant.expiresAt) throw apiError("UNAUTHORIZED");
    if (
      now() - budget.startedAt >= budget.grant.lifetimeMs ||
      budget.requests >= budget.grant.maxRequests ||
      budget.bytes + total > budget.grant.maxBytes ||
      budget.active >= budget.grant.maxConcurrent ||
      active >= config.maxConcurrent
    )
      throw apiError("BUDGET_EXHAUSTED");
    budget.requests++;
    budget.bytes += total;
    budget.active++;
    active++;
  };
  const authorize = (capability: string): Budget => {
    const budget = budgets.get(capabilityDigest(capability));
    if (!budget || budget.revoked || now() >= budget.grant.expiresAt)
      throw apiError("UNAUTHORIZED");
    if (now() - budget.startedAt >= budget.grant.lifetimeMs) throw apiError("BUDGET_EXHAUSTED");
    return budget;
  };
  const execute = async (
    capability: string,
    input: unknown,
  ): Promise<{ result: ApiResult; serialized: string }> => {
    const budget = authorize(capability);
    if (
      typeof input === "object" &&
      input !== null &&
      "path" in input &&
      typeof input.path === "string" &&
      input.path.length > MAX_PATH_BYTES
    )
      throw apiError("POLICY_DENIED");
    const request = decode(RequestSchema, input);
    const profile = Object.hasOwn(config.profiles, request.profile)
      ? config.profiles[request.profile]
      : undefined;
    if (!profile || !budget.grant.profiles.includes(request.profile))
      throw apiError("POLICY_DENIED");
    relativePath(request.path);
    if (
      !(profile.methods ?? ["GET"]).includes(request.method) ||
      !profile.pathPrefixes.some((prefix) => matchesPrefix(request.path, prefix)) ||
      profile.deniedPathPrefixes.some((prefix) =>
        matchesPrefix(request.path.toLowerCase(), prefix.toLowerCase()),
      ) ||
      (profile.auth.kind === "login" &&
        matchesPrefix(request.path.toLowerCase(), profile.auth.path.toLowerCase())) ||
      (request.method === "GET" && request.body !== undefined)
    )
      throw apiError("POLICY_DENIED");
    const body = request.body === undefined ? "" : JSON.stringify(request.body);
    const url = new URL(request.path, profile.origin);
    for (const [key, value] of Object.entries(request.query ?? {}))
      url.searchParams.append(key, value);
    if (
      Buffer.byteLength(body) + Buffer.byteLength(url.pathname + url.search) >
      profile.maxRequestBytes
    )
      throw apiError("LIMIT_EXCEEDED");
    admit(budget, profile);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(
        profile.timeoutMs,
        budget.grant.expiresAt - now(),
        budget.grant.lifetimeMs - (now() - budget.startedAt),
      ),
    );
    try {
      const checkGrant = () => {
        if (budget.revoked || now() >= budget.grant.expiresAt) throw apiError("UNAUTHORIZED");
        if (now() - budget.startedAt >= budget.grant.lifetimeMs) throw apiError("BUDGET_EXHAUSTED");
      };
      const send = (target: URL, method: string, headers: Record<string, string>, data: string) => {
        checkGrant();
        return options.transport({
          url: target,
          method,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...headers,
          },
          body: data,
          maxBytes: profile.maxResponseBytes,
          signal: controller.signal,
          allowedPrivateAddresses: profile.allowedPrivateAddresses,
        });
      };
      const headers: Record<string, string> = {};
      switch (profile.auth.kind) {
        case "bearer":
          headers.authorization = `Bearer ${secret(profile.auth.secretRef)}`;
          break;
        case "apiKey":
          headers[profile.auth.header.toLowerCase()] = secret(profile.auth.secretRef);
          break;
        case "basic": {
          const encoded = basicCredentials.get(profile);
          if (encoded === undefined) throw apiError("CREDENTIAL_UNAVAILABLE");
          headers.authorization = `Basic ${encoded}`;
          break;
        }
        case "login": {
          const auth = profile.auth;
          const loginBody = loginBodies.get(profile);
          if (loginBody === undefined) throw apiError("CREDENTIAL_UNAVAILABLE");
          const reservation = retention.reserve();
          let operation: Promise<string>;
          try {
            operation = send(new URL(profile.auth.path, profile.origin), "POST", {}, loginBody)
              .then((result) => {
                if (
                  result.status < 200 ||
                  result.status >= 300 ||
                  Buffer.byteLength(result.body) > profile.maxResponseBytes
                )
                  throw apiError("UPSTREAM_FAILED");
                const parsed = decode(
                  Schema.Record(Schema.String, Schema.Json),
                  JSON.parse(result.body),
                );
                const token = Object.hasOwn(parsed, auth.tokenField)
                  ? parsed[auth.tokenField]
                  : undefined;
                if (
                  typeof token !== "string" ||
                  !token ||
                  token.length > 16384 ||
                  /[\uD800-\uDFFF]/u.test(token) ||
                  token.includes("\r") ||
                  token.includes("\n") ||
                  token.includes(String.fromCharCode(0))
                )
                  throw apiError("UPSTREAM_FAILED");
                reservation.retain(token);
                return token;
              })
              .finally(reservation.release);
          } catch (error) {
            reservation.release();
            throw error;
          }
          headers.authorization = `Bearer ${await beforeAbort(operation, controller.signal)}`;
          break;
        }
      }
      const response = await beforeAbort(
        send(url, request.method, headers, body),
        controller.signal,
      );
      if (response.status < 200 || response.status >= 300) throw apiError("UPSTREAM_FAILED");
      if (Buffer.byteLength(response.body) > profile.maxResponseBytes)
        throw apiError("LIMIT_EXCEEDED");
      if (controller.signal.aborted) throw apiError("DEADLINE_EXCEEDED");
      let data = response.body === "" ? null : decode(Schema.Json, JSON.parse(response.body));
      if (profile.disclosure.kind === "fields" && data !== null) {
        let object: Readonly<Record<string, typeof Schema.Json.Type>>;
        try {
          object = decode(Schema.Record(Schema.String, Schema.Json), data);
        } catch {
          throw apiError("DISCLOSURE_DENIED");
        }
        data = Object.fromEntries(
          profile.disclosure.fields
            .filter((field) => Object.hasOwn(object, field))
            .map((field) => [field, object[field]]),
        );
      }
      const result = { status: response.status, data };
      const serialized = protectedOutput(result);
      checkGrant();
      return { result, serialized };
    } catch (error) {
      throw safeError(error);
    } finally {
      clearTimeout(timer);
      budget.active--;
      active--;
    }
  };
  return {
    authorize: (capability: string): void => {
      authorize(capability);
    },
    revoke: (digest: string): void => {
      const budget = budgets.get(digest);
      if (budget) budget.revoked = true;
    },
    request: async (capability: string, input: unknown): Promise<ApiResult> =>
      (await execute(capability, input)).result,
    requestSerialized: async (capability: string, input: unknown): Promise<string> =>
      (await execute(capability, input)).serialized,
  };
}
