import { findSecretMatches } from "./credential-patterns";

const SENSITIVE_ENV_NAME =
  /(?:KEY|TOKEN|SECRET|PASS(?:WORD)?|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|PSK)/i;
const isSensitiveEnvironmentName = (name: string) =>
  name !== "PWD" &&
  name !== "OLDPWD" &&
  name !== "CODEX_SESSION_ID" &&
  SENSITIVE_ENV_NAME.test(name);

const sensitiveEnvironmentValues = (environment: Record<string, string | undefined>) =>
  Object.entries(environment)
    .flatMap(([name, value]) =>
      isSensitiveEnvironmentName(name) && value && value.length >= 8 ? [value] : [],
    )
    .toSorted((left, right) => right.length - left.length);

export function unsafeOutboundTextReason(
  text: string,
  environment: Record<string, string | undefined> = process.env,
): string | null {
  if (findSecretMatches(text).length > 0) return "a credential pattern";
  if (sensitiveEnvironmentValues(environment).some((value) => text.includes(value))) {
    return "a credential from the process environment";
  }

  const assignments = text.match(/^[A-Za-z_][A-Za-z0-9_]*=.*$/gm) ?? [];
  if (
    assignments.length >= 5 &&
    assignments.some((line) => isSensitiveEnvironmentName(line.split("=", 1)[0] ?? ""))
  ) {
    return "an environment dump";
  }
  return null;
}

/** Remove recognized secret spans and known sensitive process-environment values. */
export function redactSensitiveText(
  text: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  const spans = findSecretMatches(text).map(({ start, end }) => ({ start, end }));
  for (const value of sensitiveEnvironmentValues(environment)) {
    let start = text.indexOf(value);
    while (start !== -1) {
      spans.push({ start, end: start + value.length });
      start = text.indexOf(value, start + 1);
    }
  }
  if (spans.length === 0) return text;

  spans.sort((left, right) => left.start - right.start || right.end - left.end);
  let result = "";
  let offset = 0;
  for (const span of spans) {
    if (span.start < offset) {
      offset = Math.max(offset, span.end);
      continue;
    }
    result += text.slice(offset, span.start) + "[REDACTED]";
    offset = span.end;
  }
  return result + text.slice(offset);
}

/** Sanitize values before serialization so JSON and TOON retain their structure. */
export function redactSensitiveValue<T>(
  value: T,
  environment: Record<string, string | undefined> = process.env,
): T {
  if (typeof value === "string") return redactSensitiveText(value, environment) as T;
  if (Array.isArray(value))
    return value.map((item) => redactSensitiveValue(item, environment)) as T;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return redactSensitiveText(value.toISOString(), environment) as T;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const serialized = JSON.stringify(item) ?? "undefined";
      const pair = `${JSON.stringify(key)}: ${serialized}`;
      const valueStart = pair.length - serialized.length;
      const contextualSecret =
        typeof item === "string" &&
        findSecretMatches(pair).some((match) => match.start < valueStart && match.end > valueStart);
      return [
        redactSensitiveText(key, environment),
        contextualSecret ? "[REDACTED]" : redactSensitiveValue(item, environment),
      ];
    }),
  ) as T;
}
