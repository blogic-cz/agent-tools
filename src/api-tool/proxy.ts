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
  loginWaiters: Set<() => void>;
};
type LoginToken = { value: string; expiresAt: number };
type LoginFlight = {
  promise: Promise<string>;
  waiters: number;
  settled: boolean;
  ownerRequest: object;
  releaseOwnerSlot?: () => void;
  abort: () => void;
};
export function createProxy(options: {
  config: unknown;
  secrets: Readonly<Record<string, string>>;
  transport: Transport;
  now?: () => number;
}) {
  const config = validateOperator(options.config);
  const now = options.now ?? Date.now;
  const budgets = new Map<string, Budget>(
    config.grants.map((grant): [string, Budget] => [
      grant.digest,
      {
        grant,
        requests: 0,
        bytes: 0,
        active: 0,
        startedAt: now(),
        revoked: grant.revoked,
        loginWaiters: new Set<() => void>(),
      },
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
        return Object.values(profile.auth.fields).flatMap((value) =>
          typeof value === "string" ? [value] : "secretRef" in value ? [value.secretRef] : [],
        );
      case "bodyFields":
        return Object.values(profile.auth.fields).flatMap((value) =>
          "secretRef" in value ? [value.secretRef] : [],
        );
    }
  };
  if (Object.keys(options.secrets).length > 128) throw apiError("CONFIG_INVALID");
  const initial = Object.keys(options.secrets).map(secret);
  const basicCredentials = new Map<Profile, string>();
  const loginBodies = new Map<Profile, string>();
  const bodyFields = new Map<Profile, Record<string, unknown>>();
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
          Object.entries(profile.auth.fields).map(([field, value]) => [
            field,
            typeof value === "string"
              ? secret(value)
              : "secretRef" in value
                ? secret(value.secretRef)
                : value.literal,
          ]),
        ),
      );
      if (Buffer.byteLength(profile.auth.path) + Buffer.byteLength(body) > profile.maxRequestBytes)
        throw apiError("CONFIG_INVALID");
      loginBodies.set(profile, body);
    }
    if (profile.auth.kind === "bodyFields") {
      bodyFields.set(
        profile,
        Object.fromEntries(
          Object.entries(profile.auth.fields).map(([field, value]) => [
            field,
            "secretRef" in value ? secret(value.secretRef) : value.literal,
          ]),
        ),
      );
    }
  }
  const loginTokens = new Map<Profile, LoginToken>();
  const pendingLogins = new Map<Profile, LoginFlight>();
  const retention = createCredentialRetention(initial);
  const protectedOutput = (result: ApiResult): string => {
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > MAX_RESULT_ENVELOPE_BYTES) throw apiError("LIMIT_EXCEEDED");
    if (retention.protects(serialized)) throw apiError("DISCLOSURE_DENIED");
    return serialized;
  };
  const admit = (budget: Budget, profile: Profile): number => {
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
    return total;
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
    const requestId = {};
    let loginFlight: LoginFlight | undefined;
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
    let bodyValue: unknown = request.body;
    if (profile.auth.kind === "bodyFields") {
      if (
        typeof bodyValue !== "object" ||
        bodyValue === null ||
        Array.isArray(bodyValue) ||
        Object.getPrototypeOf(bodyValue) !== Object.prototype
      )
        throw apiError("POLICY_DENIED");
      const injected = bodyFields.get(profile);
      if (injected === undefined) throw apiError("CREDENTIAL_UNAVAILABLE");
      const names = new Set(Object.keys(injected).map((name) => name.toLowerCase()));
      if (Object.keys(bodyValue).some((name) => names.has(name.toLowerCase())))
        throw apiError("POLICY_DENIED");
      bodyValue = { ...bodyValue, ...injected };
    }
    const body = bodyValue === undefined ? "" : (JSON.stringify(bodyValue) ?? "");
    const url = new URL(request.path, profile.origin);
    for (const [key, value] of Object.entries(request.query ?? {}))
      url.searchParams.append(key, value);
    if (
      Buffer.byteLength(body) + Buffer.byteLength(url.pathname + url.search) >
      profile.maxRequestBytes
    )
      throw apiError("LIMIT_EXCEEDED");
    let used = 0;
    let incomplete = false;
    const reserved = admit(budget, profile);
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
      const send = async (
        target: URL,
        method: string,
        headers: Record<string, string>,
        data: string,
        signal = controller.signal,
        check = checkGrant,
      ) => {
        check();
        try {
          const response = await options.transport({
            url: target,
            method,
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              ...headers,
            },
            body: data,
            maxBytes: profile.maxResponseBytes,
            signal,
            allowedPrivateAddresses: profile.allowedPrivateAddresses,
          });
          used += Buffer.byteLength(data) + Buffer.byteLength(response.body);
          return response;
        } catch (error) {
          incomplete = true;
          throw error;
        }
      };
      const headers: Record<string, string> = {};
      let usedLoginToken: string | undefined;
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
        case "bodyFields":
          break;
        case "login": {
          const auth = profile.auth;
          const loginBody = loginBodies.get(profile);
          if (loginBody === undefined) throw apiError("CREDENTIAL_UNAVAILABLE");
          const waitForLogin = (flight: LoginFlight): Promise<string> => {
            loginFlight = flight;
            flight.waiters++;
            return new Promise((resolve, reject) => {
              let waiting = true;
              const leave = (): boolean => {
                if (!waiting) return false;
                waiting = false;
                controller.signal.removeEventListener("abort", onAbort);
                budget.loginWaiters.delete(onRevoke);
                flight.waiters--;
                if (flight.waiters === 0 && !flight.settled) {
                  if (pendingLogins.get(profile) === flight) pendingLogins.delete(profile);
                  flight.abort();
                }
                return true;
              };
              const onAbort = () => {
                if (leave()) reject(apiError("DEADLINE_EXCEEDED"));
              };
              const onRevoke = () => {
                if (leave()) reject(apiError("UNAUTHORIZED"));
              };
              controller.signal.addEventListener("abort", onAbort, { once: true });
              budget.loginWaiters.add(onRevoke);
              if (controller.signal.aborted) onAbort();
              else if (budget.revoked) onRevoke();
              flight.promise.then(
                (token) => {
                  if (leave()) resolve(token);
                  return undefined;
                },
                (error: unknown) => {
                  if (leave()) reject(error);
                  return undefined;
                },
              );
            });
          };
          const getToken = (): Promise<string> => {
            const reuseMs = auth.tokenReuseMs;
            if (reuseMs !== undefined) {
              const cached = loginTokens.get(profile);
              if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value);
              const pending = pendingLogins.get(profile);
              if (pending) return waitForLogin(pending);
            }
            const reservation = retention.reserve();
            const loginController = new AbortController();
            const loginTimer = setTimeout(() => loginController.abort(), profile.timeoutMs);
            let flight: LoginFlight;
            let operation: Promise<string>;
            try {
              operation = send(
                new URL(auth.path, profile.origin),
                "POST",
                {},
                loginBody,
                loginController.signal,
                () => undefined,
              )
                .then((result) => {
                  if (
                    result.status < 200 ||
                    result.status >= 300 ||
                    Buffer.byteLength(result.body) > profile.maxResponseBytes
                  )
                    throw apiError("UPSTREAM_FAILED");
                  const parsed = decode(Schema.Json, JSON.parse(result.body));
                  let token: unknown = parsed;
                  const tokenPath =
                    auth.tokenPath ?? (auth.tokenField === undefined ? [] : [auth.tokenField]);
                  for (const segment of tokenPath) {
                    if (
                      typeof token !== "object" ||
                      token === null ||
                      Array.isArray(token) ||
                      Object.getPrototypeOf(token) !== Object.prototype ||
                      !Object.hasOwn(token, segment)
                    ) {
                      token = undefined;
                      break;
                    }
                    token = (token as Record<string, unknown>)[segment];
                  }
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
                  if (reuseMs !== undefined && flight.waiters > 0)
                    loginTokens.set(profile, { value: token, expiresAt: now() + reuseMs });
                  return token;
                })
                .finally(() => {
                  clearTimeout(loginTimer);
                  reservation.release();
                  flight.settled = true;
                  if (pendingLogins.get(profile) === flight) pendingLogins.delete(profile);
                  flight.releaseOwnerSlot?.();
                });
            } catch (error) {
              clearTimeout(loginTimer);
              reservation.release();
              throw error;
            }
            flight = {
              promise: operation,
              waiters: 0,
              settled: false,
              ownerRequest: requestId,
              abort: () => {
                clearTimeout(loginTimer);
                loginController.abort();
              },
            };
            if (reuseMs !== undefined) {
              pendingLogins.set(profile, flight);
              const clearPending = () => {
                if (pendingLogins.get(profile) === flight) pendingLogins.delete(profile);
              };
              void flight.promise.then(clearPending, clearPending);
            }
            return waitForLogin(flight);
          };
          const token = await getToken();
          headers.authorization = `Bearer ${token}`;
          usedLoginToken = token;
          break;
        }
      }
      const response = await beforeAbort(
        send(url, request.method, headers, body),
        controller.signal,
      );
      const unauthorizedLogin = profile.auth.kind === "login" && response.status === 401;
      if (unauthorizedLogin && usedLoginToken !== undefined) {
        const cached = loginTokens.get(profile);
        if (cached?.value === usedLoginToken) loginTokens.delete(profile);
      }
      if (!unauthorizedLogin && (response.status < 200 || response.status >= 300))
        throw apiError("UPSTREAM_FAILED");
      if (Buffer.byteLength(response.body) > profile.maxResponseBytes)
        throw apiError("LIMIT_EXCEEDED");
      if (controller.signal.aborted) throw apiError("DEADLINE_EXCEEDED");
      let data = response.body === "" ? null : decode(Schema.Json, JSON.parse(response.body));
      if (profile.disclosure.kind === "fields" && response.body !== "") {
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
      if (!incomplete) budget.bytes -= Math.max(0, reserved - used);
      if (loginFlight?.ownerRequest === requestId && !loginFlight.settled) {
        let released = false;
        loginFlight.releaseOwnerSlot = () => {
          if (released) return;
          released = true;
          budget.active--;
          active--;
        };
      } else {
        budget.active--;
        active--;
      }
    }
  };
  return {
    authorize: (capability: string): void => {
      authorize(capability);
    },
    revoke: (digest: string): void => {
      const budget = budgets.get(digest);
      if (budget) {
        budget.revoked = true;
        for (const leave of budget.loginWaiters) leave();
      }
    },
    request: async (capability: string, input: unknown): Promise<ApiResult> =>
      (await execute(capability, input)).result,
    requestSerialized: async (capability: string, input: unknown): Promise<string> =>
      (await execute(capability, input)).serialized,
  };
}
