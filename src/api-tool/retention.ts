import { apiError } from "./errors";

export const MAX_RETAINED_CREDENTIALS = 128;
export function createCredentialRetention(initial: readonly string[]) {
  const values = new Map<string, readonly string[]>();
  let reserved = 0;
  const add = (value: string): void => {
    if (values.has(value)) return;
    if (!value || value.length > 131_072 || values.size >= MAX_RETAINED_CREDENTIALS)
      throw apiError("CONFIG_INVALID");
    if (/[\uD800-\uDFFF]/u.test(value)) throw apiError("CONFIG_INVALID");
    const base64 = Buffer.from(value).toString("base64").replace(/=+$/, "");
    const variants = [
      value,
      encodeURIComponent(value),
      base64,
      Buffer.from(value).toString("base64url"),
    ];
    values.set(
      value,
      variants.flatMap((encoded) => [encoded, JSON.stringify(encoded).slice(1, -1)]),
    );
  };
  for (const value of initial) add(value);
  return {
    protects: (serialized: string): boolean =>
      [...values.values()].some((variants) => variants.some((value) => serialized.includes(value))),
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
