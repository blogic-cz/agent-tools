import { describe, expect, it, test } from "vitest";

import {
  detectSecrets,
  getBlockedCliTool,
  isGhCommandAllowed,
  isPathAllowed,
} from "../src/credential-guard/index";

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
