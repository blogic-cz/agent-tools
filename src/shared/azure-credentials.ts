/**
 * Azure CLI surfaces that return credential material.
 *
 * Shared because two tools reach the Azure CLI: az-tool for the platform, and
 * azdo-tool for the `acr`/`account` groups it still passes through for
 * backwards compatibility. Both must refuse the same commands — a term added
 * to one list and not the other reopens a credential read through whichever
 * tool was missed.
 */

/** Read-shaped verbs that return credential material, in any command group. */
export const CREDENTIAL_BLOCKED_VERBS = [
  "get-access-token",
  "get-credentials",
  "get-secrets",
  "list-account-keys",
  "list-connection-strings",
  "list-keys",
  "list-publishing-credentials",
  "list-publishing-profiles",
  "list-secrets",
  "show-connection-string",
  "show-secret",
] as const;

/**
 * Command group segments that carry credential material. For these the listing
 * itself returns values — `az storage account keys list` and
 * `az webapp config appsettings list` both print secrets.
 */
export const CREDENTIAL_BLOCKED_SEGMENTS = [
  "admin-key",
  "appsettings",
  "connection-string",
  "credential",
  "credentials",
  "key",
  "keys",
  "password",
  "query-key",
  "sas",
  "secret",
  "secrets",
] as const;

export const isCredentialBlockedVerb = (word: string): boolean =>
  (CREDENTIAL_BLOCKED_VERBS as readonly string[]).includes(word);

export const isCredentialBlockedSegment = (word: string): boolean =>
  (CREDENTIAL_BLOCKED_SEGMENTS as readonly string[]).includes(word);
