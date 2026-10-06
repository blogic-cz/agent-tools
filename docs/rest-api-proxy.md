# REST credential proxy

`api-tool` and the exported TypeScript client submit JSON REST requests to an operator-owned proxy. The proxy loads provider credentials, authenticates against a fixed HTTPS origin, and returns approved JSON. It runs no uploaded scripts. Profiles configure services without adding endpoint-specific wrapper code.

## Required deployment boundary

Deploy the proxy under a separate Unix service identity or on a remote host. The requesting agent must have no access to that identity's files, process memory, administrative controls, service configuration, grant-use markers or upstream credential sources. Remove or isolate any old provider credentials in the agent's shell exports, startup files and accessible stores. The `separateIdentityAcknowledged` configuration field records operator acknowledgment. The application cannot prove OS isolation.

Production clients use verified TLS. The runtime serves TLS directly. It refuses external plaintext HTTP; explicit `developmentLoopback` binds only `127.0.0.1` and protects against accidental output only. A daemon under the same user does not prevent that user reading its credentials. Unix ownership and permissions are required by this first version's private-file backend. Windows operators can use a remote Unix proxy; no Windows store backend is implemented.

The private store is plaintext operator configuration, protected by OS ownership and permissions. It is not an encrypted vault. No provider secret belongs in client configuration, command arguments, client environment or agent-readable files.

## Operator setup

Run these steps as the isolated service owner, outside the agent's authority. Create an absolute canonical private directory with mode `0700`, and keep every configuration, private store, TLS key and certificate file mode `0600` and owned by that identity. Use a trusted operator editor or provisioning system to write the files. The runtime checks the immediate private parent directory and rejects direct symlink files, other ownership, public file permissions, missing credentials and malformed configuration. Ancestor ownership, symlinks and replacement races are operator responsibilities; these checks do not certify a whole path against an administrator. Files are limited to 1 MB.

Provision a cryptographically random caller capability with at least 32 URL-safe characters, for example through the operator's existing secret generator. Give the caller only the capability and the proxy HTTPS origin. Compute its SHA-256 digest with standard tooling and put only the digest in the operator grant. The capability authorizes allowed use; it is not an upstream credential. It must be kept private from other callers.

Create a private `grant-use` directory with mode `0700`. Before listening, the runtime exclusively creates and fsyncs a marker for every configured grant digest, then fsyncs the directory. A marker means that grant can never be used by another runtime. Restart, a crash, or partial startup requires issuing fresh capabilities and digests. Never delete or reuse markers, restore stale marker backups, or share grants across multiple proxy instances. Grant-store errors refuse startup. File and directory fsync establish the available filesystem flush contract, not universal power-loss durability. This backend does not use macOS F_FULLFSYNC. After uncertain power loss, filesystem rollback or backup restoration, provision fresh capabilities and retain existing markers before starting; never trust an absent marker as evidence an old grant is fresh. Failed startup can burn some grants. This deliberately small first version has no persistent request ledger, automatic retries, token refresh cache or automatic pagination.

Example private store, entered by the operator:

```json
{ "sample-token": "OPERATOR_PROVISIONS_PROVIDER_SECRET" }
```

Example operator configuration. Replace the digest, expiry, paths and service policy before use. The sample expiry is illustrative and must be a future epoch timestamp in milliseconds.

```json
{
  "listen": {
    "kind": "tls",
    "host": "0.0.0.0",
    "port": 8443,
    "certFile": "/operator/private/cert.pem",
    "keyFile": "/operator/private/key.pem",
    "separateIdentityAcknowledged": true
  },
  "secretsFile": "/operator/private/store.json",
  "grantUseDirectory": "/operator/private/grant-use",
  "maxConcurrent": 4,
  "profiles": {
    "sample": {
      "origin": "https://service.example.invalid",
      "auth": { "kind": "bearer", "secretRef": "sample-token" },
      "pathPrefixes": ["/v1"],
      "deniedPathPrefixes": ["/v1/auth"],
      "allowedPrivateAddresses": [],
      "disclosure": { "kind": "fields", "fields": ["items", "total"] },
      "maxRequestBytes": 10000,
      "maxResponseBytes": 100000,
      "timeoutMs": 10000
    }
  },
  "grants": [
    {
      "digest": "OPERATOR_SUPPLIES_64_LOWERCASE_HEX_DIGEST",
      "expiresAt": 1799999999000,
      "revoked": false,
      "profiles": ["sample"],
      "maxRequests": 20,
      "maxBytes": 2200000,
      "maxConcurrent": 2,
      "lifetimeMs": 600000
    }
  ]
}
```

Start the service using its service manager and identity:

```sh
api-proxy --config /operator/private/operator.json
```

For development with synthetic credentials only, use `"listen": { "kind": "developmentLoopback", "host": "127.0.0.1", "port": 8443 }`. The client must separately enable `developmentLoopback: true`. Upstream profiles still require HTTPS.

Rotate credentials by replacing the private store through operator provisioning and restarting with fresh grants. Revoke grants by stopping the service and restarting with fresh grants for callers who retain access. Configuration is immutable during a runtime. There is no caller-facing administration endpoint. Operator code embedding the engine can call its `revoke(digest)` method. An already dispatched provider request may finish, but its result is refused after revocation; a login cannot dispatch the subsequent API operation after revocation or expiry.

## Client usage

