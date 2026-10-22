import { spawnSync } from "node:child_process";
import { describe, expect, it, test } from "vitest";

import {
  createCredentialGuard,
  detectSecrets,
  detectSleepPolling,
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
const EXAMPLE_SCM_TOKEN = `${GHP_PREFIX}${GHP_BODY}`;

const SK_PREFIX = "sk-";
const SK_BODY = "x".repeat(48);
const EXAMPLE_OPENAI_KEY = `${SK_PREFIX}${SK_BODY}`;
const SYNTHETIC_HANDLER_TOKEN = `ghp_${"A".repeat(36)}`;

// eslint-disable-next-line eslint/no-useless-concat -- intentionally split to avoid credential guard self-detection
const GENERIC_SECRET_VALUE = "my-super-" + "secret-password-12345-abcdef";

describe("credential guard handler error redaction", () => {
  it("redacts credentials from blocked Bash, Read, and Write errors", () => {
    const guard = createCredentialGuard();
    const cases = [
      () =>
        guard.handleToolExecuteBefore(
          { tool: "Bash" },
          { args: { command: `cat .env; echo ${SYNTHETIC_HANDLER_TOKEN}` } },
        ),
      () =>
        guard.handleToolExecuteBefore(
          { tool: "Read" },
          { args: { filePath: `/workspace/secrets/${SYNTHETIC_HANDLER_TOKEN}.txt` } },
        ),
      () =>
        guard.handleToolExecuteBefore(
          { tool: "Write" },
          {
            args: {
              filePath: "src/example.ts",
              content: `const token = "${SYNTHETIC_HANDLER_TOKEN}";`,
            },
          },
        ),
    ];

    for (const invoke of cases) {
      let message = "";
      try {
        invoke();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain(SYNTHETIC_HANDLER_TOKEN);
    }
  });

  it("redacts process environment values and protects raw adapter error output", () => {
    const envName = "AGENT_TOOLS_SYNTHETIC_AUTH_TOKEN";
    const envValue = "synthetic-auth-value-0123456789";
    const previousValue = process.env[envName];
    process.env[envName] = envValue;
    try {
      let message = "";
      try {
        createCredentialGuard().handleToolExecuteBefore(
          { tool: "Bash" },
          { args: { command: `cat .env; echo ${envValue}` } },
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain(envValue);
    } finally {
      if (previousValue === undefined) delete process.env[envName];
      else process.env[envName] = previousValue;
    }

    const result = spawnSync(
      "bun",
      [
        "-e",
        `import { createCredentialGuard } from "./src/credential-guard/index.ts"; const token = process.env.SYNTHETIC_TOKEN; try { createCredentialGuard().handleToolExecuteBefore({ tool: "Bash" }, { args: { command: "cat .env; echo " + token } }); } catch (error) { process.stderr.write(error.message); }`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, SYNTHETIC_TOKEN: SYNTHETIC_HANDLER_TOKEN },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(SYNTHETIC_HANDLER_TOKEN);
  });

  it.each(["$&", "$$", "$`", "$'", "$1", "$<name>"])(
    "keeps literal replacement marker %s while redacting cached stacks",
    (marker) => {
      const original = new Error(`synthetic ${SYNTHETIC_HANDLER_TOKEN} literal ${marker} end`);
      expect(original.stack).toContain(SYNTHETIC_HANDLER_TOKEN);
      const args = {
        get command(): string {
          throw original;
        },
      };

      let caught: unknown;
      try {
        createCredentialGuard().handleToolExecuteBefore({ tool: "Bash" }, { args });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(original);
      expect(original.message).toContain("[REDACTED]");
      expect(original.message).toContain(marker);
      expect(original.message).not.toContain(SYNTHETIC_HANDLER_TOKEN);
      expect(original.stack).toContain("[REDACTED]");
      expect(original.stack).toContain(marker);
      expect(original.stack).not.toContain(SYNTHETIC_HANDLER_TOKEN);
    },
  );
});

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
      const content = `token = "${EXAMPLE_SCM_TOKEN}"`;
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

  it("blocks curl to dev.azure.com and suggests agent-tools-azdo", () => {
    const bearerHeader = "Authorization: Bearer xxx";
    const result = getBlockedCliTool(
      `curl -s -H "${bearerHeader}" "https://dev.azure.com/my-org/my-project/_apis/build/builds"`,
    );
    expect(result).toEqual({
      name: "curl (Azure DevOps)",
      wrapper: "agent-tools-azdo",
    });
  });

  it("blocks curl to dev.azure.com with different flag order", () => {
    const result = getBlockedCliTool(
      "curl https://dev.azure.com/my-org/my-project/_apis/pipelines",
    );
    expect(result).toEqual({
      name: "curl (Azure DevOps)",
      wrapper: "agent-tools-azdo",
    });
  });

  it("blocks curl to dev.azure.com even with pipe after domain", () => {
    const result = getBlockedCliTool(
      "curl https://dev.azure.com/my-org/my-project/_apis/build | jq .",
    );
    expect(result).toEqual({
      name: "curl (Azure DevOps)",
      wrapper: "agent-tools-azdo",
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
  it.each([
    "/proc/self/environ",
    "/proc/thread-self/environ",
    "/proc/12345/environ",
    "/proc/$$/environ",
    "/proc/${$}/environ",
    "/proc/self/task/23456/environ",
    "/proc/self/task/$$/environ",
    "/proc/${$}/task/12345/environ",
    "/proc/12345/task/23456/environ",
    "../../proc/self/environ",
    "./proc/self/environ",
    String.raw`\proc\self\environ`,
  ])("blocks Linux process environment files: %s", (path) => {
    expect(isPathBlocked(path)).toBe(true);
  });

  it("does not let configured allow paths permit process environment files", () => {
    const guard = createCredentialGuard({
      additionalAllowedPaths: [".*proc.*environ$"],
    });
    expect(guard.isPathAllowed("/proc/self/environ")).toBe(false);
    expect(guard.isPathBlocked("/proc/self/environ")).toBe(true);
    expect(guard.isPathBlocked("/proc/123/task/456/environ")).toBe(true);
    expect(guard.isPathBlocked("/proc/$$/environ")).toBe(true);
    expect(guard.isPathBlocked("/proc/self/task/$$/environ")).toBe(true);
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Read" }, { args: { filePath: "/proc/self/environ" } }),
    ).toThrow("Access blocked");
    expect(guard.isDangerousBashCommand("cat /proc/$$/environ")).toBe(true);
    expect(guard.isDangerousBashCommand("head -c 10 < /proc/self/task/$$/environ")).toBe(true);
  });

  it.each([
    "cat /proc/self/environ",
    "cat /proc/$$/environ",
    "head -c 10 /proc/${$}/environ",
    "head -c 10 < /proc/$$/environ",
    "head -c 10 /proc/thread-self/environ",
    "grep TOKEN /proc/123/environ",
    "rg TOKEN /proc/123/task/456/environ",
    "cat /proc/self/task/$$/environ",
    "head -c 10 < /proc/$$/task/123/environ",
    "cat /proc/$BASHPID/environ",
    "cat /proc/${PPID}/environ",
    `python -c 'from pathlib import Path; print(Path("/proc/self/environ").read_text())'`,
    `node -e 'require("fs").readFileSync("/proc/thread-self/environ")'`,
  ])("blocks process environment reads through Bash: %s", (command) => {
    expect(isDangerousBashCommand(command)).toBe(true);
  });

  it.each([
    "cat /proc/self/status",
    "cat /proc/123/environ.txt",
    "cat /proc/self/environ/extra",
    "cat /tmp/environ",
    "cat workspace/proc/self/environ",
    "echo '/proc/self/environ'",
    "echo '/proc/$$/environ'",
    "printf '%s\\n' environ > /tmp/environ",
  ])("keeps benign proc paths and literal mentions allowed: %s", (command) => {
    expect(isDangerousBashCommand(command)).toBe(false);
  });

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

describe("CLI tool blocking edge cases", () => {
  it("blocks kubectl", () => {
    expect(getBlockedCliTool("kubectl get pods")).not.toBeNull();
    expect(getBlockedCliTool("kubectl get pods")?.wrapper).toBe("agent-tools-k8s");
  });

  it("blocks psql", () => {
    expect(getBlockedCliTool("psql -h localhost mydb")).not.toBeNull();
    expect(getBlockedCliTool("psql -h localhost mydb")?.wrapper).toBe("agent-tools-db");
  });

  it("blocks az and routes platform commands to agent-tools-az", () => {
    expect(getBlockedCliTool("az login")).not.toBeNull();
    expect(getBlockedCliTool("az login")?.wrapper).toBe("agent-tools-az");
    expect(getBlockedCliTool("az vm list")?.wrapper).toBe("agent-tools-az");
    expect(getBlockedCliTool("az keyvault secret show --name pw")?.wrapper).toBe("agent-tools-az");
  });

  it("routes az Azure DevOps commands to agent-tools-azdo", () => {
    expect(getBlockedCliTool("az pipelines list")?.wrapper).toBe("agent-tools-azdo");
    expect(getBlockedCliTool("az repos show --id 1")?.wrapper).toBe("agent-tools-azdo");
    expect(getBlockedCliTool("az boards work-item show --id 1")?.wrapper).toBe("agent-tools-azdo");
    expect(getBlockedCliTool("az devops invoke --area build")?.wrapper).toBe("agent-tools-azdo");
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

describe("detectSleepPolling", () => {
  it("detects sleep + workflow list polling", () => {
    const result = detectSleepPolling("sleep 60 && bun agent-tools-gh workflow list --limit 4");
    expect(result).toContain("workflow watch");
  });

  it("detects sleep + workflow jobs polling", () => {
    const result = detectSleepPolling(
      'sleep 180 && echo "=== PROD ===" && bun agent-tools-gh workflow jobs --run 123',
    );
    expect(result).toContain("workflow watch");
  });

  it("detects sleep + workflow view polling", () => {
    const result = detectSleepPolling("sleep 30 && bun agent-tools-gh workflow view --run 456");
    expect(result).toContain("workflow watch");
  });

  it("detects sleep + workflow logs polling", () => {
    const result = detectSleepPolling("sleep 120 && bun agent-tools-gh workflow logs --run 789");
    expect(result).toContain("workflow watch");
  });

  it("detects sleep + pr checks without --watch", () => {
    const result = detectSleepPolling("sleep 30 && bun agent-tools-gh pr checks --pr 123");
    expect(result).toContain("pr checks");
    expect(result).toContain("--watch");
  });

  it("detects sleep + pr rerun-checks polling", () => {
    const result = detectSleepPolling("sleep 60 && bun agent-tools-gh pr rerun-checks --pr 123");
    expect(result).toContain("pr checks");
    expect(result).toContain("--watch");
  });

  it("detects sleep + k8s polling", () => {
    const result = detectSleepPolling(
      'sleep 10 && bun agent-tools-k8s kubectl --env test --cmd "get pods"',
    );
    expect(result).toContain("wait");
  });

  it("detects sleep + az pipeline run polling", () => {
    const result = detectSleepPolling(
      "sleep 60 && bun agent-tools-azdo cmd --cmd 'pipelines runs list'",
    );
    expect(result).toContain("agent-tools-azdo");
  });

  it("allows plain sleep without agent-tools", () => {
    expect(detectSleepPolling("sleep 3")).toBeNull();
  });

  it("allows sleep with unrelated commands", () => {
    expect(detectSleepPolling("sleep 5 && bun test")).toBeNull();
    expect(detectSleepPolling("sleep 2 && echo done")).toBeNull();
    expect(detectSleepPolling("sleep 1 && npm run build")).toBeNull();
  });

  it("allows pr checks with --watch (not polling)", () => {
    expect(
      detectSleepPolling("sleep 5 && bun agent-tools-gh pr checks --pr 123 --watch"),
    ).toBeNull();
  });

  it("detects sleep + workflow job-logs polling", () => {
    const result = detectSleepPolling(
      "sleep 30 && bun agent-tools-gh workflow job-logs --run 123 --job build",
    );
    expect(result).toContain("workflow watch");
  });

  it("detects polling via script alias (gh-tool)", () => {
    const result = detectSleepPolling("sleep 60 && bun run gh-tool -- workflow list --limit 5");
    expect(result).toContain("workflow watch");
  });

  it("detects polling with semicolon separator", () => {
    const result = detectSleepPolling("sleep 60 ; bun agent-tools-gh workflow jobs --run 1");
    expect(result).toContain("workflow watch");
  });

  it("detects polling with pipe separator", () => {
    const result = detectSleepPolling(
      'sleep 30 && bun agent-tools-gh workflow view --run 1 | grep -E "status"',
    );
    expect(result).toContain("workflow watch");
  });

  it("detects az pipeline singular form", () => {
    const result = detectSleepPolling("sleep 60 && az pipeline run show --id 123");
    expect(result).toContain("agent-tools-azdo");
  });

  it("allows sleep + workflow watch (not polling)", () => {
    expect(detectSleepPolling("sleep 5 && bun agent-tools-gh workflow watch --run 123")).toBeNull();
  });

  it("allows sleep + pr checks-failed (not polling)", () => {
    expect(
      detectSleepPolling("sleep 5 && bun agent-tools-gh pr checks-failed --pr 123"),
    ).toBeNull();
  });

  it("allows commands without sleep", () => {
    expect(detectSleepPolling("bun agent-tools-gh workflow list")).toBeNull();
    expect(detectSleepPolling("bun agent-tools-k8s pods --env test")).toBeNull();
  });

  it("blocks via handleToolExecuteBefore", () => {
    const guard = createCredentialGuard();
    expect(() =>
      guard.handleToolExecuteBefore(
        { tool: "bash" },
        { args: { command: "sleep 60 && bun agent-tools-gh workflow jobs --run 123" } },
      ),
    ).toThrow("Sleep-polling detected");
  });

  it("allows non-polling via handleToolExecuteBefore", () => {
    expect(() =>
      createCredentialGuard().handleToolExecuteBefore(
        { tool: "bash" },
        { args: { command: "sleep 3 && echo done" } },
      ),
    ).not.toThrow();
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

// ============================================================================
// TOOL NAME NORMALIZATION — cross-platform compatibility
// ============================================================================

describe("handleToolExecuteBefore tool name normalization", () => {
  const guard = createCredentialGuard();

  it("blocks raw gh via lowercase 'bash' (existing behavior)", () => {
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "bash" }, { args: { command: "gh issue list" } }),
    ).toThrow("wrapper-required: gh");
  });

  it("blocks raw gh via an AI coding agent's capitalized 'Bash'", () => {
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: "gh issue list" } }),
    ).toThrow("wrapper-required: gh");
  });

  it("blocks raw gh via OpenCode MCP 'mcp_bash'", () => {
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "mcp_bash" }, { args: { command: "gh issue list" } }),
    ).toThrow("wrapper-required: gh");
  });

  it("blocks .env read via an AI coding agent's capitalized 'Read'", () => {
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Read" }, { args: { filePath: ".env" } }),
    ).toThrow("Access blocked");
  });

  it("blocks .env read via OpenCode MCP 'mcp_read'", () => {
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "mcp_read" }, { args: { filePath: ".env" } }),
    ).toThrow("Access blocked");
  });

  it("blocks secret write via OpenCode MCP 'mcp_write'", () => {
    expect(() =>
      guard.handleToolExecuteBefore(
        { tool: "mcp_write" },
        { args: { filePath: "config.ts", content: `token = "${EXAMPLE_SCM_TOKEN}"` } },
      ),
    ).toThrow("Secret detected");
  });

  it("blocks .env edit via OpenCode MCP 'mcp_edit'", () => {
    expect(() =>
      guard.handleToolExecuteBefore(
        { tool: "mcp_edit" },
        { args: { filePath: ".env.production" } },
      ),
    ).toThrow("Access blocked");
  });

  it("allows safe commands via MCP tool names", () => {
    expect(() =>
      guard.handleToolExecuteBefore(
        { tool: "mcp_bash" },
        { args: { command: "bun agent-tools-gh pr list" } },
      ),
    ).not.toThrow();
  });

  it("allows safe file reads via MCP tool names", () => {
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "mcp_read" }, { args: { filePath: "src/index.ts" } }),
    ).not.toThrow();
  });
});

