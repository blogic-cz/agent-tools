import { describe, expect, it, test } from "vitest";

import {
  createCredentialGuard,
  detectSecrets,
  getBlockedCliTool,
  isDangerousBashCommand,
  isGhCommandAllowed,
  isPathAllowed,
  isPathBlocked,
} from "#guard";

/* eslint-disable eslint/no-template-curly-in-string */

// Build example secret strings dynamically to avoid triggering credential guard
// self-detection. These are well-known example/test values, not real secrets.
const AWS_PREFIX = "AKIA";
const AWS_SUFFIX = "IOSFODNN7EXAMPLE";
const EXAMPLE_AWS_KEY = `${AWS_PREFIX}${AWS_SUFFIX}`;

const GHP_PREFIX = "ghp_";
const GHP_BODY = "x".repeat(36);
const EXAMPLE_GH_TOKEN = `${GHP_PREFIX}${GHP_BODY}`;

const SK_PREFIX = "sk-";
const SK_BODY = "x".repeat(48);
const EXAMPLE_OPENAI_KEY = `${SK_PREFIX}${SK_BODY}`;

// eslint-disable-next-line eslint/no-useless-concat -- intentionally split to avoid credential guard self-detection
const GENERIC_SECRET_VALUE = "my-super-" + "secret-password-12345-abcdef";

test("apps/web-app/.env.prod is NOT in default allowed paths", () => {
  // Should not be allowed by default (user must add via config)
  expect(isPathAllowed("apps/web-app/.env.prod")).toBe(false);
});

describe("detectSecrets", () => {
  describe("should detect real secrets", () => {
    it("detects AWS access keys", () => {
      const content = `aws_key = "${EXAMPLE_AWS_KEY}"`;
      const result = detectSecrets(content);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("AWS Access Key");
    });

    it("detects GitHub tokens", () => {
      const content = `token = "${EXAMPLE_GH_TOKEN}"`;
      const result = detectSecrets(content);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("GitHub Token");
    });

    it("detects OpenAI keys", () => {
      const content = `api_key = "${EXAMPLE_OPENAI_KEY}"`;
      const result = detectSecrets(content);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("OpenAI Key");
    });

    it("detects generic secrets with values (32+ chars)", () => {
      const content = `secret = "${GENERIC_SECRET_VALUE}"`;
      const result = detectSecrets(content);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Generic Secret");
    });

    it("detects private keys", () => {
      const begin = "-----BEGIN RSA";
      const end = " PRIVATE KEY-----";
      const content = `${begin}${end}`;
      const result = detectSecrets(content);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Private Key");
    });

    it("detects database URLs with credentials", () => {
      const proto = "postgres";
      const content = `${proto}://user:password123@localhost:5432/db`;
      const result = detectSecrets(content);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Database URL");
    });
  });

  describe("should NOT flag false positives", () => {
    it("allows environment variable declarations with SECRET in name", () => {
      const content = "K8S_IMAGE_PULL_SECRET: z.string().optional(),";
      const result = detectSecrets(content);
      expect(result).toBeNull();
    });

    it("allows BETTER_AUTH_SECRET env var declaration", () => {
      const content = "BETTER_AUTH_SECRET: z.string(),";
      const result = detectSecrets(content);
      expect(result).toBeNull();
    });

    it("allows env var references with process.env", () => {
      const content = "const secret = process.env.MY_SECRET";
      const result = detectSecrets(content);
      expect(result).toBeNull();
    });

    it("allows env var references with ${}", () => {
      const content = 'secret: "${MY_SECRET}"';
      const result = detectSecrets(content);
      expect(result).toBeNull();
    });

    it("allows TypeScript type declarations with secret in name", () => {
      const content = "type SecretConfig = { value: string }";
      const result = detectSecrets(content);
      expect(result).toBeNull();
    });

    it("allows Zod schema with secret field name", () => {
      const content = "secret: z.string().min(1),";
      const result = detectSecrets(content);
      expect(result).toBeNull();
    });

    it("allows Helm values with secret reference", () => {
      const content = '  - name: K8S_IMAGE_PULL_SECRET\n    value: "acr-secret"';
      const result = detectSecrets(content);
      expect(result).toBeNull();
    });

    it("allows database URL template literals with variable interpolation", () => {
      const protocol = "postgresql://";
      const user = "${user}";
      const pass = "${password}";
      const host = "${host}:${port}/${database}";
      const content = `const url = \`${protocol}${user}:${pass}@${host}\``;
      const result = detectSecrets(content);
      expect(result).toBeNull();
    });

    it("allows postgres URL template with env vars", () => {
      const protocol = "postgres://";
      const user = "${process.env.DB_USER}";
      const pass = "${process.env.DB_PASS}";
      const content = `const url = \`${protocol}${user}:${pass}@localhost:5432/db\``;
      const result = detectSecrets(content);
      expect(result).toBeNull();
    });

    it("allows mysql URL template with variables", () => {
      const protocol = "mysql://";
      const user = "${username}";
      const pass = "${password}";
      const host = "${host}";
      const content = `const url = \`${protocol}${user}:${pass}@${host}:3306/mydb\``;
      const result = detectSecrets(content);
      expect(result).toBeNull();
    });

    it("allows mongodb URL template with variables", () => {
      const protocol = "mongodb://";
      const user = "${user}";
      const pass = "${pass}";
      const host = "${host}";
      const content = `const url = \`${protocol}${user}:${pass}@${host}:27017/admin\``;
      const result = detectSecrets(content);
      expect(result).toBeNull();
    });
  });
});

