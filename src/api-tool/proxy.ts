import { createHash } from "node:crypto";
import { Schema } from "effect";
import { apiError, safeError } from "./errors";
import { decode, matchesPrefix, relativePath, RequestSchema, validateOperator } from "./types";
import type { ApiResult, Grant, Profile } from "./types";
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
  for (const profile of Object.values(config.profiles))
    for (const ref of references(profile)) secret(ref);
  if (Object.keys(options.secrets).length > 128) throw apiError("CONFIG_INVALID");
  const knownSecrets = new Set(Object.values(options.secrets));
  const protectedOutput = (data: unknown): string => {
    const serialized = JSON.stringify(data);
    for (const value of knownSecrets) {
      if (
        [value, encodeURIComponent(value), Buffer.from(value).toString("base64")].some(
          (encoded) =>
            serialized.includes(encoded) ||
            serialized.includes(JSON.stringify(encoded).slice(1, -1)),
        )
      )
        throw apiError("DISCLOSURE_DENIED");
    }
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
  return {
    revoke: (digest: string): void => {
      const budget = budgets.get(digest);
      if (budget) budget.revoked = true;
    },
    request: async (capability: string, input: unknown): Promise<ApiResult> => {
      const budget = budgets.get(capabilityDigest(capability));
      if (!budget || budget.revoked || now() >= budget.grant.expiresAt)
        throw apiError("UNAUTHORIZED");
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
        profile.deniedPathPrefixes.some((prefix) => matchesPrefix(request.path, prefix)) ||
        (profile.auth.kind === "login" && matchesPrefix(request.path, profile.auth.path)) ||
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
          if (now() - budget.startedAt >= budget.grant.lifetimeMs)
            throw apiError("BUDGET_EXHAUSTED");
        };
        const send = (
          target: URL,
          method: string,
          headers: Record<string, string>,
          data: string,
        ) => {
          checkGrant();
          return beforeAbort(
            options.transport({
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
            }),
            controller.signal,
          );
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
            const encoded = Buffer.from(
              `${secret(profile.auth.usernameRef)}:${secret(profile.auth.passwordRef)}`,
            ).toString("base64");
            knownSecrets.add(encoded);
            headers.authorization = `Basic ${encoded}`;
            break;
          }
          case "login": {
            const loginBody = JSON.stringify(
              Object.fromEntries(
                Object.entries(profile.auth.fields).map(([field, ref]) => [field, secret(ref)]),
              ),
            );
            if (Buffer.byteLength(loginBody) > profile.maxRequestBytes)
              throw apiError("LIMIT_EXCEEDED");
            const result = await send(
              new URL(profile.auth.path, profile.origin),
              "POST",
              {},
              loginBody,
            );
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
            const token = Object.hasOwn(parsed, profile.auth.tokenField)
              ? parsed[profile.auth.tokenField]
              : undefined;
            if (
              typeof token !== "string" ||
              !token ||
              token.length > 16384 ||
              token.includes("\r") ||
              token.includes("\n") ||
              token.includes(String.fromCharCode(0))
            )
              throw apiError("UPSTREAM_FAILED");
            if (knownSecrets.size >= 128) throw apiError("BUDGET_EXHAUSTED");
            knownSecrets.add(token);
            headers.authorization = `Bearer ${token}`;
            break;
          }
        }
        const response = await send(url, request.method, headers, body);
        if (response.status < 200 || response.status >= 300) throw apiError("UPSTREAM_FAILED");
        if (Buffer.byteLength(response.body) > profile.maxResponseBytes)
          throw apiError("LIMIT_EXCEEDED");
        if (controller.signal.aborted) throw apiError("DEADLINE_EXCEEDED");
        let data = decode(Schema.Json, JSON.parse(response.body));
        if (profile.disclosure.kind === "fields") {
          const object = decode(Schema.Record(Schema.String, Schema.Json), data);
          data = Object.fromEntries(
            profile.disclosure.fields
              .filter((field) => Object.hasOwn(object, field))
              .map((field) => [field, object[field]]),
          );
        }
        protectedOutput(data);
        checkGrant();
        return { status: response.status, data };
      } catch (error) {
        throw safeError(error);
      } finally {
        clearTimeout(timer);
        budget.active--;
        active--;
      }
    },
  };
}