Client configuration contains only the proxy origin and caller capability:

```json
{
  "proxyOrigin": "https://proxy.example.invalid:8443",
  "capability": "OPERATOR_ISSUES_RANDOM_CALLER_CAPABILITY"
}
```

```sh
api-tool request --config ./api-client.json --profile sample --path /v1/items
api-tool request --config ./api-client.json --profile sample --path /v1/items --query '{"limit":"10"}'
api-tool request --config ./api-client.json --profile sample --method POST --path /v1/search --body '{"name":"example"}'
api-tool request --help
bun run api-tool request --config ./api-client.json --profile sample --path /v1/items
```

GET is the default policy when `methods` is absent. An operator can explicitly approve `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. GET itself is not evidence that an endpoint has no side effects. The operator approves service semantics and uses provider-side least privilege.

```ts
import { createApiClient } from "@blogic-cz/agent-tools/api";

const api = createApiClient(clientConfig);
const result = await api.request({
  profile: "sample",
  method: "GET",
  path: "/v1/items",
  query: { limit: "10" },
});
```

`ApiError` has stable `code`, `message` and safe `hint` fields. Provider bodies, headers, URLs, tokens and underlying exception details never become public errors. Client requests cannot change targets, headers, credentials, methods policy or disclosure rules. Successful responses with an empty body return `data: null`, including 204/205 responses, without retrying the provider operation. The CLI prints JSON and does not add requests or response data to the existing audit log.

## Authentication and disclosure

Supported profile auth shapes:

```json
{ "kind": "bearer", "secretRef": "token" }
{ "kind": "apiKey", "header": "x-api-key", "secretRef": "api-key" }
{ "kind": "basic", "usernameRef": "username", "passwordRef": "password" }
{ "kind": "login", "path": "/auth/login", "fields": { "username": "username", "password": "password" }, "tokenField": "access_token" }
```

Login is one configured JSON POST at the exact profile origin. Its fixed fields reference the private store. The response's configured top-level string token becomes a Bearer header inside the proxy. Login output never goes to callers, and the login path and descendants are denied to client requests. Login and API requests share a single deadline; the budget reserves both requests' maximum bytes. Failed login refuses the operation. Unsupported cookie, OAuth browser, multipart and executable authentication flows refuse configuration instead of executing custom code.

Choose `disclosure: { "kind": "fields", "fields": [...] }` to project top-level object fields. Choose `disclosure: { "kind": "raw" }` only when the operator authorizes the service's complete JSON response. Neither mode promises that application data are nonsensitive. Exact stored-secret and minted-token echoes, including JSON-escaped, URI-component, form URL-encoded and base64 variants, refuse disclosure. URL percent escapes match without regard to their hexadecimal letter case; credential letters remain case-sensitive. This does not detect arbitrary transformed secrets or establish universal privacy. At most 128 distinct stored secrets, deterministic Basic credentials and retained auth tokens are allowed per runtime. Pending logins reserve retention slots before dispatch, and reaching the retention bound refuses new logins. Failed exchanges release their slots; a token already known releases its extra reservation without evicting any credential. An aborted exchange keeps its slot until the transport settles, and any valid token it returns is retained before the operation can continue. Tokens are never evicted from echo checks.

## Transport and budgets

The proxy permits only the exact configured HTTPS origin and strict relative paths. It refuses all percent-encoded paths, traversal, semicolons, segments ending with a dot, double slash, query/fragment embedded in paths and absolute URLs. Supply query strings through the `query` object. Prefix checks respect path segment boundaries. Denied and login paths also match without case distinctions to protect services that normalize case. Configure denied auth paths for services with other authentication endpoints.

The transport ignores ambient HTTP proxy variables, creates direct connections, never follows redirects, resolves every DNS answer, refuses unknown/mixed forbidden addresses, and pins the actual socket lookup to a checked address while retaining TLS hostname verification. Private addresses require an exact normalized IP allowance; link-local/cloud metadata and mapped IPv6 addresses are always refused. The public-address classifier is conservative, so some special-use addresses are refused. The public client currently supports a publicly addressed HTTPS proxy or explicit loopback development; it has no private-proxy IP allowance.

Admission synchronously checks cumulative requests, reserved bytes, concurrency, grant expiry and runtime lifetime before I/O. The runtime never refunds failed requests or unused byte reservations. There are finite per-request streamed response and input limits, DNS/request deadlines and server connection limits. At most 64 unresolved DNS operations remain outstanding per trusted transport instance; aborted lookups retain those slots until they settle. Unknown, revoked, expired and lifetime-exhausted capabilities refuse before reading request bodies. Connection and network saturation still require deployment controls. The configuration caps profiles/grants at 100, requests at 10000 per grant, concurrency at 64, request JSON at 1 MB, response JSON at 10 MB, serialized result envelopes at 10 MB, paths at 16,384 ASCII bytes, per-request time at 60 seconds and grant runtime lifetime at 24 hours. Callers implement bounded loops themselves and never pass provider pagination URLs as targets. The 10 MB serialized result-envelope limit includes status and JSON wrapping and is separate from the configured upstream response-body limit. JSON numbers may expand during serialization; a response exceeding the envelope limit refuses with `LIMIT_EXCEEDED` before output. Server request envelopes and network protocol overhead are separately bounded; grant byte accounting covers configured provider payload/path maxima, not total TCP/TLS wire bytes.