describe("getBlockedCliTool", () => {
  it("blocks direct usage and suggests wrapper", () => {
    const result = getBlockedCliTool("gh pr view 96");
    expect(result).toEqual({
      name: "gh",
      wrapper: "agent-tools-gh",
    });
  });

  it("blocks issue list without -R flag", () => {
    const result = getBlockedCliTool("gh issue list --search foo");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("gh");
  });

  it("allows issue list with -R flag on external repo", () => {
    const result = getBlockedCliTool(
      'gh issue list -R gitbutlerapp/gitbutler --search "empty branch" --limit 20',
    );
    expect(result).toBeNull();
  });

  it("allows issue view with --repo flag on external repo", () => {
    const result = getBlockedCliTool("gh issue view 123 --repo gitbutlerapp/gitbutler");
    expect(result).toBeNull();
  });

  it("allows pr list with -R flag", () => {
    const result = getBlockedCliTool("gh pr list -R vercel/next.js --state open");
    expect(result).toBeNull();
  });

  it("allows search issues with -R flag", () => {
    const result = getBlockedCliTool('gh search issues -R effect-ts/effect "bug"');
    expect(result).toBeNull();
  });

  it("blocks api with -R flag (too powerful for allowlist)", () => {
    const result = getBlockedCliTool(
      "gh api repos/gitbutlerapp/gitbutler/issues -R gitbutlerapp/gitbutler",
    );
    expect(result).not.toBeNull();
    expect(result?.name).toBe("gh");
  });

  it("blocks issue create with -R flag (not in allowed list)", () => {
    const result = getBlockedCliTool("gh issue create -R someorg/somerepo --title test");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("gh");
  });

  it("blocks pr merge with -R flag (not in allowed list)", () => {
    const result = getBlockedCliTool("gh pr merge 42 -R someorg/somerepo");
    expect(result).not.toBeNull();
  });

  it("blocks chained commands where second is a write", () => {
    const result = getBlockedCliTool("gh issue list -R owner/repo ; gh pr merge 42");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("gh");
  });

  it("blocks chained commands with pipe to write", () => {
    const result = getBlockedCliTool("gh issue list -R owner/repo | gh issue create -R owner/repo");
    expect(result).not.toBeNull();
  });

  it("blocks chained commands with && to write", () => {
    const result = getBlockedCliTool("gh pr list -R owner/repo && gh pr merge 1");
    expect(result).not.toBeNull();
  });

  it("allows chained read-only commands on external repos", () => {
    const result = getBlockedCliTool("gh issue list -R owner/repo ; gh pr list -R owner/repo");
    expect(result).toBeNull();
  });

  it("blocks newline-separated commands with write", () => {
    const result = getBlockedCliTool("gh issue list -R owner/repo\ngh pr merge 42");
    expect(result).not.toBeNull();
  });

  it("blocks curl to dev.azure.com and suggests agent-tools-az", () => {
    const bearerHeader = "Authorization: Bearer xxx";
    const result = getBlockedCliTool(
      `curl -s -H "${bearerHeader}" "https://dev.azure.com/my-org/my-project/_apis/build/builds"`,
    );
    expect(result).toEqual({
      name: "curl (Azure DevOps)",
      wrapper: "agent-tools-az",
    });
  });

  it("blocks curl to dev.azure.com with different flag order", () => {
    const result = getBlockedCliTool(
      "curl https://dev.azure.com/my-org/my-project/_apis/pipelines",
    );
    expect(result).toEqual({
      name: "curl (Azure DevOps)",
      wrapper: "agent-tools-az",
    });
  });

  it("blocks curl to dev.azure.com even with pipe after domain", () => {
    const result = getBlockedCliTool(
      "curl https://dev.azure.com/my-org/my-project/_apis/build | jq .",
    );
    expect(result).toEqual({
      name: "curl (Azure DevOps)",
      wrapper: "agent-tools-az",
    });
  });

  it("does not block curl to other domains", () => {
    const result = getBlockedCliTool("curl https://api.github.com/repos");
    expect(result).toBeNull();
  });
});

