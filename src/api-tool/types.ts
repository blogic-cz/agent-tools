import { isIP } from "node:net";
import { allowedAddress } from "./transport";
import { Schema } from "effect";
import { apiError } from "./errors";

export const Method = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const Auth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("bearer"), secretRef: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("apiKey"),
    header: Schema.String,
    secretRef: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("basic"),
    usernameRef: Schema.String,
    passwordRef: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("login"),
    path: Schema.String,
    fields: Schema.Record(Schema.String, Schema.String),
    tokenField: Schema.String,
  }),
]);
export const ProfileSchema = Schema.Struct({
  origin: Schema.String,
  auth: Auth,
  methods: Schema.optionalKey(Schema.Array(Method)),
  pathPrefixes: Schema.Array(Schema.String),
  deniedPathPrefixes: Schema.Array(Schema.String),
  allowedPrivateAddresses: Schema.Array(Schema.String),
  disclosure: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("raw") }),
    Schema.Struct({ kind: Schema.Literal("fields"), fields: Schema.Array(Schema.String) }),
  ]),
  maxRequestBytes: Schema.Number,
  maxResponseBytes: Schema.Number,
  timeoutMs: Schema.Number,
});
const GrantSchema = Schema.Struct({
  digest: Schema.String,
  expiresAt: Schema.Number,
  revoked: Schema.Boolean,
  profiles: Schema.Array(Schema.String),
  maxRequests: Schema.Number,
  maxBytes: Schema.Number,
  maxConcurrent: Schema.Number,
  lifetimeMs: Schema.Number,
});
export const OperatorSchema = Schema.Struct({
  listen: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("tls"),
      host: Schema.String,
      port: Schema.Number,
      certFile: Schema.String,
      keyFile: Schema.String,
      separateIdentityAcknowledged: Schema.Literal(true),
    }),
    Schema.Struct({
      kind: Schema.Literal("developmentLoopback"),
      host: Schema.Literal("127.0.0.1"),
      port: Schema.Number,
    }),
  ]),
  secretsFile: Schema.String,
  grantUseDirectory: Schema.String,
  profiles: Schema.Record(Schema.String, ProfileSchema),
  grants: Schema.Array(GrantSchema),
  maxConcurrent: Schema.Number,
});
export const ClientSchema = Schema.Struct({
  proxyOrigin: Schema.String,
  capability: Schema.String,
  developmentLoopback: Schema.optionalKey(Schema.Boolean),
});
export const RequestSchema = Schema.Struct({
  profile: Schema.String,
  method: Method,
  path: Schema.String,
  query: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optionalKey(Schema.Json),
});
export const ResultSchema = Schema.Struct({ status: Schema.Number, data: Schema.Json });
export type OperatorConfig = typeof OperatorSchema.Type;
export type ClientConfig = typeof ClientSchema.Type;
export type ApiRequest = typeof RequestSchema.Type;
export type ApiResult = typeof ResultSchema.Type;
export type Profile = typeof ProfileSchema.Type;
export type Grant = typeof GrantSchema.Type;

export function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw apiError("CONFIG_INVALID");
  }
}
export const MAX_PATH_BYTES = 16_384;
export const MAX_RESULT_ENVELOPE_BYTES = 10_000_000;
export function relativePath(path: string): string {
  if (
    path.length > MAX_PATH_BYTES ||
    !/^\/[A-Za-z0-9_~!$&'()+,=:@./-]*$/.test(path) ||
    path.includes("//") ||
    path.split("/").some((segment) => segment.endsWith("."))
  )
    throw apiError("POLICY_DENIED");
  return path;
}
export const matchesPrefix = (path: string, prefix: string): boolean => {
  const normalized = prefix === "/" ? prefix : prefix.replace(/\/$/, "");
  return normalized === "/" || path === normalized || path.startsWith(`${normalized}/`);
};
export function originUrl(origin: string, developmentLoopback = false): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw apiError("CONFIG_INVALID");
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(developmentLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw apiError("CONFIG_INVALID");
  return url;
}
const bounded = (n: number, max: number): boolean => Number.isSafeInteger(n) && n > 0 && n <= max;
export function validateOperator(value: unknown): OperatorConfig {
  const config = decode(OperatorSchema, value);
  if (
    !(
      bounded(config.listen.port, 65535) ||
      (config.listen.kind === "developmentLoopback" && config.listen.port === 0)
    ) ||
    !bounded(config.maxConcurrent, 64) ||
    !config.grants.length ||
    config.grants.length > 100 ||
    Object.keys(config.profiles).length > 100 ||
    !Object.keys(config.profiles).length
  )
    throw apiError("CONFIG_INVALID");
  const digests = new Set<string>();
  for (const grant of config.grants) {
    if (
      !/^[a-f0-9]{64}$/.test(grant.digest) ||
      digests.has(grant.digest) ||
      !bounded(grant.expiresAt, Number.MAX_SAFE_INTEGER) ||
      !bounded(grant.maxRequests, 10000) ||
      !bounded(grant.maxBytes, 1_000_000_000) ||
      !bounded(grant.maxConcurrent, 64) ||
      !bounded(grant.lifetimeMs, 86400000) ||
      !grant.profiles.length ||
      grant.profiles.some((p) => !Object.hasOwn(config.profiles, p))
    )
      throw apiError("CONFIG_INVALID");
    digests.add(grant.digest);
  }
  for (const profile of Object.values(config.profiles)) {
    originUrl(profile.origin);
    for (const address of profile.allowedPrivateAddresses) {
      if (
        !isIP(address) ||
        !allowedAddress(address, [address]) ||
        (isIP(address) === 6 && new URL(`http://[${address}]`).hostname.slice(1, -1) !== address)
      )
        throw apiError("CONFIG_INVALID");
    }
    if (
      !profile.pathPrefixes.length ||
      !bounded(profile.maxRequestBytes, 1_000_000) ||
      !bounded(profile.maxResponseBytes, 10_000_000) ||
      !bounded(profile.timeoutMs, 60000) ||
      profile.methods?.length === 0
    )
      throw apiError("CONFIG_INVALID");
    for (const prefix of [...profile.pathPrefixes, ...profile.deniedPathPrefixes])
      relativePath(prefix);
    if (profile.auth.kind === "apiKey" && !/^(?:x-[a-z0-9-]+|api-key)$/i.test(profile.auth.header))
      throw apiError("CONFIG_INVALID");
    if (profile.auth.kind === "login") {
      relativePath(profile.auth.path);
      const minimumBody = JSON.stringify(
        Object.fromEntries(Object.keys(profile.auth.fields).map((field) => [field, ""])),
      );
      if (
        Buffer.byteLength(profile.auth.path) + Buffer.byteLength(minimumBody) >
        profile.maxRequestBytes
      )
        throw apiError("CONFIG_INVALID");
    }
  }
  return config;
}