// Regression inputs are inspected by the hook only; none is executed by a shell.

describe("credential guard recovery families", () => {
  it.each([
    ["env", "secret-source", "Do not dump credentials or the environment"],
    ["echo $UNAPPROVED_VALUE", "ambient-expansion", "allowedEnvironmentVariables"],
    ["cat .env", "sensitive-path", "nonsensitive example or template"],
    ["python3 -c 'print(1)'", "no-analyzer", "cannot inspect this code form"],
    ["gh pr list", "wrapper-required", "Use the configured wrapper"],
    ["echo 'unterminated", "unparseable", "complete literal shell syntax"],
  ])("explains %s with its rule family", (command, rule, hint) => {
    const invoke = () =>
      createCredentialGuard().handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
    expect(invoke).toThrow(rule);
    expect(invoke).toThrow(hint);
  });
  it("emits one recovery hint per rule family", () => {
    try {
      createCredentialGuard().handleToolExecuteBefore(
        { tool: "Bash" },
        { args: { command: "env; printenv" } },
      );
      expect.unreachable("environment listing must refuse");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message.split("Do not dump credentials or the environment")).toHaveLength(2);
    }
  });
});

describe("Grep path and glob fields", () => {
  it.each([".env*", "**/.env", "*.json", "*.key"])("refuses protected glob %s", (glob) => {
    expect(() =>
      createCredentialGuard().handleToolExecuteBefore(
        { tool: "Grep" },
        { args: { pattern: "example", glob } },
      ),
    ).toThrow();
  });
  it.each(["*.ts", "README.md", "!*.json"])("permits safe glob %s", (glob) => {
    expect(() =>
      createCredentialGuard().handleToolExecuteBefore(
        { tool: "Grep" },
        { args: { pattern: "example", glob } },
      ),
    ).not.toThrow();
  });
  it("refuses the protected directory itself", () => {
    expect(() =>
      createCredentialGuard().handleToolExecuteBefore(
        { tool: "Grep" },
        { args: { pattern: "example", path: "/repo/.ssh" } },
      ),
    ).toThrow();
  });
});
