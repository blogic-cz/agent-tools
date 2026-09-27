/** Patterns used by the credential guard and shared output redaction. */
export const SECRET_PATTERNS = [
  { name: "AWS Access Key", pattern: /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/ },
  { name: "GitHub Token", pattern: /gh[ps]_[A-Za-z0-9]{36}/ },
  { name: "GitHub PAT", pattern: /github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}/ },
  { name: "OpenAI Key", pattern: /sk-[A-Za-z0-9]{48}/ },
  {
    name: "Generic API Key",
    pattern: /(?:api[_-]?key|apikey)["\s:=]+["']?([A-Za-z0-9_-]{20,})["']?/i,
  },
  {
    name: "Generic Secret",
    pattern:
      /(?:secret|token|password|passwd|pwd)["  \t:=]+["']?(?!\$\{|process\.env|z\.|generate|create|read|get|fetch|import|export|const|function|return|Schema)[^\s"']{32,}["']?/i,
  },
  {
    // eslint-disable-next-line eslint/no-useless-concat -- intentionally split to avoid credential guard self-detection
    name: "Priv" + "ate Key",
    pattern: new RegExp("-----BEGIN.*PRIVATE KEY-----"),
  },
  {
    name: "JWT Token",
    pattern: /(?:["'=:\s]|^)eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  { name: "Azure SAS Token", pattern: /[?&]sig=[A-Za-z0-9%+/=]{20,}/ },
  { name: "GCP Service Account Key", pattern: /"type"\s*:\s*"service_account"/ },
  {
    name: "Slack Webhook URL",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
  },
  {
    name: "Discord Webhook URL",
    pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/,
  },
  {
    name: "Database URL",
    pattern: /(?:postgres(?:ql)?|mysql|mongodb):\/\/(?!\$\{)[^:]+:(?!\$\{)[^@]+@/,
  },
];

export function findSecretMatches(
  content: string,
): Array<{ name: string; start: number; end: number }> {
  const matches: Array<{ name: string; start: number; end: number }> = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    const scanner = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    for (const match of content.matchAll(scanner)) {
      const start = match.index;
      let end = start + match[0].length;
      if (name === "Private Key") {
        const remainder = content.slice(end);
        const closing = /^\r?\n?[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/.exec(remainder);
        end += closing?.[0].length ?? remainder.length;
      }
      matches.push({ name, start, end });
    }
  }
  return matches;
}