describe("isGhCommandAllowed", () => {
  it("returns false for commands without -R flag", () => {
    expect(isGhCommandAllowed("gh issue list")).toBe(false);
  });

  it("returns true for allowed subcommands with -R", () => {
    expect(isGhCommandAllowed("gh issue list -R owner/repo")).toBe(true);
    expect(isGhCommandAllowed("gh pr view 42 -R owner/repo")).toBe(true);
    expect(isGhCommandAllowed("gh release list -R owner/repo")).toBe(true);
  });

  it("returns false for write subcommands with -R", () => {
    expect(isGhCommandAllowed("gh issue create -R owner/repo")).toBe(false);
    expect(isGhCommandAllowed("gh pr create -R owner/repo")).toBe(false);
    expect(isGhCommandAllowed("gh pr merge 1 -R owner/repo")).toBe(false);
  });
});

// ============================================================================
// ADVERSARIAL TESTS — path traversal, evasion, edge cases
// ============================================================================

describe("path traversal and evasion", () => {
  it("blocks path traversal to .env", () => {
    expect(isPathBlocked("src/../../.env")).toBe(true);
  });

  it("blocks path traversal to .ssh", () => {
    expect(isPathBlocked("project/../.ssh/id_rsa")).toBe(true);
  });

  it("blocks path traversal to .aws", () => {
    expect(isPathBlocked("deep/nested/../../.aws/credentials")).toBe(true);
  });

  it("blocks .env.local", () => {
    expect(isPathBlocked(".env.local")).toBe(true);
  });

  it("blocks .env.production", () => {
    expect(isPathBlocked(".env.production")).toBe(true);
  });

  it("blocks .pem files", () => {
    expect(isPathBlocked("certs/server.pem")).toBe(true);
  });

  it("blocks .key files", () => {
    expect(isPathBlocked("ssl/private.key")).toBe(true);
  });

  it("blocks .p12 files", () => {
    expect(isPathBlocked("certs/keystore.p12")).toBe(true);
  });

  it("blocks .pfx files", () => {
    expect(isPathBlocked("certs/cert.pfx")).toBe(true);
  });

  it("blocks kube config", () => {
    expect(isPathBlocked("home/.kube/config")).toBe(true);
  });

  it("blocks secrets directory (case insensitive)", () => {
    expect(isPathBlocked("deploy/secrets/prod.yaml")).toBe(true);
    expect(isPathBlocked("deploy/Secrets/prod.yaml")).toBe(true);
  });

  it("blocks credentials directory", () => {
    expect(isPathBlocked("infra/credentials/db.json")).toBe(true);
  });

  it("blocks .sentryclirc", () => {
    expect(isPathBlocked(".sentryclirc")).toBe(true);
  });

  it("allows .env.example", () => {
    expect(isPathBlocked(".env.example")).toBe(false);
  });

  it("allows .env.template", () => {
    expect(isPathBlocked(".env.template")).toBe(false);
  });

  it("allows .env.sample", () => {
    expect(isPathBlocked(".env.sample")).toBe(false);
  });

  it("allows normal source files", () => {
    expect(isPathBlocked("src/index.ts")).toBe(false);
    expect(isPathBlocked("package.json")).toBe(false);
    expect(isPathBlocked("README.md")).toBe(false);
  });
});

