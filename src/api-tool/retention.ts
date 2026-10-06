import { apiError } from "./errors";

export const MAX_RETAINED_CREDENTIALS = 128;
type RetainedCredential = {
  readonly exact: readonly string[];
  readonly urlEncoded: readonly string[];
};
export function createCredentialRetention(initial: readonly string[]) {
  const values = new Map<string, RetainedCredential>();
  let reserved = 0;
  const add = (value: string): void => {
    if (values.has(value)) return;
    if (!value || value.length > 131_072 || values.size >= MAX_RETAINED_CREDENTIALS)
      throw apiError("CONFIG_INVALID");
    if (/[\uD800-\uDFFF]/u.test(value)) throw apiError("CONFIG_INVALID");
    const base64 = Buffer.from(value).toString("base64").replace(/=+$/, "");
    const variants = [value, base64, Buffer.from(value).toString("base64url")];
    values.set(value, {
      exact: variants.flatMap((encoded) => [encoded, JSON.stringify(encoded).slice(1, -1)]),
      urlEncoded: [
        encodeURIComponent(value),
        new URLSearchParams({ "": value }).toString().slice(1),
      ],
    });
  };
  for (const value of initial) add(value);
  return {
    protects: (serialized: string): boolean => {
      for (const { exact } of values.values()) {
        if (exact.some((value) => serialized.includes(value))) return true;
      }
      const canonical = serialized.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
      for (const { urlEncoded } of values.values()) {
        if (urlEncoded.some((value) => canonical.includes(value))) return true;
      }
      return false;
    },
    reserve: () => {
      if (values.size + reserved >= MAX_RETAINED_CREDENTIALS) throw apiError("BUDGET_EXHAUSTED");
      reserved++;
      let pending = true;
      const release = (): void => {
        if (pending) {
          pending = false;
          reserved--;
        }
      };
      return {
        release,
        retain: (value: string): void => {
          if (!pending) throw apiError("BUDGET_EXHAUSTED");
          add(value);
          release();
        },
      };
    },
  };
}