describe("dangerous bash command evasion", () => {
  it("blocks printenv", () => {
    expect(isDangerousBashCommand("printenv")).toBe(true);
  });

  it("blocks env at start", () => {
    expect(isDangerousBashCommand("env")).toBe(true);
  });

  it("blocks env after &&", () => {
    expect(isDangerousBashCommand("echo hi && env")).toBe(true);
  });

  it("blocks env after |", () => {
    expect(isDangerousBashCommand("ls | env")).toBe(true);
  });

  it("blocks env after ;", () => {
    expect(isDangerousBashCommand("ls ; env")).toBe(true);
  });

  it("blocks cat .env", () => {
    expect(isDangerousBashCommand("cat .env")).toBe(true);
  });

  it("blocks cat with path to .env", () => {
    expect(isDangerousBashCommand("cat /app/.env")).toBe(true);
  });

  it("blocks cat .pem", () => {
    expect(isDangerousBashCommand("cat server.pem")).toBe(true);
  });

  it("blocks cat .key", () => {
    expect(isDangerousBashCommand("cat private.key")).toBe(true);
  });

  it("blocks cat secrets path", () => {
    expect(isDangerousBashCommand("cat /etc/secret/token")).toBe(true);
  });

  it("blocks cat credentials path", () => {
    expect(isDangerousBashCommand("cat /home/user/credential/db.json")).toBe(true);
  });

  it("blocks cat .ssh path", () => {
    expect(isDangerousBashCommand("cat ~/.ssh/id_rsa")).toBe(true);
  });

  it("blocks cat .aws path", () => {
    expect(isDangerousBashCommand("cat ~/.aws/credentials")).toBe(true);
  });

  it("allows safe bash commands", () => {
    expect(isDangerousBashCommand("ls -la")).toBe(false);
    expect(isDangerousBashCommand("git status")).toBe(false);
    expect(isDangerousBashCommand("npm test")).toBe(false);
    expect(isDangerousBashCommand("cat README.md")).toBe(false);
  });
});

describe("CLI tool blocking edge cases", () => {
  it("blocks kubectl", () => {
    expect(getBlockedCliTool("kubectl get pods")).not.toBeNull();
    expect(getBlockedCliTool("kubectl get pods")?.wrapper).toBe("agent-tools-k8s");
  });

  it("blocks psql", () => {
    expect(getBlockedCliTool("psql -h localhost mydb")).not.toBeNull();
    expect(getBlockedCliTool("psql -h localhost mydb")?.wrapper).toBe("agent-tools-db");
  });

  it("blocks az", () => {
    expect(getBlockedCliTool("az login")).not.toBeNull();
    expect(getBlockedCliTool("az login")?.wrapper).toBe("agent-tools-az");
  });

  it("blocks chained CLI tools after ;", () => {
    expect(getBlockedCliTool("echo hi ; kubectl get secrets")).not.toBeNull();
  });

  it("blocks chained CLI tools after &&", () => {
    expect(getBlockedCliTool("echo hi && psql -c 'SELECT 1'")).not.toBeNull();
  });

  it("blocks chained CLI tools after |", () => {
    expect(getBlockedCliTool("echo hi | az pipelines list")).not.toBeNull();
  });

  it("does not block non-matching commands", () => {
    expect(getBlockedCliTool("npm install")).toBeNull();
    expect(getBlockedCliTool("git push")).toBeNull();
    expect(getBlockedCliTool("bun test")).toBeNull();
  });
});

describe("createCredentialGuard with custom config", () => {
  it("merges additional blocked paths", () => {
    const guard = createCredentialGuard({
      additionalBlockedPaths: ["custom/secret"],
    });
    expect(guard.isPathBlocked("custom/secret/data.json")).toBe(true);
    // Default patterns still work
    expect(guard.isPathBlocked(".env")).toBe(true);
  });

  it("merges additional allowed paths", () => {
    const guard = createCredentialGuard({
      additionalAllowedPaths: ["\\.env\\.test$"],
    });
    expect(guard.isPathBlocked(".env.test")).toBe(false);
  });

  it("merges additional dangerous bash patterns", () => {
    const guard = createCredentialGuard({
      additionalDangerousBashPatterns: ["rm -rf /"],
    });
    expect(guard.isDangerousBashCommand("rm -rf /")).toBe(true);
    // Default patterns still work
    expect(guard.isDangerousBashCommand("printenv")).toBe(true);
  });

  it("merges additional blocked CLI tools", () => {
    const guard = createCredentialGuard({
      additionalBlockedCliTools: [{ tool: "helm", suggestion: "Use agent-tools-k8s" }],
    });
    const result = guard.getBlockedCliTool("helm install mychart");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("helm");
    expect(result?.wrapper).toBe("Use agent-tools-k8s");
  });

  it("works with empty config", () => {
    const guard = createCredentialGuard({});
    expect(guard.isPathBlocked(".env")).toBe(true);
    expect(guard.isDangerousBashCommand("printenv")).toBe(true);
  });
});
