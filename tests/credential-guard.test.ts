import { describe, expect, it, test } from "vitest";
import { spawnSync } from "node:child_process";
import corpus from "./fixtures/credential-guard-corpus.json";
import argvRoleCases from "./fixtures/credential-guard-argv-roles.json";

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
const CREDENTIAL_GUARD_HOOK_PATH = ".agent/hooks/credential-guard.ts";

describe("credential guard corpus", () => {
  it.each(corpus)("$label: $command", (entry) => {
    const guard = createCredentialGuard("config" in entry ? entry.config : undefined);
    expect(guard.isDangerousBashCommand(entry.command)).toBe(entry.label !== "FP");
  });
});

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

describe("dangerous bash command evasion", () => {
  it.each([
    "cat ~/.kube/config",
    "cat cert.p12",
    "cat .sentryclirc",
    "rtk proxy cat ~/.kube/config",
  ])("uses canonical blocked paths for Bash reads: %s", (command) => {
    expect(isDangerousBashCommand(command)).toBe(true);
  });

  it("uses configured blocked and allowed paths for Bash reads", () => {
    const guard = createCredentialGuard({
      additionalBlockedPaths: ["private/custom.dat"],
      additionalAllowedPaths: ["private/public.dat"],
    });
    expect(guard.isDangerousBashCommand("cat private/custom.dat")).toBe(true);
    expect(guard.isDangerousBashCommand("cat private/public.dat")).toBe(false);
  });

  it.each([
    "rtk gh auth token",
    "rtk proxy gh auth token",
    "command gh auth token",
    "echo start && rtk proxy gh auth token",
  ])("blocks credential CLI through wrappers: %s", (command) => {
    expect(getBlockedCliTool(command)).toEqual({ name: "gh", wrapper: "agent-tools-gh" });
    expect(() =>
      createCredentialGuard().handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).toThrow("Direct gh usage blocked");
  });

  it("keeps external repository readonly gh exceptions per command and through wrappers", () => {
    expect(
      getBlockedCliTool(
        "rtk gh issue list -R owner/repo ; rtk proxy gh pr view 42 --repo other/repo",
      ),
    ).toBeNull();
    expect(getBlockedCliTool("rtk gh issue list -R owner/repo ; command gh auth token")).toEqual({
      name: "gh",
      wrapper: "agent-tools-gh",
    });
  });

  it.each([
    "env -u CI bun check.ts > /tmp/check.log 2>&1",
    'herdr agent prompt worker "read the instruction" >/dev/null',
    'herdr agent prompt worker "read the instruction" | head -c 40',
    'herdr agent prompt worker "read the instruction" && git status --short',
    `cat ${CREDENTIAL_GUARD_HOOK_PATH}`,
    "jq '{a: .foo, b: .bar}' report.json",
    'F=README.md; echo "$F"',
    "echo PANE=$HERDR_PANE_ID",
    "printf '%s\\n' \"PANE=$HERDR_PANE_ID\"",
    "git status --short; echo SHA=$GIT_COMMIT",
    'S=/private/tmp/scratchpad; W=/tmp/worktree; herdr tab create --cwd $W/core-512-transmittal-import --label tab-a | grep -o \'"pane_id":"[^"]*"\' | head -1; herdr tab create --cwd $W/core512-f4 --label tab-b | grep -o \'"pane_id":"[^"]*"\' | head -1',
    "W=/tmp/worktree; L=tab-a; herdr tab create --cwd=$W/core-512-transmittal-import --label=$L",
  ])("allows bounded non-secret command: %s", (command) => {
    const guard = createCredentialGuard({
      allowedEnvironmentVariables: ["HERDR_PANE_ID", "GIT_COMMIT"],
    });
    expect(guard.isDangerousBashCommand(command)).toBe(false);
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  });

  it.each([
    "echo $UNKNOWN",
    'echo "$TOKEN"; TOKEN=literal',
    "echo ${!HERDR_PANE_ID}",
    'echo "$(printenv HERDR_PANE_ID)"',
    "echo ok > `printenv`",
    "echo $HERDR_PANE_ID | sh",
    'bun -e "console.log(process.env.HERDR_PANE_ID)"',
    'herdr agent prompt worker "read $(cat .env)"',
    "herdr tab create --cwd $UNKNOWN",
    "W=/tmp/worktree; herdr tab create --cwd $W --env TOKEN=$W",
    "W=/tmp/worktree; herdr tab create --cwd $W --unknown value",
    "W=/tmp/worktree; herdr tab create --cwd $W --cwd /tmp/other",
    "W=/tmp/worktree; herdr tab create --cwd $W --label",
    "W=/tmp/worktree; herdr tab create --cwd $W --label --focus",
    "W=/tmp/worktree; herdr tab create --cwd $W --focus --no-focus",
    "W=/tmp/worktree; herdr tab create --cwd $W -- sh -c 'cat .env'",
    "W=/tmp/worktree; herdr tab create --cwd $(cat .env)",
    "IFS=/; W=tmp/--env/BASH_ENV; herdr tab create --cwd $W=/tmp/payload",
    "IFS=/; W=tmp/--env/LD_PRELOAD; herdr tab create --cwd $W=/tmp/payload.so",
    "rtk gh auth token | head -c 4",
    'F=README.md; true; F=.env; cat "$F"',
    'F=README.md; eval "F=.env"; cat "$F"',
    'F=README.md; source update-path.sh; cat "$F"',
  ])("keeps dynamic or executable access blocked: %s", (command) => {
    const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_PANE_ID"] });
    expect(guard.isDangerousBashCommand(command) || guard.getBlockedCliTool(command) !== null).toBe(
      true,
    );
  });

  describe("approved shell empty default display", () => {
    const exactCommand =
      'echo "HERDR_ENV=${HERDR_ENV:-}"; herdr workspace list 2>&1 | head -60; herdr agent list 2>&1 | head -80';

    it.each([
      exactCommand,
      'echo "${HERDR_ENV:-}"',
      'echo "prefix=${HERDR_ENV:-}" | head -c 60',
      'printf "%s\\n" "${HERDR_ENV:-}" | cut -c 1-60',
      'rtk proxy printf -- "%s" "HERDR_ENV=${HERDR_ENV:-}" | head',
      'test "${HERDR_ENV:-}" = 1',
      '[ "${HERDR_ENV:-}" = "" ]',
      'test -n "${HERDR_ENV:-}"',
      'echo "$HERDR_ENV ${HERDR_ENV:-}"',
    ])("allows quoted approved empty defaults in data roles: %s", (command) => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_ENV"] });
      expect(guard.isDangerousBashCommand(command)).toBe(false);
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).not.toThrow();
    });

    it.each([undefined, [], ["OTHER_NAME"], ["HERDR_ENV_OTHER"], ["herdr_env"]])(
      "requires the exact approved name under policy %j",
      (allowedEnvironmentVariables) => {
        expect(
          createCredentialGuard({ allowedEnvironmentVariables }).isDangerousBashCommand(
            exactCommand,
          ),
        ).toBe(true);
      },
    );

    it.each([
      "echo ${HERDR_ENV:-}",
      'echo "${NOT_APPROVED:-}"',
      'echo "${HERDR_ENV:-fallback}"',
      'echo "${HERDR_ENV:-$HERDR_ENV}"',
      'echo "${HERDR_ENV:-${HERDR_ENV:-}}"',
      'echo "${HERDR_ENV:-$(echo fallback)}"',
      'echo "${!HERDR_ENV:-}"',
      'echo "${HERDR_ENV-}"',
      'echo "${HERDR_ENV:=}"',
      'echo "${HERDR_ENV:+}"',
      'echo "${HERDR_ENV:?}"',
      'echo "${HERDR_ENV:-}',
      '"${HERDR_ENV:-}" argument',
      'printf "${HERDR_ENV:-}"',
      'printf -- "${HERDR_ENV:-}" value',
      'printf -v "${HERDR_ENV:-}" "%s" value',
      'printf "%n" "${HERDR_ENV:-}"',
      'eval "${HERDR_ENV:-}"',
      'sh -c "${HERDR_ENV:-}"',
      'node -e "${HERDR_ENV:-}"',
      'echo "$(echo "${HERDR_ENV:-}")"',
      'echo "${HERDR_ENV:-}" | sh',
      'echo "${HERDR_ENV:-}" | xargs',
      'echo "${HERDR_ENV:-}" | unknown-runner',
      'echo "${HERDR_ENV:-}" > /tmp/env-output',
      'echo static > "${HERDR_ENV:-}"',
      'BASH_ENV="${HERDR_ENV:-}" bash script.sh',
      'HERDR_ENV="${HERDR_ENV:-}" echo static',
      'echo "${HERDR_ENV:-}"; cat .env',
      'echo "${HERDR_ENV:-}"; echo "$NOT_APPROVED"',
    ])("keeps unsafe defaults and executable roles blocked: %s", (command) => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_ENV"] });
      expect(guard.isDangerousBashCommand(command)).toBe(true);
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).toThrow();
    });

    it("keeps configured command policies active", () => {
      expect(
        createCredentialGuard({
          allowedEnvironmentVariables: ["HERDR_ENV"],
          additionalDangerousBashPatterns: ["HERDR_ENV"],
        }).isDangerousBashCommand(exactCommand),
      ).toBe(true);
    });
  });

  describe("approved Python environment display", () => {
    const approvedNames = ["CODEX_SESSION_ID", "HERDR_ENV"];
    const program =
      "import os; print('CODEX_SESSION_ID='+os.environ.get('CODEX_SESSION_ID','<absent>')); print('HERDR_ENV='+os.environ.get('HERDR_ENV','<absent>'))";
    const inline = (source: string, prefix = "") =>
      `${prefix}python3 -c '${source.replaceAll("'", "'\"'\"'")}'`;

    const jsonNames = [
      "HERDR_ENV",
      "CODEX_SESSION_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_TAB_ID",
      "HERDR_PANE_ID",
    ];
    const jsonProgram =
      'import os,json; print(json.dumps({k:os.environ.get(k) for k in ["HERDR_ENV","CODEX_SESSION_ID","HERDR_WORKSPACE_ID","HERDR_TAB_ID","HERDR_PANE_ID"]}))';

    it("allows the reported JSON projection only with every name approved", () => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: jsonNames });
      for (const prefix of ["", "rtk proxy "]) {
        for (const command of [
          inline(jsonProgram, prefix),
          `${prefix}python3 - <<'PY'\n${jsonProgram}\nPY`,
        ]) {
          expect(guard.isDangerousBashCommand(command)).toBe(false);
          expect(() =>
            guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
          ).not.toThrow();
          for (const allowedEnvironmentVariables of [
            [],
            jsonNames.filter((name) => name !== "HERDR_TAB_ID"),
            ...jsonNames.map((missing) => jsonNames.filter((name) => name !== missing)),
          ]) {
            expect(
              createCredentialGuard({ allowedEnvironmentVariables }).isDangerousBashCommand(
                command,
              ),
            ).toBe(true);
          }
        }
      }
      expect(isDangerousBashCommand(inline(jsonProgram))).toBe(true);
    });

    it.each([
      "import os,json; print(json.dumps({name:os.getenv(name) for name in ['WORKSPACE_LABEL','TEST_FLAG']}))",
      "import json,os; print(json.dumps([os.environ[name] for name in ['TEST_FLAG','WORKSPACE_LABEL']]))",
      "import os; import json; print(json.dumps([os.environ.get(key, '<absent>') for key in ['TEST_FLAG']]))",
      "import os\nimport json\nprint(json.dumps({'TEST_FLAG':os.getenv('TEST_FLAG'), 'WORKSPACE_LABEL':os.environ['WORKSPACE_LABEL']}))",
      "import os,json; print(json.dumps([os.getenv('TEST_FLAG'), os.environ.get('WORKSPACE_LABEL')]))",
      "import os,json; print(json.dumps({key:os.environ[key] for key in ['TEST_FLAG',]}))",
    ])("allows generic literal JSON projections: %s", (source) => {
      const guard = createCredentialGuard({
        allowedEnvironmentVariables: ["TEST_FLAG", "WORKSPACE_LABEL"],
      });
      expect(guard.isDangerousBashCommand(inline(source))).toBe(false);
    });

    it.each([
      "import jsonos; print(os.getenv('HERDR_ENV'))",
      "import os,jsonos; print(json.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')}))",
      "import os,json; print(json.dumps(os.environ))",
      "import os,json; print(json.dumps(dict(os.environ)))",
      "import os,json; print(json.dumps({k:os.environ.get(k) for k in os.environ}))",
      "import os,json; print(json.dumps({k:os.environ.get(k) for k in ['HERDR_ENV','NOT_APPROVED']}))",
      "import os,json; print(json.dumps({k:os.environ.get(k) for k in []}))",
      "import os,json; print(json.dumps({k:os.environ.get(k) for k in names}))",
      "import os,json; print(json.dumps({k:os.environ.get(k) for k in ['HERDR_'+'ENV']}))",
      "import os,json; print(json.dumps({k:os.environ.get(k) for k in [*['HERDR_ENV']]}))",
      "import os,json; print(json.dumps({k:os.environ.get(k) for k in ['HERDR_ENV'] if k}))",
      "import os,json; print(json.dumps({k.upper():os.environ.get(k) for k in ['HERDR_ENV']}))",
      "import os,json; print(json.dumps({k:os.environ.get(other) for k in ['HERDR_ENV']}))",
      "import os,json; print(json.dumps({'NOT_APPROVED':os.getenv('HERDR_ENV')}))",
      "import os,json; print(json.dumps({'HERDR_ENV':os.getenv('NOT_APPROVED')}))",
      "import os,json; print(json.dumps([os.getenv('HERDR_ENV'), os.getenv('NOT_APPROVED')]))",
      "import os,json; print(json.dumps({os:os.environ.get(os) for os in ['HERDR_ENV']}))",
      "import os,json; print(json.dumps({json:os.getenv(json) for json in ['HERDR_ENV']}))",
      "import os,json; print(json.dumps([os.getenv(print) for print in ['HERDR_ENV']]))",
      "import os,json as j; print(j.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')}))",
      "import os as env,json; print(json.dumps({'HERDR_ENV':env.getenv('HERDR_ENV')}))",
      "import os,json; json=fake; print(json.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')}))",
      "import os,json; os=fake; print(json.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')}))",
      "import os,json; print=fake; print(json.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')}))",
      "import os; print(json.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')}))",
      "import os,json; print(json.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')}, default=eval))",
      "import os,json; print(json.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')})); exec('pass')",
      "import os,json; print(json.dumps({'HERDR_ENV':eval('os.getenv(\"HERDR_ENV\")')}))",
      "import os,json; print(json.dumps({'HERDR_ENV':open('.env').read()}))",
      "import os,json,subprocess; print(json.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')})); subprocess.run('env')",
      "import os,json; print(json.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')})) trailing",
      "import os,json; print(json.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')})) # trailing",
      "import os,json; print(json.dumps({'HERDR_ENV':os.getenv('HERDR_ENV')})",
    ])("denies JSON outside the approved projection grammar: %s", (source) => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_ENV"] });
      expect(guard.isDangerousBashCommand(inline(source))).toBe(true);
    });

    it("bounds literal projections to sixteen entries", () => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_ENV"] });
      for (const count of [16, 17]) {
        for (const projection of [
          `{k:os.getenv(k) for k in [${Array(count).fill("'HERDR_ENV'").join(",")}]}`,
          `[os.getenv(k) for k in [${Array(count).fill("'HERDR_ENV'").join(",")}]]`,
          `{${Array(count).fill("'HERDR_ENV':os.getenv('HERDR_ENV')").join(",")}}`,
          `[${Array(count).fill("os.getenv('HERDR_ENV')").join(",")}]`,
        ]) {
          expect(
            guard.isDangerousBashCommand(
              inline(`import os,json; print(json.dumps(${projection}))`),
            ),
          ).toBe(count > 16);
        }
      }
    });

    it.each([
      `${inline(jsonProgram)} | sh`,
      `${inline(jsonProgram)} | xargs`,
      `${inline(jsonProgram)} | mystery-runner`,
      `${inline(jsonProgram)} > /tmp/env-output`,
      `${inline(jsonProgram)} < /dev/null`,
      `PYTHONPATH=/tmp/probe ${inline(jsonProgram)}`,
      `env PYTHONPATH=/tmp/probe ${inline(jsonProgram)}`,
      `${inline("open('/tmp/probe/sitecustomize.py','w').write('import os; print(os.environ)')")}; ${inline(jsonProgram)}`,
      `${inline("open('/tmp/probe/json.py','w').write('import os; print(os.environ)')")}; ${inline(jsonProgram)}`,
    ])("keeps JSON executor, redirect, and startup mutation boundaries: %s", (command) => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: jsonNames });
      expect(guard.isDangerousBashCommand(command)).toBe(true);
    });

    it("allows the reported two-name program only when both names are configured", () => {
      for (const prefix of ["", "rtk proxy "]) {
        const command = inline(program, prefix);
        const heredoc = `${prefix}python3 - <<'PY'\n${program}\nPY`;
        const fullyApproved = createCredentialGuard({ allowedEnvironmentVariables: approvedNames });
        expect(fullyApproved.isDangerousBashCommand(command)).toBe(false);
        expect(fullyApproved.isDangerousBashCommand(heredoc)).toBe(false);
        expect(() =>
          fullyApproved.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
        ).not.toThrow();
        for (const allowedEnvironmentVariables of [[], ["CODEX_SESSION_ID"], ["HERDR_ENV"]]) {
          expect(
            createCredentialGuard({ allowedEnvironmentVariables }).isDangerousBashCommand(command),
          ).toBe(true);
        }
      }
      expect(isDangerousBashCommand(inline(program))).toBe(true);
    });

    it.each([
      "import os; print(os.getenv('HERDR_ENV'))",
      "import os; print(os.environ.get('HERDR_ENV','<absent>'))",
      "import os; print(os.environ['HERDR_ENV'])",
      "import os\nprint('value='+os.getenv('HERDR_ENV','<absent>'), 'label')",
      "import os; print('a'+'b', os.getenv('HERDR_ENV'))",
    ])("allows exact approved reads in the bounded print grammar: %s", (source) => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_ENV"] });
      expect(guard.isDangerousBashCommand(inline(source))).toBe(false);
    });

    it.each([
      "import os; print(os.environ)",
      "import os; print(os.environ.items())",
      "import os; print(os.environ.keys())",
      "import os; print(os.environ.values())",
      "import os; print(os.environ.get('NOT_APPROVED'))",
      "import os; print(os.environ.get('HERDR_ENV'), os.getenv('NOT_APPROVED'))",
      "import os; print(os.getenv(name))",
      "import os; print(os.getenv('HERDR_'+'ENV'))",
      "import os; print(os.getenv(*('HERDR_ENV',)))",
      "import os; print(os.getenv(key='HERDR_ENV'))",
      "import os as env; print(env.getenv('HERDR_ENV'))",
      "from os import getenv; print(getenv('HERDR_ENV'))",
      "import os; getenv = os.getenv; print(getenv('HERDR_ENV'))",
      "import os; os = fake; print(os.getenv('HERDR_ENV'))",
      "import os; print = fake; print(os.getenv('HERDR_ENV'))",
      "import os; print(getattr(os, 'getenv')('HERDR_ENV'))",
      "import os; print(os.getenv('HERDR_ENV')); exec('pass')",
      "import os; print(f'{os.getenv(\"HERDR_ENV\")}')",
      "import os; print(os.getenv('HERDR\\x5fENV'))",
      "import os; print(os.getenv('HERDR_ENV', os.getenv('NOT_APPROVED'))) ",
      "import os; print(os.getenv('HERDR_ENV', default='x'))",
      "import os; print(os.getenv('HERDR_ENV')); print(open('.env').read())",
      "import os; x = os.getenv('HERDR_ENV'); print(x)",
      "import os; print(os.getenv('HERDR_ENV')); import sys",
      "import os; print(os.getenv('HERDR_ENV', file=open('.env')))",
      "import os; print(os.getenv('HERDR_ENV')) # trailing code",
      "import os; print(os.getenv('HERDR_ENV'))\\\n; print('x')",
    ])("denies Python outside the approved print grammar: %s", (source) => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_ENV"] });
      expect(guard.isDangerousBashCommand(inline(source))).toBe(true);
    });

    it.each([
      `${inline(program)} | sh`,
      `${inline(program)} | xargs`,
      `${inline(program)} | mystery-runner`,
      `${inline(program)} |& sh`,
      `${inline(program)} > /tmp/env-output`,
      `${inline(program)} < /dev/null`,
      `HERDR_ENV=changed ${inline(program)}`,
      `${inline(program)}; cat .env`,
    ])("keeps pipeline, redirect, mutation, and following-command policy: %s", (command) => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: approvedNames });
      expect(guard.isDangerousBashCommand(command)).toBe(true);
    });

    it("allows the proved display program through head", () => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: approvedNames });
      expect(guard.isDangerousBashCommand(`${inline(program)} | head -c 100`)).toBe(false);
    });

    it.each([
      {
        label: ".pth startup file",
        command: (writer: string, reader: string) => `${inline(writer)}; ${inline(reader)}`,
        writerPath: "/tmp/probe-venv/lib/python3.11/site-packages/probe.pth",
      },
      {
        label: "sitecustomize.py through rtk",
        command: (writer: string, reader: string) =>
          `rtk proxy ${inline(writer)}; /tmp/probe-venv/bin/${inline(reader)}`,
        writerPath: "/tmp/probe-venv/lib/python3.11/site-packages/sitecustomize.py",
      },
      {
        label: "usercustomize.py through a quoted heredoc",
        command: (writer: string, reader: string) =>
          `python3 - <<'PY'\n${writer}\nPY\n${inline(reader)}`,
        writerPath: "/tmp/probe-venv/lib/python3.11/site-packages/usercustomize.py",
      },
    ])("denies a $label writer before an approved reader", ({ command, writerPath }) => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_ENV"] });
      const writer = `open('${writerPath}', 'w').write('import os; print(os.environ)')`;
      const reader = "import os; print(os.getenv('HERDR_ENV'))";
      expect(guard.isDangerousBashCommand(command(writer, reader))).toBe(true);
    });

    it("checks startup mutation prefixes even when shell quote splitting hides os.getenv", () => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_ENV"] });
      const splitReader = `python3 -c 'import o''s; print(o''s.getenv("HERDR_ENV"))'`;
      expect(guard.isDangerousBashCommand(splitReader)).toBe(false);
      for (const command of [
        `PYTHONPATH=/tmp/probe ${splitReader}`,
        `env PYTHONPATH=/tmp/probe ${splitReader}`,
        `PYTHONPATH=/tmp/probe pyth'on3' -c 'import os; print(os.getenv("HERDR_ENV"))'`,
      ]) {
        expect(guard.isDangerousBashCommand(command)).toBe(true);
      }
    });

    it("keeps standalone literal writers and inert display siblings usable", () => {
      const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_ENV"] });
      const writer = "open('/tmp/literal-output.txt', 'w').write('static text')";
      const reader = inline("import os; print(os.getenv('HERDR_ENV'))");
      expect(guard.isDangerousBashCommand(inline(writer))).toBe(false);
      for (const sibling of [
        "echo static text",
        inline("print('static text')"),
        `node -e 'console.log("static text")'`,
      ]) {
        expect(guard.isDangerousBashCommand(`${sibling}; ${reader}`)).toBe(false);
      }
    });

    it("keeps configured dangerous patterns active", () => {
      const guard = createCredentialGuard({
        allowedEnvironmentVariables: approvedNames,
        additionalDangerousBashPatterns: ["CODEX_SESSION_ID"],
      });
      expect(guard.isDangerousBashCommand(inline(program))).toBe(true);
    });
  });

  it.each([
    "printenv HERDR_ENV",
    "printenv -- HERDR_ENV",
    "printenv TEST_FLAG",
    "rtk proxy printenv WORKSPACE_LABEL",
    "printenv TEST_FLAG WORKSPACE_LABEL",
    "rtk printenv HERDR_ENV",
    "rtk proxy printenv HERDR_ENV",
    "/usr/bin/printenv 'HERDR_ENV'",
    "command printenv HERDR_ENV",
    "rtk printenv HERDR_ENV && git diff --name-only",
    "printenv HERDR_ENV; printenv HERDR_ENV",
    "printenv TEST_FLAG && npm test | tail -20",
    "printenv TEST_FLAG; ls | wc -l",
    "printenv TEST_FLAG || ls | wc -l",
    "ls | wc -l; printenv TEST_FLAG",
    "echo 'printenv' | head; ls | wc -l",
    "printenv TEST_FLAG |& head",
    "rg -n 'printenv|HERDR_ENV' src",
    "rtk proxy rg -n 'printenv|HERDR_ENV' src | head",
    "git grep -n printenv -- src",
    "grep 'printenv' README.md",
    "echo 'printenv TOKEN; env'",
    'printf "%s\\n" "printenv"',
    "rg -n 'process.env' src",
    "rg -n 'pr{i,}ntenv|e{n,}v' src",
    "echo 'pr{i..i}ntenv'",
    "echo { '{a,b}'",
    'cat > file.ts << EOF\nimport { describe, it, expect } from "vitest";\nEOF',
    'tee file.json <<EOF\n{"a":1,"b":2}\nEOF',
    "rtk proxy cat > file.ts <<'EOF'\nconst code = `printenv ${NAME}`;\nEOF",
    'cat > file.py <<"EOF"\nconfig = {"a": 1, "b": 2}\nEOF\n',
    "cat > file.ts <<-EOF\n\timport {a,b} from 'module';\n\tEOF",
    "printf '%s\\n' '{a,b}' > file.txt",
    "echo 'printenv TOKEN' > file.txt",
    'bun run gh-tool commands 2>&1 | rtk proxy grep -o -E "(request-review|reviewers)[^\\"]{0,80}" | head -5',
    'bun run gh-tool commands | grep -o -E "x{0,80}" | head -5',
    'bun run gh-tool commands | grep -o -E "x{80}" | head -5',
    "rg -o 'x{0,80}' src | head -5",
    "F=/tmp/x.log; grep -o -E 'a[^,]{0,25}' $F | sort | uniq -c",
    "S=/tmp; ls -la $S/post.* | awk '{print $5}'",
    "F=/tmp/x; grep -o -E 'a{0,25}' $F",
    'bun run gh-tool x 2>&1 | grep -E "x{0,80}"',
    "sed -E 's/a{0,3}/b/' file.txt",
    "F=/tmp/x.log; grep -c -E $'a\\'{0,5}' $F",
    'bun run db-tool query --env dev --sql "select 1"',
    'bun run db-tool query --env=dev --sql "select 1"',
    'F=x; bun run db-tool query --env dev --sql "select 1" > $F',
    'bun run db-tool query --sql "select 1"',
    "cd /tmp && printf '%s\\n' '- note: allows quoted {0,80} and --env' >> notes.md && tail -1 notes.md",
  ])("allows static metadata reads and literal search text: %s", (command) => {
    const guard = createCredentialGuard({
      allowedEnvironmentVariables: ["HERDR_ENV", "TEST_FLAG", "WORKSPACE_LABEL"],
    });
    expect(guard.isDangerousBashCommand(command)).toBe(false);
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  });

  it.each([
    "env cat .env",
    "env foo=1 cat .env",
    "env printenv",
    "env -i cat ~/.aws/credentials",
    "cat aws-secrets.txt",
    "cat old-credentials.json",
    "cat serviceCredentials.txt",
    "cat getSecretValue.js",
    "cat mySecretConfig.json",
  ])("blocks env-wrapped sensitive commands: %s", (command) => {
    expect(isDangerousBashCommand(command)).toBe(true);
  });

  it.each(["echo please cat .env carefully", "echo do not cat the secrets file"])(
    "allows quoted sensitive words in literal text: %s",
    (command) => {
      expect(isDangerousBashCommand(command)).toBe(false);
    },
  );

  it.each([
    'herdr agent prompt worker-a "$(cat .env)"',
    'herdr agent prompt worker-a "`cat ~/.aws/credentials`"',
    'echo "$(cat id_rsa.pem)"',
    'x="$(cat ~/.aws/credentials)"',
  ])("blocks sensitive reads inside quoted substitutions: %s", (command) => {
    expect(isDangerousBashCommand(command)).toBe(true);
  });

  it.each([
    "rtk printenv",
    "rtk proxy printenv TOKEN",
    "printenv HERDR_ENV TOKEN",
    "printenv HERDR_ENV --null",
    "printenv TEST_FLAG UNKNOWN_FLAG",
    "printenv TEST_FLAG | sh",
    "printenv TEST_FLAG | unknown-runner",
    "printenv TEST_FLAG | unknown-runner; ls | wc -l",
    "echo 'printenv' | (head; sh)",
    "echo 'printenv' |& sh",
    "printenv TEST_FLAG |& sh",
    "echo 'pr{i..i}ntenv TOKEN' |& sh",
    "(printenv TEST_FLAG) | sh",
    "printenv HERDR_ENV_TOKEN",
    "printenv herdr_env",
    "printenv $NAME",
    "rtk printenv HERDR_ENV && printenv TOKEN",
    "printenv HERDR_ENV\nprintenv",
    "echo hi | /usr/bin/printenv TOKEN",
    "'printenv' TOKEN",
    "pr'int'env TOKEN",
    "print\\env TOKEN",
    "rtk env",
    "/usr/bin/env",
    "echo hi\nenv",
    "echo $(printenv TOKEN)",
    'echo "$(printenv TOKEN)"',
    'echo "`printenv TOKEN`"',
    'sh -c "printenv TOKEN"',
    'bash -c "env"',
    "eval 'printenv HERDR_ENV'",
    "rg --pre printenv pattern src",
    "rg --pre=printenv pattern src",
    "git grep --open-files-in-pager=printenv pattern",
    "git grep -O printenv pattern",
    "git grep -Oprintenv pattern",
    "git grep -nOprintenv pattern",
    "git grep --open-files='printenv; echo' pattern",
    "git grep --open-files-in-page='printenv; echo' pattern",
    "rg --hostname-bin=printenv --hyperlink-format=default --color=always -H pattern README.md",
    "rg --hostname-bin printenv pattern src",
    "echo 'printenv' | sh",
    "printf '%s\\n' 'printenv' | bash",
    "echo 'printenv' | xargs",
    "echo 'printenv' | unknown-runner",
    "sort --compress-program=printenv input.txt",
    "pr{i,}ntenv TOKEN",
    "p{r,x}intenv TOKEN",
    "pr{i..i}ntenv TOKEN",
    "pr{'i',}ntenv TOKEN",
    "e{n,}v",
    "rtk proxy pr{i,}ntenv TOKEN",
    'true "$UNSET"; pr{i..i}ntenv TOKEN',
    'echo "$(pr{i..i}ntenv TOKEN)"',
    'echo "`pr{i..i}ntenv TOKEN`"',
    "sh -c 'pr{i,}ntenv TOKEN'",
    "sh -c \"bash -c 'pr{i,}ntenv TOKEN'\"",
    "eval 'e{n,}v'",
    "timeout 1 bash -c 'pr{i..i}ntenv TOKEN'",
    "sudo bash -lc 'pr{i,}ntenv TOKEN'",
    "xargs sh -c 'e{n,}v'",
    "echo 'pr{i,}ntenv' | sh",
    "echo 'pr{i,}ntenv' | sh > output.txt",
    "printenv HERDR_ENV > output.txt",
    "printenv 'HERDR_ENV",
    "cat > output.txt <<EOF\n$(pr{i..i}ntenv TOKEN)\nEOF",
    "cat > output.txt <<EOF\n`pr{i..i}ntenv TOKEN`\nEOF",
    "cat > output.txt <<EOF\nE\\\nOF\npr{i..i}ntenv TOKEN\nEOF",
    "bash <<'EOF'\npr{i..i}ntenv TOKEN\nEOF",
    "cat > output.sh <<'EOF'\npr{i..i}ntenv TOKEN\nEOF\nbash output.sh",
    "cat > output.sh <<EOF\nEOF\npr{i..i}ntenv TOKEN\ncat <<EOF\n{a,b}\nEOF",
    "cat > output.sh <<EOF; pr{i..i}ntenv TOKEN\n{a,b}\nEOF",
    "printf '%s' '{a,b}' > output.txt; pr{i..i}ntenv TOKEN",
    "printf '%s' 'printenv TOKEN' > output.sh; sh output.sh",
    "printf '%s' '{a,b}' | bash > output.txt",
    "cat > output.txt <<EOF\n{a,b}\nMISSING",
    "echo {a,b}",
    "echo 'x{a,b}' | sh",
    "bash -c 'cat .e{n,}v'",
    "F=x; bash -c 'cat .e{n,}v'",
    "env | head",
    "x=1; env",
    "echo 'env' | sh",
    "printf 'env' | sh",
    "printf '{a,b}' | bash",
    "bun run db-tool query --env dev; env",
    "bash -c 'cat .e{n,}v' 2>&1",
    "F=x; bash -c 'cat .e{n,}v' $F",
    "F=x; eval 'cat .e{n,}v' $F",
    "F=x; echo 'cat .e{n,}v' $F | xargs",
    "F=x; . './e{n,}v' $F",
    "F=x; $SHELL -c 'cat .e{n,}v'",
    "F=x; X=1 $SHELL -c 'cat .e{n,}v'",
    "F=x; $SHELL <<< 'cat .e{n,}v'",
    "F=x; sudo -u root \"$SHELL\" -lc 'cat .e{n,}v'",
    "X='cat .e{n,}v'; \\sh \\-c \"$X\"",
    "X='cat .e{n,}v'; s\\h \\-c \"$X\"",
    "X='cat .e{n,}v'; \\bash \\-c \"$X\"",
    "X='cat .e{n,}v'; ba\\sh \\-c \"$X\"",
    "X='cat .e{n,}v'; ba''sh \\-c \"$X\"",
    'X=\'cat .e{n,}v\'; b"a"sh \\-c "$X"',
    "X='cat .e{n,}v'; s\\h -c \"$X\"",
    "X='cat .e{n,}v'; \\bash -c \"$X\"",
    "X='cat .e{n,}v'; ba''sh -c \"$X\"",
    'X=\'cat .e{n,}v\'; b"a"sh -c "$X"',
    "F=x; e\\val 'cat .e{n,}v' $F",
    "F=x; e'v'al 'cat .e{n,}v' $F",
    "F=x; e\"va\"l 'cat .e{n,}v' $F",
    "F=x; echo 'cat .e{n,}v' $F | x\\args",
    "F=x; echo 'cat .e{n,}v' $F | xa''rgs",
    "F=x; so''urce './e{n,}v' $F",
    'F=x; echo "\\$(cat .e{n,}v)" $F',
    'F=x; echo "\\`cat .e{n,}v\\`" $F',
    "F=x; { $SHELL; } <<< 'cat .e{n,}v'",
    "trap 'cat .e{n,}v' EXIT; F=x",
    "bash -c 'cat .e{0,}nv'",
    "bash -c 'cat .e{,}nv'",
    "bash -c 'cat .e{,5}nv'",
    "F=x; bash -c 'cat .e{0,}nv' $F",
    "F=x; bash -c 'cat .e{,}nv' $F",
    "echo 'cat .e{0,}nv' | sh",
    "grep 'printenv TOKEN' | sh",
    "git grep 'printenv TOKEN' | sh",
    "rg 'printenv TOKEN' | sh",
    "grep -o 'e{n,}v' notes.md | sh",
    "git grep -h -o 'e{n,}v' | bash",
    "F=x; find . -exec sh -c 'cat .e{n,}v' \\;",
    "F=x; awk 'BEGIN{system(\"cat .e{n,}v\")}'",
    "F=x; ssh host 'cat .e{n,}v' $F",
    "F=x; bash -c 'cat .e{0,n}v' $F",
    'F=x; echo "$(cat .e{n,}v)" $F',
    "echo $'\\'' {a,b} $'\\''",
    "echo 'x {a,b} > f",
    "echo x | rg -r 'env' x | sh",
    "echo x | rg --replace='e{n,}v' x | sh",
    "echo x | grep -H --label='env;' x | sh",
  ])("blocks secret reads and unverified shell syntax: %s", (command) => {
    const guard = createCredentialGuard({
      allowedEnvironmentVariables: ["HERDR_ENV", "TEST_FLAG", "WORKSPACE_LABEL"],
    });
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow(
      "might expose secrets",
    );
  });

  it.each([
    "S=/tmp; ls -la $S/post.* | awk '{print $5,$9}'",
    "ls -la /tmp/post.* | awk '{print $5,$9}'",
    "cd /tmp && printf '%s\\n' '- note: blocks quoted {m,n} and --env' >> notes.md && tail -1 notes.md",
    "printf '%s\\n' 'Releases #1 (... `--env` flag ...).' > /tmp/rel.md; bun run gh-tool pr create --body-file /tmp/rel.md",
    "jq '{dependencies, peerDependencies}' package.json",
    "env -u CI bun check.ts module docs",
    "bun run fooOprintenv.ts",
    'echo "please cat .env carefully"',
    'echo "do not cat the secrets file"',
    "bun run foo-printenv.ts",
  ])("allows non-executing shell syntax: %s", (command) => {
    const guard = createCredentialGuard({
      allowedEnvironmentVariables: ["HERDR_ENV", "TEST_FLAG", "WORKSPACE_LABEL"],
    });
    expect(guard.isDangerousBashCommand(command)).toBe(false);
  });

  it.each([
    "for t in argo-tool env-tool db-tool; do bun run $t --help > /tmp/h-$t.txt 2>&1; done",
    "herdr agent prompt worker-a-guard \"Please check `for t in argo-tool env-tool db-tool; do bun run $t --help > /tmp/h-$t.txt 2>&1; done` and `jq '{dependencies, peerDependencies}' package.json`.\"",
  ])("denies dynamic loop operands and executable prompt substitutions: %s", (command) => {
    expect(isDangerousBashCommand(command)).toBe(true);
  });

  it.each([
    "for n in safe; do n=.env; cat $n; done",
    "for n in safe; do read n; cat $n; done",
    "for IFS in /; do herdr agent get $IFS; done",
    "for n in safe; do $n; done",
    'for n in safe; do sh -c "echo $n"; done',
    "for n in safe; do cat $n; done; cat .env",
    "for n in safe; do herdr agent get $n; done; printenv",
  ])("denies unsafe literal-list loop semantics: %s", (command) => {
    expect(isDangerousBashCommand(command)).toBe(true);
  });

  it("keeps configured dangerous patterns active for otherwise safe commands", () => {
    const guard = createCredentialGuard({
      allowedEnvironmentVariables: ["HERDR_ENV"],
      additionalDangerousBashPatterns: ["HERDR_ENV"],
    });
    expect(guard.isDangerousBashCommand("rtk printenv HERDR_ENV")).toBe(true);
  });

  it("does not give any environment name a built-in exception", () => {
    expect(isDangerousBashCommand("printenv HERDR_ENV")).toBe(true);
    expect(isDangerousBashCommand("printenv TEST_FLAG")).toBe(true);
    expect(isDangerousBashCommand("rg -n printenv src")).toBe(false);
  });

  it.each(["", "*", "TEST_*", "--help", "TEST-FLAG", "TEST FLAG"])(
    "rejects invalid allowed environment names: %s",
    (name) => {
      expect(() => createCredentialGuard({ allowedEnvironmentVariables: [name] })).toThrow(
        "Invalid allowed environment variable name",
      );
    },
  );

  it.each(["TOKEN", null, 1, {}, [null], [1], [true]])(
    "rejects malformed allowed environment lists: %j",
    (names) => {
      expect(() =>
        createCredentialGuard({
          allowedEnvironmentVariables: names as unknown as string[],
        }),
      ).toThrow("allowedEnvironmentVariables must be an array of strings");
    },
  );

  it("blocks printenv", () => {
    expect(isDangerousBashCommand("printenv")).toBe(true);
  });

  it("blocks env at start", () => {
    expect(isDangerousBashCommand("env")).toBe(true);
  });

  it.each([
    "cat mysecretfile.txt",
    "cat backupsecrets2023.txt",
    "cat db_credentials_backup",
    "cat my_credential_store",
  ])("blocks %s, a secret or credential name without a delimiter", (command) => {
    expect(isDangerousBashCommand(command)).toBe(true);
  });

  it.each(["env --", "env FOO=bar --", "env -i --", "/usr/bin/env --"])(
    "blocks %s, which lists the environment like bare env",
    (command) => {
      expect(isDangerousBashCommand(command)).toBe(true);
    },
  );

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
    ).toThrow("Direct gh usage blocked");
  });

  it("blocks raw gh via an AI coding agent's capitalized 'Bash'", () => {
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: "gh issue list" } }),
    ).toThrow("Direct gh usage blocked");
  });

  it("blocks raw gh via OpenCode MCP 'mcp_bash'", () => {
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "mcp_bash" }, { args: { command: "gh issue list" } }),
    ).toThrow("Direct gh usage blocked");
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
describe("static shell safety proofs", () => {
  const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_PANE_ID"] });
  it.each([
    {
      case: "approved value cannot choose printf options",
      command: 'F=README.md; printf "$HERDR_PANE_ID" F .env; cat "$F"',
      blocked: true,
    },
    {
      case: "approved value cannot choose printf format",
      command: 'F=README.md; printf -- "$HERDR_PANE_ID" F; cat "$F"',
      blocked: true,
    },
    {
      case: "approved value as printf data",
      command: 'printf -- "%s" "$HERDR_PANE_ID"',
      blocked: false,
    },
    {
      case: "approved value cannot configure executable",
      command: "LD_PRELOAD=$HERDR_PANE_ID rtk echo ok",
      blocked: true,
    },

    {
      case: "redirect before unsupported trailing syntax",
      command: "echo x > .env\nprintf 'unterminated",
      blocked: true,
    },

    { case: "local sort sensitive path", command: 'F=.env; sort "$F"', blocked: true },
    { case: "local path suffix sensitive", command: 'F=/tmp; cut -c1-20 "$F/.env"', blocked: true },
    {
      case: "wrapper body file sensitive",
      command: 'F=.env; bun run gh-tool pr create --body-file "$F"',
      blocked: true,
    },
    { case: "nested canonical path", command: 'echo "$(cat ~/.kube/config)"', blocked: true },

    {
      case: "quote",
      command: 'echo "it\'s $TOKEN"',
      blocked: true,
    },
    {
      case: "quote braced",
      command: 'printf "%s" "it\'s ${TOKEN}"',
      blocked: true,
    },
    {
      case: "quote pipeline",
      command: 'echo "it\'s $TOKEN" | head',
      blocked: true,
    },
    {
      case: "quote redirect",
      command: 'echo "it\'s $TOKEN" > /tmp/x',
      blocked: true,
    },
    {
      case: "literal redirect",
      command: 'echo "a > b"',
      blocked: false,
    },
    {
      case: "literal greater",
      command: "jq '.a > .b' report.json",
      blocked: false,
    },
    {
      case: "literal prompt",
      command: 'herdr agent prompt worker "use a > b"',
      blocked: false,
    },
    {
      case: "quoted redirect",
      command: 'echo ok > "/tmp/x"',
      blocked: false,
    },
    {
      case: "comment kube",
      command: "cat ~/.kube/config # read config",
      blocked: true,
    },
    {
      case: "comment p12",
      command: "cat cert.p12 # read certificate",
      blocked: true,
    },
    {
      case: "comment sentry",
      command: "cat .sentryclirc # read config",
      blocked: true,
    },
    {
      case: "substitution kube",
      command: "cat ~/.kube/config $(true)",
      blocked: true,
    },
    {
      case: "redirect input kube",
      command: "cat < ~/.kube/config",
      blocked: true,
    },
    {
      case: "redirect input env",
      command: 'cat < ".env"',
      blocked: true,
    },
    {
      case: "static jq kube",
      command: "jq '{a: .users}' ~/.kube/config",
      blocked: true,
    },
    {
      case: "wrapped env gh",
      command: "env -u CI rtk gh auth token",
      blocked: true,
    },
    {
      case: "wrapped command gh",
      command: "rtk command gh auth token",
      blocked: true,
    },
    {
      case: "comment wrapped gh",
      command: "rtk gh auth token # auth",
      blocked: true,
    },
    {
      case: "leading assignment gh",
      command: "CI=1 rtk gh auth token",
      blocked: true,
    },
    {
      case: "quoted cli literal",
      command: "echo 'gh auth token'",
      blocked: false,
    },
    {
      case: "quoted chain literal",
      command: "echo '; gh auth token'",
      blocked: false,
    },
    {
      case: "sed execution",
      command: "F=README.md; sed -n '1e printenv' \"$F\"",
      blocked: true,
    },
    {
      case: "awk program option",
      command: 'F=README.md; awk -f /tmp/program "$F"',
      blocked: true,
    },
    {
      case: "awk getline",
      command: "echo printenv | awk 'BEGIN { getline x < \"/tmp/program\"; print x }'",
      blocked: true,
    },
    {
      case: "printf assigns",
      command: 'F=README.md; printf -v F .env; cat "$F"',
      blocked: true,
    },
    {
      case: "printf name from local",
      command: 'F=TOKEN; printf -v F %s .env; cat "$F"',
      blocked: true,
    },
    {
      case: "jq slurpfile",
      command: "F=README.md; jq --rawfile x .env '{a: .x}' \"$F\"",
      blocked: true,
    },
    {
      case: "herdr jq slurpfile",
      command: "herdr agent prompt worker 'review'; jq --rawfile x .env '{a: .x}' report.json",
      blocked: true,
    },
    {
      case: "herdr awk file",
      command: "herdr agent prompt worker 'review' | awk -f /tmp/program",
      blocked: true,
    },
    {
      case: "herdr double quoted backtick",
      command: 'herdr agent prompt worker "use `printenv`"',
      blocked: true,
    },
    {
      case: "herdr single quoted backtick",
      command: "herdr agent prompt worker 'use `printenv`'",
      blocked: false,
    },
    {
      case: "heredoc unquoted env",
      command: "cat <<EOF\n$TOKEN\nEOF",
      blocked: true,
    },
    {
      case: "heredoc quoted env",
      command: "cat <<'EOF'\n$TOKEN\nEOF",
      blocked: false,
    },
    {
      case: "D1",
      command: 'echo "$TOKEN"; TOKEN=literal',
      blocked: true,
    },
    {
      case: "D2",
      command: "echo ok >`printenv`",
      blocked: true,
    },
    {
      case: "D3",
      command: "awk '{print $1}' file.txt",
      blocked: false,
    },
    {
      case: "D4 quote",
      command: "printf 'x;TOKEN=literal'; echo \"$TOKEN\"",
      blocked: true,
    },
    {
      case: "D4 command-local",
      command: 'TOKEN=literal true; echo "$TOKEN"',
      blocked: true,
    },
    {
      case: "D4 conditional",
      command: 'false && TOKEN=literal; echo "$TOKEN"',
      blocked: true,
    },
    {
      case: "D5 reassignment",
      command: 'F=README.md; true; F=.env; cat "$F"',
      blocked: true,
    },
    {
      case: "D5 source",
      command: 'F=README.md; source /tmp/set-f; cat "$F"',
      blocked: true,
    },
    {
      case: "D5 eval",
      command: 'F=README.md; eval "F=.env"; cat "$F"',
      blocked: true,
    },
    {
      case: "allow pane",
      command: 'echo "$HERDR_PANE_ID"',
      blocked: false,
    },
    {
      case: "allow file",
      command: 'F=README.md; cat "$F"',
      blocked: false,
    },
    {
      case: "jq decoy filter",
      command: "jq -n --arg x '{a: .b}' '$ENV'",
      blocked: true,
    },
    {
      case: "jq decoy filter shorthand",
      command: "jq -n --arg x '{a,b}' '$ENV'",
      blocked: true,
    },
    {
      case: "jq rawfile kube",
      command: "jq --rawfile x ~/.kube/config '{a: .x}' report.json",
      blocked: true,
    },
    {
      case: "herdr jq decoy",
      command: "herdr agent prompt worker 'review'; jq -n --arg x '{a: .b}' '$ENV'",
      blocked: true,
    },
    {
      case: "allowlist awk executable",
      command: 'echo "$HERDR_PANE_ID" | awk -f /dev/stdin',
      blocked: true,
    },
    {
      case: "allowlist printf assigns",
      command: 'printf -v F %s "$HERDR_PANE_ID"; cat "$F"',
      blocked: true,
    },
    {
      case: "literal prompt greater sensitive",
      command: 'herdr agent prompt worker "compare foo > .env"',
      blocked: false,
    },
    {
      case: "literal sql comparator",
      command: "bun run db-tool query --env dev --sql \"select x where x <> ''\"",
      blocked: false,
    },
    {
      case: "allowlist via file executor",
      command: 'echo "$HERDR_PANE_ID" > /tmp/script; sh /tmp/script',
      blocked: true,
    },
    {
      case: "local via printf mutation echo",
      command: 'F=README.md; printf -v F .env; echo "$F"; cat "$F"',
      blocked: true,
    },
    {
      case: "quoted sensitive redirect",
      command: "printf x > .en''v",
      blocked: true,
    },
    {
      case: "literal dollar redirect",
      command: "echo ok > '/tmp/$TOKEN'",
      blocked: false,
    },
    {
      case: "awk environment source",
      command: 'echo "$HERDR_PANE_ID" | awk \'BEGIN {print ENVIRON["TOKEN"]}\' ',
      blocked: true,
    },
    {
      case: "printf attached variable option",
      command: 'F=README.md; printf -vF .env; cat "$F"',
      blocked: true,
    },
    {
      case: "local reassigned by printf count",
      command: "F=README.md; printf '%n' F; cat \"$F\"",
      blocked: true,
    },
    {
      case: "known env option with approved metadata",
      command: "env -u CI rtk printenv HERDR_PANE_ID",
      blocked: false,
    },
    {
      case: "unknown env option cannot prove safety",
      command: "env --unknown rtk printenv HERDR_PANE_ID",
      blocked: true,
    },
    {
      case: "redirect scope independent of approved echo",
      command: 'herdr agent list 2>/dev/null | head; echo "$HERDR_PANE_ID"',
      blocked: false,
    },
    {
      case: "selected jq JSON env fields",
      command: "jq -r '.env.DISABLE_UPDATES' settings.json",
      blocked: false,
    },
    {
      case: "loading jq option after filter",
      command: "herdr agent prompt worker 'review'; jq '{a: .b}' --from-file /tmp/program",
      blocked: true,
    },
    {
      case: "quoted operator with approved echo",
      command: 'echo "it\'s $HERDR_PANE_ID > text"',
      blocked: false,
    },
  ])("$case", ({ command, blocked }) => {
    const invoke = () => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
    if (blocked) expect(invoke).toThrow();
    else expect(invoke).not.toThrow();
  });
});

describe("AWK option parsing", () => {
  const guard = createCredentialGuard();

  it.each([
    'docker ps --format \'{{.Label "com.docker.compose.project"}}|{{.Image}}|{{.RunningFor}}\' | awk -F\'|\' \'{p=$1; if(p=="") p="(none:"$2")"; c[p]++; t[p]=$3} END {for (k in c) print c[k], k, t[k]}\' | sort -rn',
    "awk -F'|' '{print $1, $2}'",
    "awk -F '|' '{print $1, $2}'",
    "awk -- '{print $1, $2}'",
    "awk -F'|' '{print $1}' data.txt",
  ])("allows inline AWK programs with safe field separator options: %s", (command) => {
    expect(guard.isDangerousBashCommand(command)).toBe(false);
  });

  it.each([
    "awk -f /tmp/program '{print $1, $2}'",
    "awk --file=/tmp/program '{print $1, $2}'",
    "awk -Z '{print $1, $2}'",
    "awk -F'|' 'BEGIN {print ENVIRON[\"TOKEN\"]}'",
    "awk --source='BEGIN {print ENVIRON[\"TOKEN\"]}' '{print $1}'",
    "awk -F'|' 'BEGIN {system(\"printenv\")}'",
    "awk 'BEGIN {ARGV[1]=\".env\"; ARGC=2} {print}'",
    "awk '{getline x < \".env\"; print x}'",
    "awk -F'|' '{getline x < \".env\"; print x}'",
    "awk '{system(\"cat .env\")}'",
    "awk -F'|' '{system(\"cat .env\")}'",
    "awk -F'|' 'BEGIN {ARGV[1]=\".env\"; ARGC=2} {print}'",
    "awk -F'|' '{print $1}' .env",
  ])("keeps AWK execution and sensitive file checks fail closed: %s", (command) => {
    expect(guard.isDangerousBashCommand(command)).toBe(true);
  });
});

describe("materialized options and inert variable uses", () => {
  const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HERDR_PANE_ID"] });
  it.each([
    {
      case: "unquoted navigation cannot inject git options",
      command: "git -C $WORKTREE_ROOT status --short",
      blocked: true,
    },
    {
      case: "configured unquoted navigation cannot inject git options",
      command: "git -C $HERDR_PANE_ID status --short",
      blocked: true,
    },
    {
      case: "quoted navigation and approved unquoted display",
      command: 'cd "$WORKTREE_ROOT"; echo PANE=$HERDR_PANE_ID',
      blocked: false,
    },

    {
      case: "local printf option expansion",
      command: 'O=-v; F=README.md; printf "$O" F .env; echo "$F"; cat "$F"',
      blocked: true,
    },
    {
      case: "local printf attached option expansion",
      command: 'O=-vF; F=README.md; printf "$O" .env; echo "$F"; cat "$F"',
      blocked: true,
    },
    {
      case: "local awk option expansion",
      command: 'O=-f; F=/tmp/program; echo "$F"; awk "$O" "$F"',
      blocked: true,
    },
    {
      case: "local printf concealed target",
      command: 'O=-v; F=README.md; printf "$O" F .en%s v; echo "$F"; cat "$F"',
      blocked: true,
    },
    {
      case: "ambient home directory",
      command: 'cd "$HOME"',
      blocked: false,
    },
    {
      case: "ambient pwd git metadata",
      command: 'git -C "$PWD" status --short',
      blocked: false,
    },
    {
      case: "inert comment expansion",
      command: "git status --short # $TOKEN",
      blocked: false,
    },
    {
      case: "active quoted hash expansion",
      command: 'echo "# $TOKEN"',
      blocked: true,
    },
    {
      case: "active after comment newline",
      command: 'git status --short # note\necho "$TOKEN"',
      blocked: true,
    },
    {
      case: "printf approved data",
      command: 'printf -- "%s" "$HERDR_PANE_ID"',
      blocked: false,
    },
    {
      case: "printf approved option",
      command: 'F=README.md; printf "$HERDR_PANE_ID" F .env; cat "$F"',
      blocked: true,
    },
    {
      case: "printf approved format",
      command: 'F=README.md; printf -- "$HERDR_PANE_ID" F; cat "$F"',
      blocked: true,
    },
    {
      case: "approved wrapper config",
      command: "LD_PRELOAD=$HERDR_PANE_ID rtk echo ok",
      blocked: true,
    },
    {
      case: "quoted static printf data",
      command: "printf '%s' '-version %n'",
      blocked: false,
    },
    {
      case: "literal printf with approved data",
      command: 'printf -- "%s" "-version" "$HERDR_PANE_ID"',
      blocked: false,
    },
    {
      case: "sensitive jq static filter options",
      command: "jq -rn '{a: .b}' ~/.kube/config",
      blocked: true,
    },
    {
      case: "jq real ENV filter",
      command: "jq -n '$ENV'",
      blocked: true,
    },
    {
      case: "nested read canonical",
      command: 'echo "$(cat ~/.kube/config)"',
      blocked: true,
    },
    {
      case: "redirect concatenation",
      command: "echo ok > '.en'v",
      blocked: true,
    },
    {
      case: "redirect escaped literal dollar",
      command: 'echo ok > "/tmp/\\$TOKEN"',
      blocked: false,
    },
    {
      case: "source path with comment",
      command: "cat .agent/hooks/credential-guard.ts # source",
      blocked: false,
    },
    {
      case: "ordinary named navigation variable",
      command: 'cd "$WORKTREE_ROOT"',
      blocked: false,
    },
    {
      case: "ordinary named git metadata variable",
      command: 'git -C "$WORKTREE_ROOT" status --short',
      blocked: false,
    },
    {
      case: "navigation variable not display permission",
      command: 'cd "$WORKTREE_ROOT"; echo "$WORKTREE_ROOT"',
      blocked: true,
    },
    {
      case: "navigation variable not executor permission",
      command: '"$WORKTREE_ROOT" --help',
      blocked: true,
    },
    {
      case: "navigation variable not option permission",
      command: 'git "$WORKTREE_ROOT" status --short',
      blocked: true,
    },
    {
      case: "navigation variable not code permission",
      command: 'sh -c "$WORKTREE_ROOT"',
      blocked: true,
    },
    {
      case: "navigation variable not file permission",
      command: 'cat "$WORKTREE_ROOT"',
      blocked: true,
    },
    {
      case: "navigation variable not redirect permission",
      command: 'echo ok > "$WORKTREE_ROOT"',
      blocked: true,
    },
    {
      case: "navigation variable not wrapper configuration",
      command: "LD_PRELOAD=$WORKTREE_ROOT git status --short",
      blocked: true,
    },
    {
      case: "quoted hash adjacent to word is active",
      command: 'echo "text"# $TOKEN',
      blocked: true,
    },
    {
      case: "hash inside word is active",
      command: "echo text# $TOKEN",
      blocked: true,
    },
    {
      case: "comment after separator is inert",
      command: "git status;# $TOKEN",
      blocked: false,
    },
    {
      case: "navigation and inert comment",
      command: 'cd "$WORKTREE_ROOT" # $TOKEN',
      blocked: false,
    },
    {
      case: "local printf format mutation",
      command: 'O=%n; F=README.md; printf "$O" F; cat "$F"',
      blocked: true,
    },
    {
      case: "local printf width format mutation",
      command: 'O=%5n; F=README.md; printf "$O" F; cat "$F"',
      blocked: true,
    },
    {
      case: "printf numeric width mutation",
      command: 'F=README.md; printf "%5n" F; cat "$F"',
      blocked: true,
    },
    {
      case: "printf flags width mutation",
      command: 'F=README.md; printf "%+5n" F; cat "$F"',
      blocked: true,
    },
    {
      case: "printf star width mutation",
      command: 'F=README.md; printf "%*n" 5 F; cat "$F"',
      blocked: true,
    },
    {
      case: "printf data percent n stays inert",
      command: 'printf -- "%s" "%n -v" "$HERDR_PANE_ID"',
      blocked: false,
    },
    {
      case: "printf escaped percent n stays inert",
      command: 'printf -- "%%n %s" "$HERDR_PANE_ID"',
      blocked: false,
    },
    {
      case: "local printf static data stays inert",
      command: 'F=README.md; printf "%s" "-v %n" "$F"; cat "$F"',
      blocked: false,
    },
    {
      case: "local value does not alter approved format proof",
      command: 'O=-v; printf "$O" F "%s" "$HERDR_PANE_ID"',
      blocked: true,
    },
    {
      case: "configured variable navigation is also inert",
      command: 'cd "$HERDR_PANE_ID"',
      blocked: false,
    },
  ])("$case", ({ command, blocked }) => {
    const invoke = () => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
    if (blocked) expect(invoke).toThrow();
    else expect(invoke).not.toThrow();
  });
});

describe("RTK file-reader normalization", () => {
  it.each([
    { command: "rtk read .env", blocked: true },
    { command: "rtk read ~/.kube/config", blocked: true },
    { command: "rtk read cert.p12", blocked: true },
    { command: "rtk read README.md", blocked: false },
    { command: "read F", blocked: false },
    { command: 'F=README.md; read F; cat "$F"', blocked: true },
  ])("checks the actual reader: $command", ({ command, blocked }) => {
    const guard = createCredentialGuard();
    const invoke = () => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
    if (blocked) expect(invoke).toThrow();
    else expect(invoke).not.toThrow();
  });
});

describe("heredoc expansion boundary", () => {
  it.each([
    { command: "cat <<EOF # note\n# $TOKEN\nEOF", blocked: true },
    { command: "pwd\ncat <<EOF\n# $TOKEN\nEOF", blocked: true },
    { command: "herdr agent prompt w 'cat <<EOF'", blocked: false },
    { command: 'git status # cat <<EOF\necho "$TOKEN"', blocked: true },
    { command: "cat <<'EOF' # note\n# $TOKEN\nEOF", blocked: false },
    { command: "cat <<'A'\n# $TOKEN\nA\ncat <<B\n# $TOKEN\nB", blocked: true },

    { command: "cat <<EOF\n# $TOKEN\nEOF", blocked: true },
    { command: "cat <<EOF\nit's $TOKEN\nEOF", blocked: true },
    { command: 'cat <<EOF\n"$TOKEN"\nEOF', blocked: true },
    { command: "cat <<EOF\n# `unknown-command`\nEOF", blocked: true },
    { command: "cat <<'EOF'\n# $TOKEN\nEOF", blocked: false },
    { command: "cat <<'EOF'\nit's $TOKEN\nEOF", blocked: false },
    { command: "cat <<'EOF'\n# $TOKEN\nEOF\necho \"$TOKEN\"", blocked: true },
    { command: "cat <<'EOF'\nit's $TOKEN\nEOF\necho \"$TOKEN\"", blocked: true },
    { command: "cat <<'EOF'\n# $TOKEN\nEOF\ngit status --short", blocked: false },
    { command: 'cat <<EOF\nplain text\nEOF\necho "$TOKEN"', blocked: true },
    { command: "cat <<-EOF\n\t# $TOKEN\n\tEOF", blocked: true },
  ])("checks heredoc data and following commands: $command", ({ command, blocked }) => {
    const guard = createCredentialGuard();
    const invoke = () => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
    if (blocked) expect(invoke).toThrow();
    else expect(invoke).not.toThrow();
  });
});

describe("redirects around heredoc bodies", () => {
  it.each([
    {
      command:
        "mkdir -p /tmp/scratch\ntee /tmp/scratch/report.md <<'EOF'\nhello\nEOF\nprintf x > .env",
      blocked: true,
    },
    {
      command:
        "mkdir -p /tmp/scratch\ntee /tmp/scratch/report.md <<'EOF'\nhello\nEOF\nprintf x > /tmp/scratch/output.txt",
      blocked: false,
    },
    {
      command:
        "pwd\ntee /tmp/report.md <<'FIRST'\nhello\nFIRST\ntee /tmp/second.md <<'SECOND'\nworld\nSECOND\nprintf x > .env",
      blocked: true,
    },
    {
      command:
        "pwd\ntee /tmp/report.md <<'FIRST'\nhello\nFIRST\ntee /tmp/second.md <<'SECOND'\nworld\nSECOND\nprintf x > /tmp/output.txt",
      blocked: false,
    },
    { command: "pwd\ntee /tmp/report.md > .env <<'EOF'\nhello\nEOF", blocked: true },
    { command: "printf x > .env\ntee /tmp/report.md <<'EOF'\nhello\nEOF", blocked: true },
    { command: "pwd\ntee /tmp/report.md <<'EOF'\nprintf x > .env\nEOF", blocked: false },
    { command: "pwd\ntee /tmp/report.md <<'EOF'\nhello", blocked: true },
    { command: "pwd\ntee /tmp/report.md <<'EOF' > /tmp/output.txt\nhello\nEOF", blocked: true },
  ])("preserves headers and following commands: $command", ({ command, blocked }) => {
    const guard = createCredentialGuard();
    const invoke = () => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
    if (blocked) expect(invoke).toThrow();
    else expect(invoke).not.toThrow();
  });
});

describe("custom CLI names and wrapper file operands", () => {
  it.each([
    "azcopy login --identity",
    "rtk azcopy login --identity",
    "rtk proxy azcopy login --identity",
    "env -u CI command azcopy login --identity",
    "CI=1 azcopy login --identity",
  ])("preserves custom blocking for Azure-prefixed names: %s", (command) => {
    const guard = createCredentialGuard({
      additionalBlockedCliTools: [{ tool: "azcopy", suggestion: "agent-tools-azcopy" }],
    });
    expect(guard.getBlockedCliTool(command)).toEqual({
      name: "azcopy",
      wrapper: "agent-tools-azcopy",
    });
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
  });

  it.each([
    { path: "leaked-credentials-notes.txt", blocked: true },
    { path: "serviceCredentials.txt", blocked: true },
    { path: ".env", blocked: true },
    { path: "notes.md", blocked: false },
    { path: ".agent/hooks/credential-guard.ts", blocked: false },
    { path: "docs/credential-guard.md", blocked: false },
  ])("applies shared body-file policy: $path", ({ path, blocked }) => {
    const guard = createCredentialGuard();
    for (const command of [
      `cat ${path}`,
      `bun run gh-tool pr create --body-file ${path}`,
      `bun run gh-tool pr create --body-file=${path}`,
    ]) {
      expect(guard.isDangerousBashCommand(command)).toBe(blocked);
      const invoke = () => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
      if (blocked) expect(invoke).toThrow();
      else expect(invoke).not.toThrow();
    }
  });
});

describe("ordinary Python JSON processing", () => {
  const guard = createCredentialGuard();
  // Reported hash comparison with an anonymized workspace path.
  const hashProgram = `from pathlib import Path
import json,hashlib
root=Path('/workspace/example-app')
sources={}
for file in (root/'cli/checklists').glob('*.json'):
 d=json.loads(file.read_text())
 for g in d.get('groups',[]):
  for src in g.get('sources',[]): sources[src['path']]=src['sha256']
wrong=[p for p,h in sources.items() if hashlib.sha256((root/p).read_bytes()).hexdigest()!=h]
print(json.dumps({'sources':len(sources),'mismatches':wrong}))`;

  it.each([
    { name: "reported hash comparison", program: hashProgram },
    {
      name: "same hash comparison with key iteration",
      program: hashProgram
        .replace("p,h in sources.items()", "p in sources")
        .replace(".hexdigest()!=h", ".hexdigest()!=sources[p]"),
    },
    {
      name: "unrelated dictionary items and scalar output",
      program: "import json\nd=json.loads('{}')\nx={}\nfor k,v in x.items(): pass\nprint(1)",
    },
    {
      name: "whole ordinary JSON output",
      program: "import json\nd=json.load(open('settings.json'))\nprint(json.dumps(d))",
    },
  ])("allows $name through inline and stdin forms", ({ program }) => {
    for (const prefix of ["", "rtk proxy "]) {
      for (const command of [
        `${prefix}python3 -c '${program.replaceAll("'", "'\"'\"'")}'`,
        `${prefix}python3 - <<'PY'\n${program}\nPY`,
        `${prefix}python3 - <<PY\n${program}\nPY`,
      ]) {
        expect(guard.isDangerousBashCommand(command)).toBe(false);
        expect(() =>
          guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
        ).not.toThrow();
      }
    }
  });

  it("preserves replacement tokens and quoting in quoted Python heredocs", () => {
    const program = [
      "import re",
      "from pathlib import Path",
      "text = \"\"\"$' $& $` $$ \\\"double\\\" 'single' and '''triple'''",
      "Markdown `code` — café",
      'updated: yesterday"""',
      "updated = re.sub(r'^updated: .*$', 'updated: today', text, flags=re.M)",
      "Path('/tmp/report.md').write_text(updated)",
      "print(updated)",
    ].join("\n");
    for (const prefix of ["", "rtk proxy "]) {
      const command = `${prefix}python3 - <<'PY'\n${program}\nPY`;
      const inline = `${prefix}python3 -c '${program.replaceAll("'", "'\"'\"'")}'`;
      for (const equivalent of [command, inline]) {
        expect(guard.isDangerousBashCommand(equivalent)).toBe(false);
        expect(() =>
          guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: equivalent } }),
        ).not.toThrow();
      }
      const withSensitiveRead = `${command}\ncat .env`;
      expect(guard.isDangerousBashCommand(withSensitiveRead)).toBe(true);
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: withSensitiveRead } }),
      ).toThrow();
    }
  });

  it.each([
    "import os; print(os.environ)",
    'import os; print(os.getenv("TOKEN"))',
    'print(Path(".env").read_text())',
    'eval("1")',
    'exec("print(1)")',
    'getattr(json, "loads")("{}")',
    'import subprocess; subprocess.run(["echo", "hello"], shell=True)',
  ])("still refuses access or execution after JSON hashing: %s", (suffix) => {
    const command = `rtk proxy python3 - <<'PY'\n${hashProgram}\n${suffix}\nPY`;
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
  });

  it.each([
    { config: { additionalBlockedPaths: ["settings[.]json$"] }, suffix: "" },
    { config: { additionalDangerousBashPatterns: ["<<'PY'"] }, suffix: "" },
    { config: {}, suffix: "\ncat .env" },
    { config: {}, suffix: "\nprintf x > .env" },
    { config: {}, suffix: '\necho "$TOKEN"' },
  ])("retains original-command, path, and heredoc suffix checks: %j", ({ config, suffix }) => {
    const configured = createCredentialGuard(config);
    const command = `rtk proxy python3 - <<'PY'\nimport json\nprint(json.load(open("settings.json")))\nPY${suffix}`;
    expect(configured.isDangerousBashCommand(command)).toBe(true);
    expect(() =>
      configured.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).toThrow();
  });

  it("replays a static nested CLI even when the script also hashes JSON", () => {
    const command = `python3 - <<'PY'\nimport subprocess\nargv=["gh", "auth", "token"]\nsubprocess.run(argv)\n${hashProgram}\nPY`;
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow(
      "blocked CLI from a script",
    );
  });

  it.each([
    { program: "import os; print(os.environ)", reason: "environment/execution policy" },
    { program: 'print(r"os.environ")', reason: "environment/execution policy" },
    { program: 'eval("1")', reason: "environment/execution policy" },
    { program: 'print(open(".env").read())', reason: "file-access policy" },
  ])("reports composite policy refusal honestly: $program", ({ program, reason }) => {
    const command = `python3 -c '${program}'`;
    let message = "";
    try {
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(message).toContain(reason);
    expect(message).not.toMatch(/reads (?:process environment|environment variables)/);
    expect(message).not.toContain("If you need environment info");
  });
});

// These are policy inputs only; subprocesses and represented commands are never executed.
describe("literal subprocess cwd replay", () => {
  const program = (argv: string[], cwd?: string, keywords = "") =>
    `import subprocess\nargv=${JSON.stringify(argv)}\nsubprocess.run(argv${cwd === undefined ? "" : `,cwd=${JSON.stringify(cwd)}`}${keywords})`;
  const inputs = (source: string) => [
    `python3 -c '${source.replaceAll("'", "'\"'\"'")}'`,
    `rtk proxy python3 -c '${source.replaceAll("'", "'\"'\"'")}'`,
    `python3 - <<'PY'\n${source}\nPY`,
    `rtk proxy python3 - <<'PY'\n${source}\nPY`,
  ];

  it.each([
    program(["cat", "README.md"]),
    program(["cat", "README.md"], "/tmp/project"),
    program(["cat", "README.md"], "../project"),
    program(["cat", "README.md"], "."),
    program(["cat", "README.md"], "/tmp/project directory"),
    program(
      ["git", "ls-files", "--stage", "-z"],
      "/tmp/project",
      ",capture_output=True,text=True,check=True,timeout=5",
    ),
    program(["git", "ls-tree", "-r", "HEAD"], "/tmp/project"),
    program(["rtk", "proxy", "cat", "README.md"], "/tmp/project"),
    program(["command", "--", "cat", "README.md"], "/tmp/project"),
    program(["env", "env", "rtk", "proxy", "command", "--", "cat", "README.md"], "/tmp/project"),
    program(["find", ".", "-maxdepth", "0", "-print"], "/tmp/project"),
    program(["env", "TEST_COUNT=3", "bun", "check.ts"], "/tmp/project"),
    program(["echo", "cat .env | sh"], "/tmp/project"),
  ])("allows supported literal cwd and preserves no-cwd behavior: %s", (source) => {
    const guard = createCredentialGuard();
    for (const command of inputs(source)) {
      expect(guard.isDangerousBashCommand(command)).toBe(false);
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).not.toThrow();
    }
  });

  it.each([
    program(["cat", "environ"], "/proc/self"),
    program(["cat", "self/environ"], "/proc"),
    program(["cat", "../self/environ"], "/proc/1"),
    program(["cat", "config"], "/tmp/dev/.aws"),
    program(["cat", "config"], ".aws"),
    program(["cat", "config"], "/tmp/dev/.ssh"),
    program(["cat", "config"], "/tmp/secrets"),
    program(["git", "grep", "value", "--", "environ"], "/proc/self"),
    program(["cat", ".env"], "/tmp/project"),
    program(["printenv"], "/tmp/project"),
    program(["env", "cat", "environ"], "/proc/self"),
    program(["sh", "-c", "cat environ"], "/proc/self"),
    program(["bash", "-c", "cat environ"], "/proc/self"),
    program(["env", "env", "sh", "-c", "cat environ"], "/proc/self"),
    program(["rtk", "proxy", "env", "sh", "-c", "cat environ"], "/proc/self"),
    program(["command", "env", "sh", "-c", "cat environ"], "/proc/self"),
    program(["env", "-C", "/proc/self", "cat", "environ"], "/tmp/project"),
    program(["env", "--chdir=/proc/self", "cat", "environ"], "/tmp/project"),
    program(["env", "-S", "sh -c cat"], "/proc/self"),
    ...["-exec", "-execdir", "-ok", "-okdir"].map((option) =>
      program(
        ["find", ".", "-maxdepth", "0", option, "sh", "-c", "cat environ", ";"],
        "/proc/self",
      ),
    ),
    program(["sed", "e cat environ"], "/proc/self"),
    program(["sed", "r environ"], "/proc/self"),
    program(["sed", "-f", "program.sed"], "/proc/self"),
    program(["awk", 'BEGIN {system("cat environ")}'], "/proc/self"),
    program(["awk", 'BEGIN {getline x < "environ"; print x}'], "/proc/self"),
    program(
      ["rtk", "proxy", "env", "python3", "-c", 'print(open("environ").read())'],
      "/proc/self",
    ),
    program(["dash", "-c", "cat environ"], "/proc/self"),
    program(["custom-executor", "cat environ"], "/proc/self"),
    program(["rtk", "unknown", "cat", "environ"], "/proc/self"),
    program(["xargs", "cat"], "/proc/self"),
    program(["python3", "-c", "print(1)"], "/tmp/project"),
    program(["sort", "--compress-program=sh", "README.md"], "/tmp/project"),
    program(["cat", "file"], ""),
    program(["cat", "file"], "/tmp/café"),
    program(["cat", "file"], "~/project"),
    program(["cat", "file"], "-x"),
    program(["cat", "file"], "/tmp\\project"),
    program(["cat", "file"], "/tmp/project\nother"),
    program(["cat", "file"], "/tmp/$PROJECT"),
    program(["cat", "file"], "/tmp/project", ',cwd="/tmp/other"'),
    program(["cat", "file"], "/tmp/project", ",shell=True"),
    program(["cat", "file"], "/tmp/project", ',executable="/tmp/reader"'),
    program(["cat", "file"], "/tmp/project", ",env={}"),
    program(["cat", "file"], "/tmp/project").replace('cwd="/tmp/project"', "cwd=directory"),
    program(["cat", "file"], "/tmp/project").replace('cwd="/tmp/project"', 'cwd="/tmp"+"/project"'),
    program(["cat", "file"], "/tmp/project").replace(
      'cwd="/tmp/project"',
      'cwd=getattr(os,"getcwd")()',
    ),
    program(["cat", "file"], "/tmp/project") + '\nsubprocess.run(["printenv"])',
  ])("refuses sensitive or unproved subprocess cwd forms: %s", (source) => {
    const guard = createCredentialGuard();
    for (const command of inputs(source)) {
      expect(guard.isDangerousBashCommand(command)).toBe(true);
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).toThrow();
    }
  });

  it.each([
    [program(["cat", "file"], "/tmp/project"), { additionalBlockedPaths: ["^/tmp/project/file$"] }],
    [
      program(["cat", "../private/file"], "/tmp/project"),
      { additionalBlockedPaths: ["^/tmp/private/file$"] },
    ],
    [program(["cat", "file"], "../project"), { additionalBlockedPaths: ["^[.][.]/project/file$"] }],
    [program(["cat", "file"], "/tmp/private"), { additionalBlockedPaths: ["^/tmp/private/$"] }],
    [program(["cat", "file"], "/tmp/café"), { additionalBlockedPaths: ["^/tmp/café/file$"] }],
    [
      program(["cat", "file"], "/tmp/project"),
      { additionalDangerousBashPatterns: ["subprocess[.]run"] },
    ],
    [program(["cat", "file"], "/tmp/project"), { additionalDangerousBashPatterns: ["cd --"] }],
  ] satisfies [string, Parameters<typeof createCredentialGuard>[0]][])(
    "retains custom paths and original/replayed command policies: %s",
    (source, config) => {
      const guard = createCredentialGuard(config);
      for (const command of inputs(source))
        expect(() =>
          guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
        ).toThrow();
    },
  );

  it.each(["gh", "kubectl", "psql", "az"])("replays nested CLI policy with cwd: %s", (cli) => {
    const guard = createCredentialGuard();
    for (const command of inputs(program([cli, "auth", "token"], "/tmp/project"))) {
      expect(guard.isDangerousBashCommand(command)).toBe(true);
      expect(guard.getBlockedCliTool(command)).not.toBeNull();
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).toThrow();
    }
  });

  it("keeps outer shell redirects in the original shell directory", () => {
    const source = program(["echo", "safe"], "/tmp/project");
    const guard = createCredentialGuard({ additionalBlockedPaths: ["^/tmp/project/notes[.]txt$"] });
    for (const command of inputs(source))
      for (const redirected of [">", "<"].map((operator) =>
        command.includes(" <<'PY'")
          ? command.replace(" <<'PY'", ` ${operator} notes.txt <<'PY'`)
          : `${command} ${operator} notes.txt`,
      ))
        expect(() =>
          guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: redirected } }),
        ).not.toThrow();
    const blocked = createCredentialGuard({ additionalBlockedPaths: ["^notes[.]txt$"] });
    expect(() =>
      blocked.handleToolExecuteBefore(
        { tool: "Bash" },
        { args: { command: `${inputs(source)[0]} > notes.txt` } },
      ),
    ).toThrow();
  });
});

// Policy inputs only. Never execute these commands.
describe("local exit-status provenance", () => {
  const guard = createCredentialGuard();
  const reported = String.raw`rtk proxy env EXAMPLE_CHECK_QUEUE_DIR=/private/tmp/example-queue-tests/queue-red-tail bun test check/queue-cli.test.ts --test-name-pattern 'recent history' > /private/tmp/example-queue-tests/red-tail.log 2>&1; status=$?; cat /private/tmp/example-queue-tests/red-tail.log; printf '\nEXIT=%s\n' "$status"; exit 0`;

  it.each([
    reported,
    ...["status", "result", "arbitrary_flag", "_outcome", "RUN_RESULT"].flatMap((name) => [
      `${name}=$?; echo "$${name}"`,
      `${name}=$?; echo $${name}`,
      `${name}="$?"; printf '%s\\n' "\${${name}}" | head -1`,
    ]),
    'false; result=$?\nprintf "EXIT=%s\\n" "$result"',
    'result=$?; cat /tmp/result.log; echo "exit=$result"',
    'result=$?; printf "%s\\n" "$result"; result=$?; echo "$result"',
  ])("allows proved status captures and passive displays: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(false);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .not.toThrow();
  });

  it.each([
    'echo "$result"; result=$?',
    'cd "$result"; result=$?; echo "$result"',
    'result=$?; result=.env; echo "$result"',
    'result=1; result=$?; cat "$result"',
    'result=$?; result="$TOKEN"; echo "$result"',
    'result=$?; read result; echo "$result"',
    'result=$?; unset result; echo "$result"',
    'result=$?; printf -v result .env; echo "$result"',
    'false && result=$?; echo "$result"',
    'false || result=$?; echo "$result"',
    'result=$? && echo "$result"',
    'result=$? | cat; echo "$result"',
    'result=$? & echo "$result"',
    '(result=$?); echo "$result"',
    'result=$? echo "$result"',
    String.raw`r"esult"=$?; echo "$result"`,
    String.raw`res\ult=$?; echo "$result"`,
    'result=$?; result=NUMERICSTATUSVALUE0END; echo "$result"',
    'result=$?; "$result"',
    'result=$?; rtk proxy "$result"',
    'result=$?; bash -c "$result"',
    'result=$?; python -c "$result"',
    'result=$?; node -e "$result"',
    'result=$?; printf "$result"',
    'result=$?; printf -v target "%s" "$result"',
    "result=$?; echo --$result",
    'result=$?; head -n "$result" notes.txt',
    'result=$?; cat "$result"',
    'result=$?; cd "$result"',
    'result=$?; git -C "$result" status',
    'result=$?; echo safe > "$result"',
    'result=$?; echo "$result" > .env',
    'result=$?; TARGET="$result" echo safe',
    'result=$?; env TARGET="$result" echo safe',
    'result=$?; other="$result"; echo "$other"',
    'result=$?; echo "$result" | sh',
    'result=$?; echo "$result" | opaque-runner',
    'result=$(printenv); printf "%s" "$result"',
    'result=$?; echo "$(echo "$result")"',
    'result=$?; echo "${result:-}"',
    'result=$?; echo "${result:-fallback}"',
    'result=${?}; echo "$result"',
    'result=$?; echo "$PIPESTATUS"',
    'result=$?; echo "$((result))"',
    'result=$?; opaque-runner; echo "$result"',
    "alias printf='cat .env'; result=$?; printf '%s' \"$result\"",
    'readonly result=previous; result=$?; echo "$result"',
    'result=NUMERICSTATUSVALUE; echo "$result"',
    'result=NUMERICSTATUSVALUE0; echo "$result"',
    'result=$?; result=NUMERICSTATUSVALUE0; echo "$result"',
    ...["PATH", "IFS", "CDPATH", "BASH_ENV", "ENV", "FPATH", "PROMPT_COMMAND"].map(
      (name) => `${name}=$?; echo "$${name}"`,
    ),
  ])("refuses unproved provenance or unsafe status sinks: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .toThrow();
  });

  it.each([
    ['result=$?; cat "$result"', { additionalBlockedPaths: ["^0$"] }],
    [
      'result=$?; echo "$result"; cat /tmp/private/report.txt',
      { additionalBlockedPaths: ["^/tmp/private/report[.]txt$"] },
    ],
    [
      'result=$?; echo "$result" > /tmp/private/report.txt',
      { additionalBlockedPaths: ["^/tmp/private/report[.]txt$"] },
    ],
    [
      'result=$?; git -C /tmp/private status; echo "$result"',
      { additionalBlockedPaths: ["^/tmp/private/$"] },
    ],
    ['result=$?; echo "$result"', { additionalDangerousBashPatterns: ["result="] }],
  ] satisfies [string, Parameters<typeof createCredentialGuard>[0]][])(
    "keeps configured path and command policies active: %s",
    (command, config) => {
      expect(() =>
        createCredentialGuard(config).handleToolExecuteBefore(
          { tool: "Bash" },
          { args: { command } },
        ),
      ).toThrow();
    },
  );
});

// Policy inputs only. Never execute these commands.
describe("exit-status capture runtime controls", () => {
  const guard = createCredentialGuard();
  const controls = [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "LD_DEBUG_OUTPUT",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "_RLD_LIST",
    "LDR_PRELOAD",
    "LIBPATH",
    "SHLIB_PATH",
    "NODE_OPTIONS",
    "NODE_PATH",
    "BUN_OPTIONS",
    "BUN_PRELOAD",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONHOME",
    "RUBYOPT",
    "RUBYLIB",
    "PERL5OPT",
    "PERL5LIB",
    "JAVA_TOOL_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "CLASSPATH",
    "_JAVA_OPTIONS",
    "BASH_XTRACEFD",
    "HOME",
    "XDG_CONFIG_HOME",
    "GIT_SSH_COMMAND",
    "GIT_SSH",
    "GIT_PROXY_COMMAND",
    "GIT_EXEC_PATH",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_PAGER",
    "PAGER",
    "EDITOR",
    "VISUAL",
    "JAVA_HOME",
    "GEM_HOME",
    "GEM_PATH",
    "PERLLIB",
  ];

  it.each(
    controls.flatMap((name) => {
      const cases = [
        `${name}=$?; cat /tmp/report.txt`,
        `${name}=$?; rtk proxy cat /tmp/report.txt`,
        `${name}="$?"; cat /tmp/report.txt; printf '%s' "$${name}"`,
        `${name}=$?; command printf '%s' "$${name}"; rtk proxy cat /tmp/report.txt`,
      ];
      if (name.startsWith("GIT_"))
        cases.push(
          `${name}=$?; git fetch origin main`,
          `${name}=$?; printf '%s' "$${name}"; rtk proxy git fetch origin main`,
        );
      return cases;
    }),
  )("refuses numeric captures into execution-control targets: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .toThrow();
  });

  it.each(
    [
      "ordinary_status",
      "capture_123",
      "userLocal",
      "ld_result",
      "dyld_result",
      "git_result",
      "GIT_EXIT_CODE",
      "NODE_RESULT",
      "PYTHON_STATUS",
      "BUN_RESULT",
      "RUBY_STATUS",
      "PERL_RESULT",
      "JAVA_RESULT",
      "JDK_STATUS",
    ].map((name) => `${name}=$?; cat /tmp/report.txt; printf '%s' "$${name}"`),
  )("keeps ordinary local captures generic: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(false);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .not.toThrow();
  });
});

// Policy inputs only. Never execute these commands.
describe("bounded archived command roles", () => {
  const allowed = [
    "sh -c 'test \"${TEST_FLAG:-}\" = 1'",
    "bun oxlint -c /tmp/project/lint.json --deny-warnings cli",
    "rtk proxy bun oxlint -c /tmp/project/lint.json --deny-warnings cli",
    "node script.js -c config.json",
    "python3 script.py -c config.json",
    "herdr agent prompt worker 'review literal env prose'; herdr agent get worker-review | grep -o status",
    "herdr agent prompt worker 'review'; herdr pane read pane-a --source recent-unwrapped --lines 20 | head",
    `bun run db-tool sql --env staging --limit 0 --sql "select value #>> '{a,b}' from data" | head`,
    `bun run db-tool query --env staging --sql 'select value where code = "#{a,b}"'`,
    `bun run db-tool sql --env=staging --limit=0 --sql="select value #>> '{a,b}' from data"`,
    `bun run db-tool sql --sql 'select "#{a,b}"' --format=json`,
    "echo exit=$?",
    'printf "%s\\n" "exit=$?" | head',
    "false; echo $?; tail -2 notes.log",
    'test "${TEST_FLAG:-}" = 1',
    '[ "${TEST_FLAG:-}" = "" ]',
    'test -z "$TEST_FLAG"',
    'test -n "${TEST_FLAG:-}"',
    'test "1" = "$TEST_FLAG"',
    'echo "${TEST_FLAG:-}"',
    'F=/tmp/result.txt; grep value "$F"; sed -n \'/start/,/end/p\' "$F"',
    "sed -n '/a\\/b/,/end/p' result.txt",
    "sed -n '1,/end/p' result.txt",
    "sed -n '1,25p' result.txt",
  ];
  const denied = [
    "bun --preload /tmp/startup.ts oxlint -c lint.json",
    "bun oxlint --preload /tmp/startup.ts -c lint.json",
    "bun oxlint -r /tmp/startup.ts -c lint.json",
    "bun oxlint -e 'process.env' -c lint.json",
    "bun oxlint -p 'process.env' -c lint.json",
    "bun exec 'cat .env'",
    "bun exec -c 'cat .env'",
    "bun repl",
    "bun -e 'printenv' --preload /tmp/startup.ts",
    "node --conditions example --eval 'process.env'",
    "python3 -W ignore -c 'import os; print(os.environ)'",
    "python3 --check-hash-based-pycs always -c 'import os; print(os.environ)'",
    "python3 -X presite=module script.py",
    "python3 -Xpresite=module script.py",
    "python3 -W ignore::module.Warning script.py",
    "node --unknown value --eval 'process.env'",
    "herdr agent prompt worker 'review'; herdr agent message worker 'env'",
    "herdr agent prompt worker 'review'; herdr agent get worker extra",
    "herdr agent prompt worker 'review'; herdr agent get worker | sh",
    "herdr agent prompt worker 'review'; herdr agent get worker | unknown-executor",
    'herdr agent prompt worker "$(cat .env)"; herdr agent get worker',
    'bun run db-tool sql --env staging --sql "$(cat sql.txt)"',
    'bun run db-tool sql --unknown option --sql "$(cat sql.txt)"',
    'bun run db-tool sql --env=staging --sql="$(cat sql.txt)"',
    "bun run db-tool sql --env staging --sql 'select 1' --sql '{a,b}'",
    "bun run db-tool sql --env '{a,b}' --sql 'select 1'",
    "bun run db-tool unknown --sql '{a,b}'",
    "echo exit=$? | sh",
    "echo exit=$? | unknown-executor",
    'printf "$?"',
    "$? value",
    'echo "$TOKEN $?"',
    "echo $1",
    'echo "$@"',
    'echo "$(echo $?)"',
    "echo $? > .env",
    'test "${NOT_APPROVED:-}" = 1',
    "test ${TEST_FLAG:-} = 1",
    'test "$TEST_FLAG" = "$TOKEN"',
    'test "${TEST_FLAG:-value}" = 1',
    'test "${TEST_FLAG:-}" = 1 | sh',
    'TEST_FLAG="$TEST_FLAG" test "$TEST_FLAG" = 1',
    "F=/tmp/result.txt; sed -n '/start/,/end/e' \"$F\"",
    "F=/tmp/result.txt; sed -n '/start/,/end/r .env' \"$F\"",
    "F=/tmp/result.txt; sed -n '/start/,/end/w .env' \"$F\"",
    'F=/tmp/result.txt; sed -f program.sed "$F"',
    "F=/tmp/result.txt; sed -n '/start/,/end/p; e env' \"$F\"",
    "F=/tmp/result.txt; sed -n '/start/,/end/p' .env",
    "cd /tmp && F=result.txt; sed -n '/start/,/end/p' \"$F\"",
  ];
  it.each(allowed)("allows proved data/metadata roles: %s", (command) => {
    const guard = createCredentialGuard({ allowedEnvironmentVariables: ["TEST_FLAG"] });
    expect(guard.isDangerousBashCommand(command)).toBe(false);
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  });
  it.each(denied)("refuses unsupported execution/expansion roles: %s", (command) => {
    const guard = createCredentialGuard({ allowedEnvironmentVariables: ["TEST_FLAG"] });
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
  });
  it("does not approve environment predicates by default", () => {
    expect(createCredentialGuard().isDangerousBashCommand('test "${TEST_FLAG:-}" = 1')).toBe(true);
  });
  it("retains custom policies for each supported role", () => {
    for (const command of allowed) {
      expect(
        createCredentialGuard({
          allowedEnvironmentVariables: ["TEST_FLAG"],
          additionalDangerousBashPatterns: ["."],
        }).isDangerousBashCommand(command),
      ).toBe(true);
    }
    expect(
      createCredentialGuard({
        additionalBlockedPaths: ["^/tmp/result[.]txt$"],
      }).isDangerousBashCommand("F=/tmp/result.txt; sed -n '/start/,/end/p' \"$F\""),
    ).toBe(true);
  });
});

// Input-only proof corrections. Never execute these command strings.
describe("closed local sed and SQL consumer proofs", () => {
  const sed = (command: string) => `F=/tmp/evidence.txt; ${command} "$F"`;
  it.each([
    sed("sed -n '/start/,/end/p'"),
    sed("rtk proxy sed -n '/start/,/end/p'"),
    sed("command -- sed -n '1,5p'"),
    "env CI=1 sed -n '/start/p' /tmp/evidence.txt",
    "bun run db-tool sql --sql 'select a{b,c}' | head",
    "rtk proxy bun run db-tool sql --sql 'select a{b,c}' | rtk proxy grep value | tail -2",
  ])("retains closed reader/passive controls: %s", (command) => {
    const guard = createCredentialGuard();
    expect(guard.isDangerousBashCommand(command)).toBe(false);
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  });
  it.each([
    ...["sed", "rtk proxy sed", "command -- sed", "env CI=1 sed"].flatMap((prefix) =>
      [
        "-n '/start/e'",
        "-n 's/x/y/e'",
        "-n '/start/r other.txt'",
        "-n '/start/w other.txt'",
        "-f program.sed",
        "-n '1p;2e'",
      ].map((program) => sed(`${prefix} ${program}`)),
    ),
    "F=.env; sed -n '1p' \"$F\"",
    ...[
      "sh",
      "bash",
      "zsh",
      "xargs",
      "unknown-executor",
      "rtk proxy env sh",
      "sed -n '/start/e'",
    ].map((consumer) => `bun run db-tool sql --sql 'select a{b,c}' | ${consumer}`),
    "bun run db-tool sql --sql 'select a{b,c}' | head | sh",
    "rtk proxy bun run db-tool sql --env=staging --sql='select a{b,c}' | command -- sh",
  ])("refuses unproved sed roles and executable SQL consumers: %s", (command) => {
    const guard = createCredentialGuard();
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
  });
  it("retains configured path checks for readonly sed and custom SQL patterns", () => {
    expect(
      createCredentialGuard().isDangerousBashCommand(
        "F=/tmp/evidence.txt; env CI=1 sed -n '/start/p' \"$F\"",
      ),
    ).toBe(true);
    const guard = createCredentialGuard({ additionalBlockedPaths: ["^/tmp/evidence[.]txt$"] });
    expect(guard.isDangerousBashCommand(sed("sed -n '/start/p'"))).toBe(true);
    expect(
      createCredentialGuard({
        additionalDangerousBashPatterns: ["select a"],
      }).isDangerousBashCommand("bun run db-tool sql --sql 'select a{b,c}' | head"),
    ).toBe(true);
  });
});

// Policy inputs only. No represented SQL or shell commands are executed.
describe("shared passive cut consumer proof", () => {
  const sql =
    "bun run db-tool sql --env dev --sql 'SELECT payload #>> \"{item,value}\" FROM records'";
  const quote = (body: string) => "'" + body.replaceAll("'", "'\"'\"'") + "'";
  const allowed = (command: string) => {
    const guard = createCredentialGuard();
    expect(guard.isDangerousBashCommand(command)).toBe(false);
    expect(guard.getBlockedCliTool(command)).toBeNull();
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  };

  it("admits cut after literal SQL output", () => {
    allowed(`${sql} 2>&1 | sed -n '/data/,/rowCount/p' | cut -c1-700`);
  });
  it.each(
    [
      "bun run db-tool sql",
      "bun run db-tool query",
      "rtk bun run db-tool sql",
      "rtk proxy bun run db-tool query",
      "command -- bun run db-tool sql",
    ].flatMap((producer) =>
      ["cut -b 1-8", "cut -c1-40", "cut -d ',' -f 1,3", "cut --fields=2 --delimiter=,"].map(
        (consumer) =>
          `${producer} --sql 'SELECT payload #>> "{item,value}" FROM records' | sed -n '1,5p' | ${consumer}`,
      ),
    ),
  )("allows closed SQL pipeline: %s", allowed);
  it.each([
    "cut -c1-8 README.md",
    "cat README.md | cut -b1-4",
    "printf '%s' 'printenv' | cut -c1-40",
    "echo exit=$? | cut -d= -f2",
    "herdr agent prompt example-reviewer 'Inspect records' | cut -c1-32; herdr agent read example-reviewer --source recent-unwrapped --lines 8 | cut -b1-32",
    "herdr agent prompt example-reviewer 'Inspect records' | cut -c1-32; sleep 1; herdr agent get example-reviewer | cut -c1-32",
    `sh -c ${quote("cat README.md | cut -c1-32")}`,
    `rtk proxy /bin/zsh -f -c ${quote("cat README.md | sed -n '1p' | command -- cut -f1")}`,
  ])("allows other shared passive roles: %s", allowed);
  it.each([
    ...[".env", "/proc/self/environ", "config.pem"].flatMap((path) => [
      `${sql} | cut -c1-32 ${path}`,
      `${sql} | cut -c1-32 < ${path}`,
      `${sql} | cut -c1-32 > ${path}`,
    ]),
    `${sql} | cut -c1-32 "$SECRET"`,
    `${sql} | cut -c1-32 $(cat .env)`,
    `${sql} | cut -c1-32 \`cat .env\``,
    `${sql} | cut -c1-32 | sh`,
    `${sql} | cut -c1-32 | xargs`,
    `${sql} | cut -c1-32 | unknown-executor`,
    `${sql} | sed -n '1e' | cut -c1-32`,
    `${sql} | sed -f program.sed | cut -c1-32`,
    `${sql} | env -S 'sh -c printenv' | cut -c1-32`,
    `bun run unknown-tool --sql 'SELECT a{b,c}' | cut -c1-32`,
    `bun run db-tool sql --sql 'SELECT a{b,c}' --unknown option | cut -c1-32`,
    `bun run db-tool sql --sql 'SELECT a{b,c}' --sql 'SELECT 1' | cut -c1-32`,
    `bun run db-tool sql --sql "$(cat query.sql)" | cut -c1-32`,
    // SQL braces inside these shell bodies already refuse with head on the old guard.
    `sh -c ${quote(`${sql} | cut -c1-32`)}`,
    `rtk proxy /bin/zsh -f -c ${quote(`${sql} | sed -n '1p' | command -- cut -f1`)}`,
    `sh -c ${quote(`${sql} | cut -c1-32 .env`)}`,
    `bash -c ${quote(`${sql} | cut -c1-32 | xargs`)}`,
    `sh -c ${quote(`gh api user | cut -c1-32`)}`,
  ])("retains refusal after cut: %s", (command) => {
    const guard = createCredentialGuard();
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
  });
  it("retains path, command, environment and exact CLI policies", () => {
    const pipeline = `${sql} | cut -c1-32`;
    const pathGuard = createCredentialGuard({ additionalBlockedPaths: ["^private[.]txt$"] });
    expect(pathGuard.isDangerousBashCommand(`${pipeline} private.txt`)).toBe(true);
    const commandGuard = createCredentialGuard({ additionalDangerousBashPatterns: ["cut -c1-32"] });
    expect(commandGuard.isDangerousBashCommand(pipeline)).toBe(true);
    const cliGuard = createCredentialGuard({
      additionalBlockedCliTools: [{ tool: "cut", suggestion: "approved-reader" }],
    });
    expect(cliGuard.getBlockedCliTool(pipeline)?.name).toBe("cut");
    expect(() =>
      cliGuard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: pipeline } }),
    ).toThrow();
    const envGuard = createCredentialGuard({ allowedEnvironmentVariables: ["WORKSPACE_LABEL"] });
    expect(envGuard.isDangerousBashCommand('echo "$WORKSPACE_LABEL" | cut -c1-8')).toBe(false);
    expect(envGuard.isDangerousBashCommand('cut -c1-8 "$WORKSPACE_LABEL"')).toBe(true);
    expect(
      envGuard.isDangerousBashCommand(
        "NODE_OPTIONS=--require=loader.js python3 -c 'import os; print(os.environ[\"WORKSPACE_LABEL\"])' | cut -c1-8",
      ),
    ).toBe(true);
    expect(createCredentialGuard().getBlockedCliTool(`${pipeline} | psql example`)?.name).toBe(
      "psql",
    );
  });
});

// These are guard inputs only. Never execute shell bodies or speedtest commands.
describe("bounded literal shell body replay", () => {
  const quote = (body: string) => "'" + body.replaceAll("'", "'\"'\"'") + "'";
  it("refuses the reported login shell even when both metadata names are approved", () => {
    const guard = createCredentialGuard({
      allowedEnvironmentVariables: ["HERDR_ENV", "CODEX_SESSION_ID"],
    });
    const body =
      'printf "HERDR_ENV=%s CODEX_SESSION_ID=%s\\n" "$HERDR_ENV" "$CODEX_SESSION_ID"; herdr pane current --current';
    for (const command of [body, "herdr pane current --current"]) {
      expect(guard.isDangerousBashCommand(command)).toBe(false);
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).not.toThrow();
    }
    const loginShell = `rtk proxy sh -lc ${quote(body)}`;
    expect(guard.isDangerousBashCommand(loginShell)).toBe(true);
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: loginShell } }),
    ).toThrow("cannot prove a bounded literal shell invocation");
    for (const command of [
      body.replaceAll("CODEX_SESSION_ID", "UNKNOWN_METADATA"),
      body.replaceAll("CODEX_SESSION_ID", "TOKEN"),
      `${body} | sh`,
    ]) {
      expect(guard.isDangerousBashCommand(command)).toBe(true);
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).toThrow();
    }
  });
  const wrappers = [
    "sh -c ",
    "/bin/sh -c ",
    "bash -c ",
    "/bin/zsh -f -c ",
    "rtk proxy /bin/zsh -f -c ",
  ];
  const nested = (count: number, body: string) => {
    for (let i = 0; i < count; i++) body = "sh -c " + quote(body);
    return body;
  };
  it.each([
    "echo safe",
    "echo 'exec sh -c cat .env; nohup; sudo; env -i'",
    "printf '%s' 'exec sh -c cat .env; nohup; sudo; env -i'",
    "cat README.md",
    "ls -l README.md",
    "pwd",
    "true",
    "false",
    "grep 'env' README.md | head -n 2",
    "sed -n '/start/,/end/p' README.md",
    "cd /tmp/project && cat README.md",
    "echo safe; cat README.md",
    "bun run db-tool sql --env staging --sql 'select 1' | head",
  ])("retains fully proved ordinary bodies: %s", (body) => {
    for (const prefix of wrappers) {
      const command = prefix + quote(body);
      const guard = createCredentialGuard();
      expect(guard.isDangerousBashCommand(command)).toBe(false);
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).not.toThrow();
    }
  });
  it.each([
    "cat .env",
    "cat /proc/self/environ",
    "cat /tmp/.aws/config",
    "cat /tmp/.ssh/config",
    "printenv",
    'echo "$TOKEN"',
    "env",
    "gh auth token",
    "cd /proc/self && cat environ",
    "cd /proc/self; cat environ",
    "cd /tmp/.aws && cat config",
    "sed -n '/start/e' README.md",
    "find . -exec sh -c 'cat .env' ;",
    "echo env | sh",
    "unknown-executor data",
    "env PATH=/tmp cat README.md",
    "BASH_ENV=/tmp/startup bash -c 'echo safe'",
    "if true; then cat .env; fi",
    'for p in /tmp/tool; do "$p" --version; done',
  ])("replays protected or unsupported bodies: %s", (body) => {
    for (const prefix of wrappers) {
      const command = prefix + quote(body);
      const guard = createCredentialGuard();
      expect(guard.isDangerousBashCommand(command)).toBe(true);
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).toThrow();
    }
  });
  it.each([
    "exec /bin/sh -c 'cat .env'",
    "env -i sh -c 'cat .env'",
    "/usr/bin/env sh -c 'cat .env'",
    "nohup sh -c 'cat .env'",
    "sudo sh -c 'cat .env'",
    "rtk proxy exec sh -c 'cat .env'",
    "command -- nohup sh -c 'cat .env'",
    "sudo --unknown sh -c 'cat .env'",
    "sh -c 'exec sh -c cat'",
    "cd /proc/self && sh -c 'cat environ'",
    "cd /tmp/.aws && /bin/zsh -f -c 'cat config'",
    "cd /tmp/project && sh -c 'cat README.md'",
    "cd /proc/self; sh -c 'cat environ'",
    "env -C /proc/self sh -c 'cat environ'",
    "env --chdir=/proc/self sh -c 'cat environ'",
    "env CI=1 sh -c 'echo safe'",
    "PATH=/tmp sh -c 'echo safe'",
    "sh -c 'echo safe' positional",
    "sh -lc 'echo safe'",
    "zsh -c 'echo safe'",
    "bash --unknown -c 'echo safe'",
    "/tmp/sh -c 'echo safe'",
    "dash -c 'echo safe'",
    "sh script.sh",
    "sh <<'EOF'\ncat .env\nEOF",
    'sh -c "$SCRIPT"',
    "sh -c 'echo safe' < .env",
  ])("refuses unproved wrapper identity/context: %s", (command) => {
    expect(createCredentialGuard().isDangerousBashCommand(command)).toBe(true);
  });
  it.each(["gh", "kubectl", "psql", "az"])("preserves nested blocked CLI descriptor: %s", (cli) => {
    for (const prefix of wrappers) {
      const command = prefix + quote(`${cli} auth token`);
      const guard = createCredentialGuard();
      expect(guard.getBlockedCliTool(command)?.name).toBe(cli);
      expect(guard.isDangerousBashCommand(command)).toBe(true);
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).toThrow();
    }
  });
  it("retains custom body and original wrapper policies", () => {
    for (const prefix of wrappers) {
      expect(
        createCredentialGuard({
          additionalBlockedPaths: ["^/tmp/private-report$"],
        }).isDangerousBashCommand(prefix + quote("cat /tmp/private-report")),
      ).toBe(true);
      expect(
        createCredentialGuard({
          additionalBlockedPaths: ["^/tmp/project/report$"],
        }).isDangerousBashCommand(prefix + quote("cd /tmp/project && cat report")),
      ).toBe(true);
      expect(
        createCredentialGuard({
          additionalDangerousBashPatterns: ["echo safe"],
        }).isDangerousBashCommand(prefix + quote("echo safe")),
      ).toBe(true);
      expect(
        createCredentialGuard({
          additionalDangerousBashPatterns: ["sh -c|zsh -f"],
        }).isDangerousBashCommand(prefix + quote("echo safe")),
      ).toBe(true);
    }
  });
  it("preserves raw configured patterns across materialized shell loops", () => {
    const command = "sh -c " + quote('for p in README.md; do cat "$p"; done');
    expect(createCredentialGuard().isDangerousBashCommand(command)).toBe(false);
    expect(
      createCredentialGuard({ additionalDangerousBashPatterns: ["^sh -c"] }).isDangerousBashCommand(
        command,
      ),
    ).toBe(true);
  });
  it("keeps shell body cwd distinct from outer redirect cwd", () => {
    const command = "sh -c " + quote("cd /tmp/project && echo safe") + " > notes.txt";
    expect(
      createCredentialGuard({
        additionalBlockedPaths: ["^/tmp/project/notes[.]txt$"],
      }).isDangerousBashCommand(command),
    ).toBe(false);
    expect(
      createCredentialGuard({ additionalBlockedPaths: ["^notes[.]txt$"] }).isDangerousBashCommand(
        command,
      ),
    ).toBe(true);
    expect(
      createCredentialGuard().isDangerousBashCommand("sh -c " + quote("echo safe > .env")),
    ).toBe(true);
  });
  it.each([
    "nice sh -c 'cat /proc/self/environ'",
    "nice -n 5 sh -c 'cat /proc/self/environ'",
    "timeout 1 sh -c 'cat /proc/self/environ'",
    "/usr/bin/time sh -c 'cat /proc/self/environ'",
    "time sh -c 'cat /proc/self/environ'",
    "stdbuf -oL sh -c 'cat /proc/self/environ'",
    "setsid sh -c 'cat /proc/self/environ'",
    "command -p sh -c 'cat /proc/self/environ'",
    "rtk unknown sh -c 'cat /proc/self/environ'",
    "opaque-launcher --argument sh -c 'cat /proc/self/environ'",
    "opaque-launcher --shell=sh -c 'cat /proc/self/environ'",
    "if true; then sh -c 'cat /proc/self/environ'; fi",
    "! sh -c 'cat /proc/self/environ'",
    "xargs sh -c 'cat /proc/self/environ'",
    "find . -exec sh -c 'cat /proc/self/environ' {} +",
    "find . -execdir sh -c 'cat /proc/self/environ' {} +",
    "busybox sh -c 'cat /proc/self/environ'",
    "rbash -c 'cat /proc/self/environ'",
    "rksh -c 'cat /proc/self/environ'",
    "ksh93 -c 'cat /proc/self/environ'",
    "zsh5 -c 'cat /proc/self/environ'",
    "/bin/bash5.2 -c 'cat /proc/self/environ'",
    "timeout 1 zsh5 -c 'cat /proc/self/environ'",
    "rtk proxy opaque-launcher /bin/sh -c 'cat .env'",
    "grep sh README.md | xargs sh -c 'cat .env'",
  ])("refuses shell words in unproved executor/control roles: %s", (command) => {
    const guard = createCredentialGuard();
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
  });
  it.each([
    "python3 -c sh",
    "node -e sh",
    "python3 -c \"print('sh')\"",
    "node -e \"console.log('sh')\"",
    "echo sh bash rbash rksh ksh93 zsh5",
    "printf '%s' sh /bin/sh rbash",
    "echo 'nice sh -c cat .env; timeout; xargs; if; then'",
    "grep sh README.md",
    "rg sh README.md",
    "rg --glob=sh pattern README.md",
    "cat /bin/sh",
    "ls -l /bin/sh",
    "test -e /bin/sh",
    "find . -name sh",
    "sed -n '/sh/p' README.md",
  ])("retains proved shell-named data and metadata operands: %s", (command) => {
    const guard = createCredentialGuard();
    expect(guard.isDangerousBashCommand(command)).toBe(false);
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  });
  it("accepts the eight-wrapper nesting bound", () => {
    expect(createCredentialGuard().isDangerousBashCommand(nested(8, "echo safe"))).toBe(false);
  });
  it("refuses the ninth wrapper", () => {
    expect(createCredentialGuard().isDangerousBashCommand(nested(9, "echo safe"))).toBe(true);
  });
  it("refuses shell invocations exceeding the byte bound", () => {
    expect(
      createCredentialGuard().isDangerousBashCommand(
        "sh -c " + quote("echo " + "a".repeat(65_536)),
      ),
    ).toBe(true);
  });
});

describe("credential guard argument roles", () => {
  it.each(argvRoleCases)("$id", ({ command, config, expected_allowed }) => {
    const invoke = () =>
      createCredentialGuard(config).handleToolExecuteBefore(
        { tool: "Bash" },
        { args: { command } },
      );
    if (expected_allowed) expect(invoke).not.toThrow();
    else expect(invoke).toThrow();
  });
});

// These are hook inputs only. Never execute the represented commands.
describe("bounded literal path braces", () => {
  const guard = createCredentialGuard();
  const members = (count: number) => Array.from({ length: count }, (_, i) => `file${i}`).join(",");
  it.each([
    {
      case: "reported search shape with options, trailing paths and a glob",
      command:
        "rtk proxy rg -n -i 'alpha|beta|gamma|delta|model famil|cross.model|harness|native subagent' .agents/skills/{delegate,playbook,driver,worker,advisor,scout} cli/README.md cli/*.ts",
      blocked: false,
    },
    {
      case: "several path lists",
      command: "rg -ni value src/{a,b} docs/{c,d}.md README.md",
      blocked: false,
    },
    { case: "shared path handling for cat", command: "cat docs/{guide,api}.md", blocked: false },
    {
      case: "shared path handling for grep",
      command: "grep -n value src/{a,b}.ts",
      blocked: false,
    },
    {
      case: "quoted regex braces",
      command: "rg -n 'a{1,3}|(env|printenv)' src/{a,b}",
      blocked: false,
    },
    {
      case: "quoted literal path remains data",
      command: "rg -n 'src/{a,b}' docs/{guide,api}",
      blocked: false,
    },
    {
      case: "escaped braces remain data",
      command: String.raw`rg -n a\{1,3\} src/{a,b}`,
      blocked: false,
    },
    {
      case: "quoted spaces remain one pattern",
      command: 'rg -n "env value" src/{a,b}',
      blocked: false,
    },
    {
      case: "escaped space remains one pattern",
      command: String.raw`rg -n env\ value src/{a,b}`,
      blocked: false,
    },
    { case: "sixteen list members", command: `cat docs/{${members(16)}}`, blocked: false },
    { case: "seventeen list members", command: `cat docs/{${members(17)}}`, blocked: true },
    {
      case: "thirty-two generated paths",
      command: `cat src/{${members(16)}} docs/{${members(16)}}`,
      blocked: false,
    },
    {
      case: "thirty-three generated paths",
      command: `cat src/{${members(16)}} docs/{${members(15)}} test/{a,b}`,
      blocked: true,
    },
    {
      case: "bounded output size",
      command: `cat ${"a".repeat(4000)}/{${members(16)}}`,
      blocked: false,
    },
    {
      case: "oversized output",
      command: `cat ${"a".repeat(4200)}/{${members(16)}}`,
      blocked: true,
    },
    { case: "oversized input", command: `cat docs/{a,b} ${"x".repeat(65_536)}`, blocked: true },
    { case: "sensitive env member", command: "rg -n value config/{README.md,.env}", blocked: true },
    { case: "sensitive suffix", command: "cat config/{dev,prod}/.env", blocked: true },
    {
      case: "sensitive secret member",
      command: "cat config/{README.md,secrets.json}",
      blocked: true,
    },
    { case: "sensitive proc member", command: "cat /proc/{self,1}/environ", blocked: true },
    {
      case: "sensitive later brace word",
      command: "rg -n value src/{a,b} config/{README.md,.env}",
      blocked: true,
    },
    { case: "sensitive trailing operand", command: "rg -n value src/{a,b} .env", blocked: true },
    {
      case: "sensitive pattern-file operand",
      command: "rg -n -f config/{README.md,.env}",
      blocked: true,
    },
    {
      case: "unknown command still checks expanded paths",
      command: "inspect config/{README.md,.env}",
      blocked: true,
    },
    { case: "command name expansion", command: "/usr/bin/{env,printenv}", blocked: true },
    {
      case: "wrapped command name expansion",
      command: "rtk proxy /usr/bin/{gh,echo} auth token",
      blocked: true,
    },
    {
      case: "environment wrapper command expansion",
      command: "env /usr/bin/{printenv,echo}",
      blocked: true,
    },
    {
      case: "environment wrapper blocked cli expansion",
      command: "env /usr/bin/{gh,echo} auth token",
      blocked: true,
    },
    { case: "hidden env command", command: "e{,}nv src/{a,b}", blocked: true },
    { case: "hidden gh command", command: "g{,}h auth token src/{a,b}", blocked: true },
    {
      case: "exec command position",
      command: "exec /usr/bin/{printenv,printf} TOKEN",
      blocked: true,
    },
    { case: "exec argv zero", command: "exec -a /usr/bin/{printenv,printenv}", blocked: true },
    { case: "exec hidden cli", command: "exec -a /usr/bin/{gh,gh} auth token", blocked: true },
    { case: "timeout executor", command: "timeout 10 /usr/bin/{printenv,printf}", blocked: true },
    { case: "xargs executor", command: "xargs /usr/bin/{printenv,printf}", blocked: true },
    { case: "glob executable", command: "p[r]intenv ./x{a,b} TOKEN", blocked: true },
    { case: "opaque command", command: "inspect src/{a,b}", blocked: true },
    {
      case: "expanded git pager option",
      command: "git grep -O/bin/{sh,sh} pattern",
      blocked: true,
    },
    {
      case: "expanded git pager environment command",
      command: "git grep -O/usr/bin/{env,printenv} pattern",
      blocked: true,
    },
    { case: "executor option", command: "rg --pre src/{cat,sh} value README.md", blocked: true },
    { case: "quoted hidden executor", command: "sh -c 'e{,}nv' src/{a,b}", blocked: true },
    { case: "executor in second command", command: "cat src/{a,b}; env", blocked: true },
    { case: "executor consumer", command: "echo src/{a,b} | sh", blocked: true },
    { case: "sensitive redirection", command: "cat src/{a,b} > .env", blocked: true },
    { case: "literal braces in text", command: "echo foo{bar}", blocked: false },
    { case: "literal brace filename", command: "rg -n token src/{literal}", blocked: false },
    {
      case: "literal closing brace filename",
      command: "rg -n token src/name}suffix",
      blocked: false,
    },
    {
      case: "malformed outer brace with real inner expansion",
      command: "cat src/{broken{a,b}",
      blocked: true,
    },
    { case: "nested lists", command: "cat src/{a,{b,c}}", blocked: true },
    { case: "multiple lists in one path", command: "cat src/{a,b}/{c,d}", blocked: true },
    { case: "range", command: "cat src/{1..3}", blocked: true },
    { case: "empty member", command: "cat src/{,a}", blocked: true },
    { case: "literal unclosed brace", command: "cat src/{a,b", blocked: false },
    { case: "literal closing brace", command: "cat src/a,b}", blocked: false },
    { case: "mixed quoting", command: "cat 'src/'{a,b}", blocked: true },
    { case: "escaped separator", command: String.raw`cat src/{a\,b,c}`, blocked: true },
    { case: "variable expansion", command: "cat $ROOT/{a,b}", blocked: true },
    { case: "command substitution", command: "cat src/{a,b} $(env)", blocked: true },
    { case: "unclosed quote", command: "cat src/{a,b} 'open", blocked: true },
  ])("$case", ({ command, blocked }) => {
    const invoke = () => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
    if (blocked) expect(invoke).toThrow();
    else expect(invoke).not.toThrow();
  });

  it.each(["\u00a0", "\v", "\f", "\r", "\u2028"])(
    "refuses unsupported unquoted whitespace %j without losing path prefixes or suffixes",
    (space) => {
      const custom = createCredentialGuard({
        additionalBlockedPaths: [`^foo${space}src/b$`, `^src/b${space}$`],
      });
      for (const command of [`cat foo${space}src/{a,b}`, `cat src/{a,b}${space}`]) {
        expect(() =>
          custom.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
        ).toThrow();
      }
    },
  );

  it("checks every expanded path against custom rules", () => {
    const custom = createCredentialGuard({ additionalBlockedPaths: ["^docs/api[.]md$"] });
    expect(() =>
      custom.handleToolExecuteBefore(
        { tool: "Bash" },
        { args: { command: "cat src/{a,b}.ts docs/{guide,api}.md" } },
      ),
    ).toThrow();
  });

  it.each(["\\{a,b\\}", "src/b[.]ts"])("retains configured command rule %s", (pattern) => {
    const custom = createCredentialGuard({ additionalDangerousBashPatterns: [pattern] });
    expect(() =>
      custom.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: "cat src/{a,b}.ts" } }),
    ).toThrow();
  });
});

// Hook inputs only: these shell commands are never executed.
describe("bounded Herdr command composition", () => {
  const guard = createCredentialGuard();
  const prompt =
    'herdr agent prompt worker-driver "[deploy] User asks for status. Please read the model policy, repeat the rehearsal, and send me the verdict."';
  const reportedPrompt = `${prompt} 2>&1 | grep -o '"type":"[a-z_]*"'; cat /tmp/agent-memory/model-policy.md`;
  const projection =
    'import json,sys;d=json.load(sys.stdin);print(d["result"].get("text","") if isinstance(d.get("result"),dict) else d)';
  const quote = (word: string) => "'" + word.replaceAll("'", "'\"'\"'") + "'";
  const body = (program = projection) =>
    `echo "== $p"; herdr pane read "$p" --source recent-unwrapped --lines 25 2>&1 | python3 -c ${quote(program)} | grep -v '^\\s*$' | tail -12`;
  const loop = (commands = body(), items = "w1:p20 w1:p21", binder = "p") =>
    `for ${binder} in ${items}; do ${commands}; done`;

  it.each([
    reportedPrompt,
    `${prompt}; cat README.md`,
    `cat README.md; ${prompt}`,
    `${prompt}; rtk proxy cat -- README.md | head -1`,
    `command -- ${prompt}; command cat README.md`,
    `${prompt}; grep -n 'printenv TOKEN' README.md`,
    loop(),
    loop(body(projection.replace(/\bd\b/g, "x"))),
    loop(
      body(
        projection
          .replace("json,sys;d=", "json, sys\nx = ")
          .replaceAll("d[", "x[")
          .replaceAll("d.get", "x.get")
          .replace("else d)", "else x)"),
      ),
    ),
    loop("herdr pane read ${p} --source recent-unwrapped --lines 25"),
    loop('rtk proxy herdr pane read "$p" --source recent-unwrapped --lines 25'),
    loop('command -- herdr pane read "$p" --source recent-unwrapped --lines 25'),
    loop(
      'herdr pane read "$p" --source recent-unwrapped --lines 25',
      Array.from({ length: 16 }, (_, i) => `w1:p${i}`).join(" "),
    ),
  ])("allows proved data composition: %s", (command) => {
    expect(guard.isDangerousBashCommand(command)).toBe(false);
    expect(guard.getBlockedCliTool(command)).toBeNull();
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  });

  it.each([
    `${prompt}; cat .env`,
    `${prompt}; cat ~/.aws/credentials`,
    `${prompt}; cat /proc/self/environ`,
    `${prompt}; cat README.md > .env`,
    `${prompt}; cat README.md < .env`,
    `${prompt}; cat "$UNKNOWN"`,
    `${prompt}; cat "$(cat .env)"`,
    `${prompt}; cat README.md | sh`,
    `${prompt} | bash`,
    `${prompt} | xargs`,
    `${prompt} | opaque-runner`,
    `${prompt} | cat README.md`,
    `${prompt}; echo 'printenv TOKEN' | sh`,
    `${prompt}; printenv TOKEN`,
    `${prompt}; python3 -c 'import os; print(os.environ)'`,
    `${prompt}; rg --pre=printenv value README.md`,
    `${prompt}; git grep -Oprintenv value`,
    `${prompt}; env cat README.md`,
    `PATH=/tmp ${prompt}; cat README.md`,
    `env BASH_ENV=./startup ${prompt}; cat README.md`,
    `rtk ${prompt}; cat README.md`,
    `${prompt}; cat\u00a0README.md`,
    loop(body(projection + ";print(1)")),
    loop(body(projection.replace("import json,sys", "import json,sys,os"))),
    loop(body(projection.replace("json.load(sys.stdin)", "eval(sys.stdin.read())"))),
    loop(body(projection.replace("json.load(sys.stdin)", 'json.load(open(".env"))'))),
    loop(body(projection.replace("print(d[", "exec(d["))),
    loop(body(projection.replace("else d)", 'else getattr(d,"text"))'))),
    loop(
      body(
        projection
          .replace(";d=", ";data=")
          .replaceAll("d[", "data[")
          .replaceAll("d.get", "data.get")
          .replace("else d)", "else data)"),
      ),
    ),
    loop(body().replace("python3 -c", "python3 -I -c")),
    loop(body().replace("python3 -c", "env python3 -c")),
    loop(body().replace("python3 -c", "/tmp/python3 -c")),
    loop(body().replace(`${quote(projection)} |`, `${quote(projection)} extra |`)),
    loop(body().replace("| tail -12", "| sh")),
    loop(body().replace("| tail -12", "| xargs")),
    loop(body().replace("| tail -12", "| opaque-runner")),
    loop(body().replace("--source recent-unwrapped", "--source $p")),
    loop(body().replace("--lines 25", "--lines $p")),
    loop(body().replace("--lines 25", "--lines 25 --lines 26")),
    loop(body().replace("--lines 25", "--unknown 25")),
    loop(body().replace("--lines 25", "--lines --source")),
    loop(body().replace("2>&1", "2> /tmp/output")),
    loop(body().replace("2>&1", "2>&3")),
    loop(body().replace("2>&1", "< .env")),
    loop(body() + "; cat .env"),
    loop(body() + "; printenv TOKEN"),
    loop(body() + "; p=.env"),
    loop(body() + "; read p"),
    loop(body() + "; printf -v p .env"),
    loop(body().replace("herdr pane", "$p pane")),
    loop(body().replace("herdr pane", "herdr\u00a0pane")),
    loop(body().replaceAll("$p", "$IFS"), "/", "IFS"),
    loop(body(), "-x"),
    loop(body(), "w1:p20 $(cat .env)"),
    loop(body(), Array.from({ length: 17 }, (_, i) => `w1:p${i}`).join(" ")),
    loop(Array.from({ length: 17 }, () => 'echo "$p"').join("; ")),
    loop(`echo "${"x".repeat(65_536)}$p"`),
  ])("refuses unsafe or unproved composition: %s", (command) => {
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
  });

  it("keeps configured policies active after both proofs", () => {
    for (const [command, config] of [
      [reportedPrompt, { additionalBlockedPaths: ["model-policy"] }],
      [reportedPrompt, { additionalDangerousBashPatterns: ["worker-driver"] }],
      [loop(), { additionalDangerousBashPatterns: ["w1:p21"] }],
      [loop(), { additionalDangerousBashPatterns: [String.raw`\$p`] }],
    ] satisfies [string, Parameters<typeof createCredentialGuard>[0]][]) {
      expect(() =>
        createCredentialGuard(config).handleToolExecuteBefore(
          { tool: "Bash" },
          { args: { command } },
        ),
      ).toThrow();
    }
  });
});

// Hook inputs only: these shell commands are never executed.
describe("literal working-directory operands", () => {
  const guard = createCredentialGuard();
  const directory = "/tmp/worktrees/credential-guard-boundaries";

  it.each(
    ["git", "rtk git", "rtk proxy git"].flatMap((git) => [
      `${git} -C ${directory} fetch origin main`,
      `${git} -C ${directory} fetch origin`,
      `${git} -C ${directory} fetch origin main | head -1`,
      `${git} -C ${directory} fetch origin main | cat notes.txt`,
      `${git} -C ${directory} fetch origin main; git rev-parse --show-toplevel`,
      `${git} -C '${directory} directory' status --short`,
      `${git} -C ./credential-guard-awk-update fetch origin main`,
      `${git} -C ${directory} rev-parse HEAD`,
      `${git} -C ${directory} rev-list --count HEAD`,
      `${git} -C /tmp/worktrees -C credential-guard-boundaries -C ../secret-feature fetch origin main`,
      `cd ${directory} && ${git} fetch origin main`,
      `cd -- './secret-feature directory' && ${git} status --short`,
    ]),
  )("allows literal navigation without classifying directory names as files: %s", (command) => {
    expect(guard.isDangerousBashCommand(command)).toBe(false);
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  });

  it.each([
    "git -C /tmp/credential-backups config --list",
    "git -C /tmp/credential-backups -c core.pager='cat .env' log",
    "git -C /tmp/credential-backups --exec-path=/tmp/custom-tools status",
    "git -C /tmp/credential-backups fetch --upload-pack='cat .env' origin main",
    `cd /tmp/credential-backups && python -c 'print(open("notes.txt").read())'`,
    `cd /tmp/credential-backups && node -e 'console.log(require("fs").readFileSync("notes.txt", "utf8"))'`,
    "cd /tmp/credential-backups && bun run gh-tool pr create --title review --repo example/repo --body-file notes.txt",
    "cd /tmp/credential-backups && rtk proxy bun run gh-tool pr create --title review --repo example/repo --body-file notes.txt",
    "cd /tmp/credential-backups && bun run gh-tool pr create --title review --repo example/repo --body-file=notes.txt",
    "git -C /tmp/credential-backups show HEAD:notes.txt",
    "git -C /tmp/credential-backups show HEAD:.env",
    "rtk git -C /tmp/credential-backups show HEAD:.env",
    "rtk proxy git -C /tmp/credential-backups show HEAD:.env",
    "cd /tmp/credential-backups && git show HEAD:notes.txt",
    ...["git", "rtk git", "rtk proxy git"].flatMap((git) => [
      `${git} -C ${directory} fetch --upload=printenv origin main`,
      `${git} -C ${directory} fetch origin main --upload-pack=printenv`,
      `${git} -C ${directory} fetch origin main --u=printenv`,
      `${git} -C ${directory} fetch -u origin main`,
      `${git} -C ${directory} --paginate status`,
      `${git} -C ${directory} status --exec-path=/tmp/tools`,
      `${git} -C ${directory} custom-command`,
      `${git} -C ${directory} 'rev-parse HEAD'`,
      `${git} -C ${directory} 'rev-list --count HEAD'`,
      `${git} -C ${directory} -c core.pager=printenv -C ../credential-data status`,
      `${git} -C ${directory} fetch origin main | cat .env`,
      `${git} -C ${directory} fetch origin main; printenv`,
      `${git} -C ${directory} fetch origin main; ${git} -C ${directory} show HEAD:.env`,
      `cd ${directory} && ${git} status --short | cat notes.txt`,
    ]),
    'D=/tmp/credential-backups; git -C "$D" show HEAD:.env',
    `git -C ${directory} grep value -- .env`,
    `git -C ${directory} grep value -- credentials.json`,
    `cat ${directory}/credentials.json`,
    `cd ${directory} && cat credentials.json`,
    `git -C ${directory} status > .env`,
    `git -C ${directory} status >> /tmp/.aws/config`,
    "git -C /tmp/.aws fetch origin main",
    "git -C /tmp/.ssh fetch origin main",
    "git -C /tmp/.kube fetch origin main",
    "git -C /tmp/secrets fetch origin main",
    "git -C /tmp/credentials fetch origin main",
    "git -C /proc/self/environ fetch origin main",
    "git -C /tmp/worktrees -C ../../.aws fetch origin main",
    "cd /tmp/.aws && git fetch origin main",
    "cd /tmp/credential-backups && cat notes.txt",
    "cd /tmp/credential-backups; cat notes.txt",
    "cd /tmp/credential-guard; cat notes.txt",
    "cd /tmp/credential-guard-policy.ts; cat notes.txt",
    "cd /tmp/credential-backups || cat notes.txt",
    "cd /tmp/credential-backups && cd /tmp/missing; cat notes.txt",
    "cd /tmp/credential-backups && cd /tmp/missing && cat notes.txt",
    'git -C "$UNKNOWN" fetch origin main',
    'git -C "$(cat .env)" fetch origin main',
    "git -C `cat .env` fetch origin main",
  ])("keeps sensitive operands, secret stores and unsafe expansions blocked: %s", (command) => {
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
  });

  it.each([
    [`git -C ${directory} fetch origin main`, { additionalBlockedPaths: [directory + "$"] }],
    [`git -C ${directory} fetch origin main`, { additionalBlockedPaths: [directory + "/$"] }],
    [
      "git -C /tmp/worktrees -C credential-guard-boundaries fetch origin main",
      { additionalBlockedPaths: ["^" + directory + "/$"] },
    ],
    [`cd ${directory} && git status`, { additionalBlockedPaths: ["^" + directory + "$"] }],
    [
      `git -C ${directory} fetch origin main`,
      { additionalDangerousBashPatterns: ["fetch origin main"] },
    ],
  ] satisfies [string, Parameters<typeof createCredentialGuard>[0]][])(
    "keeps configured directory and command policies active: %s",
    (command, config) => {
      expect(() =>
        createCredentialGuard(config).handleToolExecuteBefore(
          { tool: "Bash" },
          { args: { command } },
        ),
      ).toThrow();
    },
  );
});

// Hook inputs only: these shell commands are never executed.
describe("bounded Herdr literal navigation", () => {
  const guard = createCredentialGuard();
  const prompt =
    'herdr agent prompt worker-driver "[deploy] Please review the fix and send the verdict."';
  const search =
    'git grep -n -E "Error|Failed|Fail\\(|Issues" -- src/domain/Item.cs src/domain/Batch.cs | head -30';
  const compose = (suffix: string) => `${prompt} 2>&1 | grep -o '"type":"[a-z_]*"'; ${suffix}`;

  it.each([
    compose(`cd /tmp/worktrees/project/rehearsal && ${search}`),
    compose(`cd -- /tmp/worktrees/project && ${search}`),
    compose(`cd ../project && ${search}`),
    compose(`cd './project directory' && ${search}`),
    compose(`cd project && echo note && ${search}`),
    `cd /tmp/worktrees/project && ${prompt} && ${search}`,
    compose(`command -- cd project && ${search}`),
    compose(`cd project && rtk proxy ${search}`),
    compose("git -C /tmp/worktrees/project grep -n error -- src/index.ts | head -3"),
    compose("git -C ../project -C ./subdir grep -n error -- src/index.ts"),
    compose("git -C ./project status --short | head -3"),
    compose("git -C ./project rev-parse HEAD"),
    compose("git -C ./project rev-list --count HEAD"),
    compose("git rev-parse HEAD"),
    compose('cd project && git grep -n ".env" -- README.md'),
    compose("cd project && git grep -e printenv -- README.md"),
    compose("cd project && cat README.md"),
    compose("git status || echo unavailable"),
    compose("echo note | git status --short"),
    compose("git -C /tmp/private status; cat config"),
    compose("cd project && cat README.md > /tmp/report.txt"),
  ])("allows literal navigation and passive inspection: %s", (command) => {
    expect(guard.isDangerousBashCommand(command)).toBe(false);
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  });

  it.each([
    compose('cd "$HOME" && git status'),
    compose('cd "$UNKNOWN" && git status'),
    compose("cd $(cat .env) && git status"),
    compose("cd `cat .env` && git status"),
    compose("cd ~/project && git status"),
    compose("cd - && git status"),
    compose("cd && git status"),
    compose('cd "" && git status'),
    compose("cd -P project && git status"),
    compose("cd -L project && git status"),
    compose("cd -- project extra && git status"),
    compose("cd project || git status"),
    compose(`cd .; ${search}`),
    compose(`cd project\n${search}`),
    `cd /tmp/worktrees/project && ${prompt}; ${search}`,
    compose("cd /proc/self && cd /tmp/nonexistent; cat environ"),
    compose("cd /proc/self && cd /tmp/nonexistent && cat environ"),
    compose("cd /proc/self && head < environ"),
    compose("cd /proc/self && cat README.md < environ"),
    compose("cd project && echo hi > config"),
    compose("cd project && cat README.md >> config"),
    compose("cd project < config && cat README.md"),
    compose("git -C project status < config"),
    compose("cd /proc/self && head; echo safe"),
    compose("cd /tmp/project && echo safe; cat README.md"),
    compose("cd project & git status"),
    compose("cd project | git grep value"),
    compose("echo project | cd project"),
    compose("(cd project) && git status"),
    compose("cd\u00a0project && git status"),
    compose("PATH=/tmp cd project && git status"),
    compose("env CDPATH=/tmp cd project && git status"),
    compose("export CDPATH=/tmp; cd project && git status"),
    compose("cd project && git grep value | sh"),
    compose("cd project && git grep value | xargs"),
    compose("cd project && git grep value | opaque-runner"),
    compose("cd project && git grep -Oprintenv value"),
    compose("cd project && git grep --open-files-in-pager=printenv value"),
    compose("cd project && git grep --textconv value"),
    compose("cd project && cat .env"),
    compose("cd project && git grep value -- .env"),
    compose("cd project && git grep -f .env"),
    compose("cd project && git grep -e value -- config/.env.local"),
    compose("cd project && git grep value -- /proc/self/environ"),
    compose("cd project && git grep value -- ~/.aws/credentials"),
    compose("cd project && git grep value -- src/index.ts > .env"),
    compose("cd /tmp/dev/.aws && cat config"),
    compose("cd /tmp/dev/.ssh && git grep value -- config"),
    compose("cd /tmp/secrets && cat notes.txt"),
    compose("cd /proc/self && cat environ"),
    compose("cd /proc && cat self/environ"),
    compose('git -C "$UNKNOWN" status'),
    compose("git -C ~/project status"),
    compose('git -C "" status'),
    compose("git -C -x status"),
    compose("git -c core.pager=printenv status"),
    compose("git -C project grep -Oprintenv value"),
    compose("git -C project grep value -- .env"),
    compose("git -C /tmp/dev/.aws grep value -- config"),
    compose("git -C project -C /tmp/dev/.ssh status"),
    compose("git -C project grep value | sh"),
    compose("git -C project checkout main"),
    compose("cd project && printenv"),
  ])("refuses unproved or sensitive navigation: %s", (command) => {
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
  });

  it.each([
    [
      compose("cd /tmp/private-worktree && git status"),
      { additionalBlockedPaths: ["^/tmp/private-worktree$"] },
    ],
    [
      compose("git -C /tmp/private-worktree status"),
      { additionalBlockedPaths: ["^/tmp/private-worktree/$"] },
    ],
    [
      compose("cd project && git grep value -- private.dat"),
      { additionalBlockedPaths: ["^private[.]dat$"] },
    ],
    [
      compose("git -C project grep value -- private.dat"),
      { additionalBlockedPaths: ["^private[.]dat$"] },
    ],
    [
      compose("cd /tmp/project && git grep value -- private.dat"),
      { additionalBlockedPaths: ["^/tmp/project/private[.]dat$"] },
    ],
    [
      compose("git -C /tmp/project grep value -- private.dat"),
      { additionalBlockedPaths: ["^/tmp/project/private[.]dat$"] },
    ],
    [
      compose("cd /tmp/private && cd ../public; cat config"),
      { additionalBlockedPaths: ["^/tmp/private/config$"] },
    ],
    [
      compose("cd /tmp/private && echo hi > config"),
      { additionalBlockedPaths: ["^/tmp/private/config$"] },
    ],
    [compose("cd project && git status"), { additionalDangerousBashPatterns: ["cd project"] }],
  ] satisfies [string, Parameters<typeof createCredentialGuard>[0]][])(
    "keeps configured directory, reader and command policies: %s",
    (command, config) => {
      expect(() =>
        createCredentialGuard(config).handleToolExecuteBefore(
          { tool: "Bash" },
          { args: { command } },
        ),
      ).toThrow();
    },
  );
});

// Hook inputs only: these shell commands are never executed.
describe("bounded local literal path assignments", () => {
  const guard = createCredentialGuard();
  it.each([
    "F=/tmp/x; grep -o -E 'a{,5}' $F",
    "F=/tmp/x; grep -o -E 'a{2,}' $F",
    'cd /tmp && A=docs/report.md && shasum -a 256 "$A" | grep -q hash',
    'cd /tmp && B=docs/report.md && sha256sum "${B}" | head',
    'cd /tmp && Z=docs && cat "$Z/report.md" && wc -c "$Z/report.md"',
    'cd /tmp; C=README.md; shasum -a 256 "$C"',
    'D=README.md && sha512sum "$D"',
    'E=README.md; md5sum "$E"',
    'F=README.md\ncksum "$F"',
    'G=docs; cat "$G/a.md"; head -1 "$G/b.md"',
    'H=docs/report.md; rtk proxy shasum -a 256 "$H"',
    'I=docs/report.md; command shasum -a 256 "$I"',
    'J=README.md; shasum -a256 "$J"; git status --short',
    "K=README.md; cat \"$K\" | python3 -c 'import json,sys; print(json.load(sys.stdin))'",
    "L=README.md; shasum \"$L\"; printf '%s\\n' '$L'",
    'M=README.md; shasum "$M"; python3 -c \'print("$M")\'',
    'cd /tmp && T=src && git add -- "$T/a.ts" && git commit -m update',
    'cd /tmp && A=docs/report.md && shasum -a 256 "$A" | grep -q \'^abc \' && bun run gh-tool pr review-triage --pr 42 --format json 2>/dev/null | python3 -c \'\nimport json,sys\nd=json.loads(sys.stdin.read().split("\\n",1)[1] if sys.stdin else "")\n\' 2>/dev/null; bun run gh-tool pr review-triage --pr 42 2>&1 | grep -E "headSha|threadId|isResolved|replyCount|commentId" | head',
  ])("proves local file operands: %s", (command) => {
    expect(guard.isDangerousBashCommand(command)).toBe(false);
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  });

  it.each([
    'cd /missing && A=README.md; shasum "$A"',
    'cd /missing && A=README.md\nshasum "$A"',
    'cd /missing && A=README.md && shasum "$A"; cat "$A"',
    'cd /missing && A=README.md && shasum "$A"\ncat "$A"',
    'cd /missing || A=README.md && shasum "$A"',
    'A=README.md || shasum "$A"',
    'A=README.md & shasum "$A"',
    'A=README.md | shasum "$A"',
    '(A=README.md); shasum "$A"',
    'A=README.md; A=.env; shasum "$A"',
    'A=README.md; read A; shasum "$A"',
    'A=README.md; unset A; shasum "$A"',
    'A=README.md; export A=.env; shasum "$A"',
    'A=README.md; printf -v A .en%s v; shasum "$A"',
    "A=README.md; eval 'A=.env'; shasum \"$A\"",
    'A=README.md; . ./setup.sh; shasum "$A"',
    'A="$TOKEN"; shasum "$A"',
    'A=$(printenv TOKEN); shasum "$A"',
    'A=printenv; "$A" TOKEN',
    'A=printenv; command "$A" TOKEN',
    'A=printenv; rtk proxy "$A" TOKEN',
    'A=README.md; shasum "--$A"',
    'A=check; shasum "--$A" README.md',
    'A=README.md; shasum --check "$A"',
    'A=README.md; sha256sum -c "$A"',
    'A=README.md; rg --pre "$A" pattern src',
    'A=README.md; sort --compress-program="$A" input.txt',
    'A=README.md; python3 -c "print(\\"$A\\")"',
    "A=README.md; sh -c 'cat \"$A\"'",
    'A=README.md; cat "$A" | sh',
    'A=README.md; shasum "$A"; echo "$TOKEN"',
    "A=README.md; shasum \"$A\"; python3 -c 'import os; print(os.environ)'",
    'A=.env; shasum "$A"',
    'A=README.md; shasum "$A" .env',
    'A=README.md; sort -o "$A" input.txt',
    'A=README.md; sort --files0-from "$A"',
    'A=README.md; sort --files0-f "$A"',
    'A=README.md; wc --files0-from "$A"',
    'cd /tmp && A=README.md && wc --files0-from="$A"',
    'cd /tmp && A=README.md && wc --files0-f "$A"',
    'cd /tmp && A=README.md && rtk proxy wc --files0-from "$A"',
    'A=README.md; cat "$A" | unknown-runner',
    "A=README.md; cat \"$A\"; BASH_ENV=./startup bash -c 'true'",
    "A=README.md; cat \"$A\"; export BASH_ENV=./startup; bash -c 'true'",
    'A=README.md; cat "$A"; source ./startup',
    'A=README.md; cat "$A"; opaque-runner',

    'A=docs; shasum "$A/.env"',
    'A=/proc/self/environ; shasum "$A"',
    'A=README.md; shasum "$A" > .env',
    'A=README.md; shasum "$A"; cat .env',
    'A=README.md; shasum "$A"; gh auth token',
    'PATH=README.md; shasum "$PATH"',
    'IFS=README.md; shasum "$IFS"',
    'BASH_ENV=README.md; shasum "$BASH_ENV"',
    'artifact=README.md; shasum "$artifact"',
    'cd /tmp && A=README.md && shasum\u00a0"$A"',
  ])("refuses unproved or unsafe local bindings: %s", (command) => {
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
  });

  it.each(["\u00a0", "\v", "\f", "\r", "\u2028"])(
    "preserves unsupported shell word whitespace %j around bindings and wrappers",
    (space) => {
      for (const command of [
        `${space}A=README.md; cat "$A"`,
        `${space}A=README.md; shasum "$A"`,
        ` ${space}A=README.md; cat "$A"`,
        `A=README.md${space}; cat "$A"`,
        `${space}sh -c 'A=README.md; cat "$A"'`,
      ]) {
        expect(() =>
          guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
        ).toThrow();
      }
    },
  );

  it("checks every materialized path and both original and materialized command patterns", () => {
    const command = 'cd /tmp && A=docs && shasum "$A/a.md" "$A/b.md"';
    for (const config of [
      { additionalBlockedPaths: ["^docs/b[.]md$"] },
      { additionalDangerousBashPatterns: ["A=docs"] },
      { additionalDangerousBashPatterns: ["docs/a[.]md"] },
    ]) {
      expect(() =>
        createCredentialGuard(config).handleToolExecuteBefore(
          { tool: "Bash" },
          { args: { command } },
        ),
      ).toThrow();
    }
  });
});

// Policy inputs only. Never execute these commands or wait for the represented delay.
describe("literal Herdr agent read and delay composition", () => {
  const guard = createCredentialGuard();
  const prompt = "herdr agent prompt reviewer-a 'Read literal env prose'";
  const read = "herdr agent read reviewer-b --source recent-unwrapped --lines 8";
  const composition = `${prompt} 2>&1 | head -c 300; sleep 20; ${read} | grep -oE 'gpt-[0-9a-z.-]+ (high|xhigh|medium|low)' | head -1`;

  it.each([
    composition,
    `${prompt}; ${read}`,
    `${prompt}; sleep 0; ${read}`,
    `${prompt}; sleep 0.25; ${read}`,
    `${prompt}; sleep 2 2>/dev/null; ${read}`,
    `${prompt}; sleep 2 > /tmp/delay-output; ${read}`,
    `${prompt}; sleep 999999; ${read}`,
    `sleep 2; ${read} | head; ${prompt}`,
    `${prompt}; command -- sleep 2; rtk proxy ${read} | tail -2`,
    `${prompt}; herdr agent read other:agent --source recent-unwrapped --lines 12`,
    "for a in reviewer-a reviewer-b; do herdr agent read $a --source recent-unwrapped --lines 8; done",
  ])("allows literal read/delay roles: %s", (command) => {
    expect(guard.isDangerousBashCommand(command)).toBe(false);
    expect(guard.getBlockedCliTool(command)).toBeNull();
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  });

  it.each([
    `${prompt}; ${read} extra`,
    `${prompt}; ${read} --lines 9`,
    `${prompt}; ${read} --source recent-unwrapped`,
    `${prompt}; ${read} --unknown value`,
    `${prompt}; ${read.replace("recent-unwrapped", "raw")}`,
    `${prompt}; ${read.replace("--lines 8", "--lines 0")}`,
    `${prompt}; ${read.replace("--lines 8", "--lines -1")}`,
    `${prompt}; ${read.replace("--lines 8", "--lines 1.5")}`,
    `${prompt}; ${read.replace("--lines 8", "--lines=8")}`,
    `${prompt}; herdr agent read reviewer-b`,
    `${prompt}; ${read.replace("reviewer-b", "--all")}`,
    `${prompt}; ${read.replace("--source recent-unwrapped --lines 8", "--lines 8 --source recent-unwrapped")}`,
    `${prompt}; ${read} | sh`,
    `${prompt}; ${read} | xargs`,
    `${prompt}; ${read} | opaque-runner`,
    `${prompt}; ${read} > .env`,
    `${prompt}; ${read} < ~/.aws/credentials`,
    `${prompt}; ${read}; opaque-runner`,
    `${prompt}; ${read}; herdr agent message reviewer-b env`,
    `${prompt}; sleep`,
    `${prompt}; sleep -1; ${read}`,
    `${prompt}; sleep 1s; ${read}`,
    `${prompt}; sleep 1 2; ${read}`,
    `${prompt}; sleep 1 --unknown; ${read}`,
    `${prompt}; sleep NaN; ${read}`,
    `${prompt}; sleep Infinity; ${read}`,
    `${prompt}; sleep 1e3; ${read}`,
    `${prompt}; sleep 2 > .env; ${read}`,
    `${prompt}; sleep 2 2> ~/.aws/credentials; ${read}`,
    `${prompt}; sleep 2 < .env; ${read}`,
    "for a in reviewer-a reviewer-b; do herdr agent read reviewer-b --source $a --lines 8; done",
    "for a in 8 9; do herdr agent read reviewer-b --source recent-unwrapped --lines $a; done",
    "for a in reviewer-a; do herdr agent read $a --source recent-unwrapped --lines 8 --lines 9; done",
    `${prompt} | sleep 2; ${read}`,
    `${prompt}; sleep 2 | head; ${read}`,
    `${prompt}; sleep 2 | sh; ${read}`,
    `${prompt}; /tmp/sleep 2; ${read}`,
    `${prompt}; env sleep 2; ${read}`,
    `${prompt}; sleep python3 -c 'print(1)'; ${read}`,
    `${prompt}; sleep 2; ${read} | node -e 'eval(process.stdin)'`,
    `${prompt}; sleep 2; ${read} | bash -c 'printenv'`,
    `${prompt}; sleep 2; ${read} | grep --pre=sh value`,
    `PATH=/tmp ${composition}`,
    `env BASH_ENV=./startup ${composition}`,
    `herdr agent prompt reviewer-a "$(cat .env)"; sleep 2; ${read}`,
    `herdr agent prompt reviewer-a "$TOKEN"; sleep 2; ${read}`,
    `${prompt}; sleep "$SECONDS"; ${read}`,
    `${prompt}; sleep "$(echo 2)"; ${read}`,
    `${prompt}; ${read.replace("reviewer-b", "$AGENT")}`,
    `${prompt}; ${read.replace("--lines 8", "--lines $LINES")}`,
    `sh -c '${prompt}' extra`,
    `zsh -c '${composition}'`,
    `bash --unknown -c '${composition}'`,
  ])("refuses unproved read/delay roles: %s", (command) => {
    expect(guard.isDangerousBashCommand(command)).toBe(true);
    expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
  });

  it("keeps custom path and command policies active", () => {
    for (const config of [
      { additionalBlockedPaths: ["notes[.]txt"] },
      { additionalDangerousBashPatterns: ["reviewer-b"] },
    ]) {
      expect(() =>
        createCredentialGuard(config).handleToolExecuteBefore(
          { tool: "Bash" },
          { args: { command: `${composition} > notes.txt` } },
        ),
      ).toThrow();
    }
  });

  it("still refuses known wrapper sleep polling", () => {
    for (const command of [
      "sleep 20; bun agent-tools-gh workflow list --limit 4",
      "sleep 20; bun agent-tools-gh pr checks --pr 12",
      "sleep 20; bun agent-tools-k8s kubectl --env test --cmd 'get pods'",
    ]) {
      expect(guard.detectSleepPolling(command)).not.toBeNull();
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      ).toThrow();
    }
  });
});

// Partial reconstruction of the visible excerpt, not evidence of the unseen original script.
// Policy inputs only. Never execute these commands or read the represented compose file.
describe("partial visible Python compose edit reconstruction", () => {
  const guard = createCredentialGuard();
  const heredoc = (program: string) => `python3 - <<'PY'\n${program}\nPY`;
  const body = `p='docker-compose.yml'
s=open(p).read()
s=s.replace("""      - ASPNETCORE_ENVIRONMENT=Production
      - SHARED_FEED_PASSWORD=REDACTED
""", """      - ASPNETCORE_ENVIRONMENT=Development
      - SHARED_FEED_PASSWORD=REDACTED
""")
open(p,'w').write(s)`;

  it.each([
    { name: "anonymous visible compose edit", command: heredoc(body), allowed: true },
    {
      name: "literal environment names in replacement text",
      command: heredoc(body.replaceAll("REDACTED", "REDACTED_ENV_TEXT")),
      allowed: true,
    },
    {
      name: "literal sensitive-looking replacement text",
      command: heredoc(body.replaceAll("REDACTED", ".env")),
      allowed: true,
    },
    {
      name: "protected env read and write",
      command: heredoc(body.replace("docker-compose.yml", ".env")),
      allowed: false,
    },
    {
      name: "protected credentials read and write",
      command: heredoc(body.replace("docker-compose.yml", "/workspace/.aws/credentials")),
      allowed: false,
    },
    {
      name: "additional protected read",
      command: heredoc(body + "\nprint(open('.env').read())"),
      allowed: false,
    },
    {
      name: "additional protected write",
      command: heredoc(body + "\nopen('.env','w').write('REDACTED')"),
      allowed: false,
    },
    {
      name: "environment inventory",
      command: heredoc(body + "\nimport os\nprint(os.environ)"),
      allowed: false,
    },
    {
      name: "environment lookup",
      command: heredoc(body + "\nimport os\nprint(os.getenv('TOKEN'))"),
      allowed: false,
    },
    {
      name: "subprocess shell execution",
      command: heredoc(body + "\nimport subprocess\nsubprocess.run(['sh','-c','printenv'])"),
      allowed: false,
    },
    {
      name: "os shell execution",
      command: heredoc(body + "\nimport os\nos.system('printenv')"),
      allowed: false,
    },
    {
      name: "unclosed heredoc",
      command: heredoc(body).slice(0, -3),
      allowed: false,
    },
  ])("$name", ({ command, allowed }) => {
    expect(guard.isDangerousBashCommand(command)).toBe(!allowed);
    const invoke = () => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
    if (allowed) expect(invoke).not.toThrow();
    else expect(invoke).toThrow();
  });
});

// Policy inputs only. Never execute represented shell bodies.
describe("approved metadata shell predicates", () => {
  const quote = (body: string) => "'" + body.replaceAll("'", "'\"'\"'") + "'";
  const prefixes = [
    "sh -c ",
    "bash -c ",
    "/bin/sh -c ",
    "/usr/bin/sh -c ",
    "/bin/bash -c ",
    "/usr/bin/bash -c ",
    "zsh -f -c ",
    "/bin/zsh -f -c ",
    "rtk proxy sh -c ",
    "command -- sh -c ",
  ];
  const guard = createCredentialGuard({
    allowedEnvironmentVariables: ["HERDR_ENV", "EXAMPLE_SESSION_FLAG"],
  });
  const predicate = 'test "${HERDR_ENV:-}" = 1';
  const bodies = [
    predicate,
    '[ "${HERDR_ENV:-}" = "" ]',
    'test -n "$HERDR_ENV"',
    'test -z "${EXAMPLE_SESSION_FLAG:-}"',
  ];
  it.each(bodies.flatMap((body) => [body].concat(prefixes.map((prefix) => prefix + quote(body)))))(
    "allows configured metadata only in proved predicates: %s",
    (command) => {
      expect.soft(guard.isDangerousBashCommand(command)).toBe(false);
      expect
        .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
        .not.toThrow();
    },
  );
  const nested = (count: number) => {
    let body = predicate;
    for (let i = 0; i < count; i++) body = "sh -c " + quote(body);
    return body;
  };
  it.each([2, 3, 8])("keeps existing predicate recursion bound: %s", (count) => {
    const command = nested(count);
    expect.soft(guard.isDangerousBashCommand(command)).toBe(false);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .not.toThrow();
  });
  it.each(prefixes)("refuses default and unapproved names under %s", (prefix) => {
    const command = prefix + quote(predicate);
    expect.soft(createCredentialGuard().isDangerousBashCommand(command)).toBe(true);
    expect
      .soft(() =>
        createCredentialGuard().handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
      )
      .toThrow();
    const unknown = prefix + quote(predicate.replaceAll("HERDR_ENV", "UNKNOWN_METADATA"));
    expect.soft(guard.isDangerousBashCommand(unknown)).toBe(true);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: unknown } }))
      .toThrow();
  });
  it.each(
    [
      "test ${HERDR_ENV:-} = 1",
      'test "${HERDR_ENV:-fallback}" = 1',
      'test "${HERDR_ENV:-$HERDR_ENV}" = 1',
      'test "${HERDR_ENV:-${HERDR_ENV:-}}" = 1',
      'test "${HERDR_ENV:-$(echo fallback)}" = 1',
      'test "$HERDR_ENV" = "$TOKEN"',
      '"${HERDR_ENV:-}" argument',
      'eval "${HERDR_ENV:-}"',
      'sh -c "${HERDR_ENV:-}"',
      'printf "${HERDR_ENV:-}"',
      'printf -v target "%s" "$HERDR_ENV"',
      'cat "${HERDR_ENV:-}"',
      'cd "${HERDR_ENV:-}"',
      'head -n "$HERDR_ENV" README.md',
      'test "${HERDR_ENV:-}" = 1 | sh',
      'test "${HERDR_ENV:-}" = 1 | xargs',
      'test "${HERDR_ENV:-}" = 1 | unknown-runner',
      'test "${HERDR_ENV:-}" = 1 > .env',
      'test "${HERDR_ENV:-}" = 1 > /tmp/output',
      'test "${HERDR_ENV:-}" = 1; cat .env',
      'test "${HERDR_ENV:-}" = 1; opaque-command',
      'HERDR_ENV=1; test "${HERDR_ENV:-}" = 1',
      'LD_PRELOAD=$?; test "${HERDR_ENV:-}" = 1',
      'alias test="cat .env"; test "${HERDR_ENV:-}" = 1',
    ].flatMap((body) => ["sh -c " + quote(body), "rtk proxy /bin/sh -c " + quote(body)]),
  )("refuses unsupported complete bodies and sinks: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .toThrow();
  });
  it.each([
    "sh -lc " + quote(predicate),
    "sh --command " + quote(predicate),
    "sh -c " + quote(predicate) + " extra",
    "zsh -c " + quote(predicate),
    "env sh -c " + quote(predicate),
    "PATH=/tmp sh -c " + quote(predicate),
    "BASH_ENV=/tmp/startup sh -c " + quote(predicate),
    "LD_PRELOAD=/tmp/loader sh -c " + quote(predicate),
    "NODE_OPTIONS=--require=loader sh -c " + quote(predicate),
    nested(9),
    "sh -c " + quote(predicate) + " | sh",
    "sh -c " + quote(predicate) + " < .env",
    "LD_PRELOAD=0; sh -c " + quote(predicate),
    "HERDR_ENV=1; sh -c " + quote(predicate),
    "alias sh='cat .env'; sh -c " + quote(predicate),
    "alias test='cat .env'; sh -c " + quote(predicate),
    "readonly HERDR_ENV=1; sh -c " + quote(predicate),
    "sh -c " + quote(predicate) + " | unknown-runner",
    "sh -c " + quote(predicate) + " | head",
  ])("retains exact shell invocation and outer policy: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .toThrow();
  });
  it.each([
    "builtin export BASH_ENV=/tmp/startup; sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin export BASH_ENV=/tmp/startup\nsh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin export BASH_ENV=/tmp/startup && sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin export BASH_ENV=/tmp/startup || sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin alias sh='cat .env'; sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin alias sh='cat .env'\nsh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin alias sh='cat .env' && sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin alias sh='cat .env' || sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin eval 'export BASH_ENV=/tmp/startup'; sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin eval 'export BASH_ENV=/tmp/startup'\nsh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin eval 'export BASH_ENV=/tmp/startup' && sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin eval 'export BASH_ENV=/tmp/startup' || sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin unset HERDR_ENV; sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin unset HERDR_ENV\nsh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin unset HERDR_ENV && sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "builtin unset HERDR_ENV || sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "command export BASH_ENV=/tmp/startup; sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "command export BASH_ENV=/tmp/startup\nsh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "command export BASH_ENV=/tmp/startup && sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "command export BASH_ENV=/tmp/startup || sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "command -- builtin export BASH_ENV=/tmp/startup; sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "command -- builtin export BASH_ENV=/tmp/startup\nsh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "command -- builtin export BASH_ENV=/tmp/startup && sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "command -- builtin export BASH_ENV=/tmp/startup || sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy builtin unset HERDR_ENV; sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy builtin unset HERDR_ENV\nsh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy builtin unset HERDR_ENV && sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy builtin unset HERDR_ENV || sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "true; sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "true\nsh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "true && sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "true || sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "pwd; sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "pwd\nsh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "pwd && sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "pwd || sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "echo complete; sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "echo complete\nsh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "echo complete && sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "echo complete || sh -c 'test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1'; true",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1'\ntrue",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1' && true",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1' || true",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1';",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1' &",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1' > /tmp/output",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1' 2>&1",
    "sh -c 'true; sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'true\nsh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'true && sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'true || sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1'\"'\"''",
  ])("refuses compound predicate startup contexts: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .toThrow();
  });
  it.each([
    "sh -c 'test\u00a0\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test\u00a0\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test\u00a0\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \u00a0\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test \u00a0\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test \u00a0\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c '\u00a0test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c '\u00a0test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'\u00a0test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'command\u00a0test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'command\u00a0test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'command\u00a0test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\"\u00a0= 1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\"\u00a0= 1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\"\u00a0= 1'\"'\"''",
    "sh -c 'test\u000b\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test\u000b\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test\u000b\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \u000b\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test \u000b\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test \u000b\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c '\u000btest \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c '\u000btest \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'\u000btest \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'command\u000btest \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'command\u000btest \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'command\u000btest \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\"\u000b= 1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\"\u000b= 1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\"\u000b= 1'\"'\"''",
    "sh -c 'test\f\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test\f\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test\f\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \f\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test \f\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test \f\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c '\ftest \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c '\ftest \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'\ftest \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'command\ftest \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'command\ftest \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'command\ftest \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\"\f= 1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\"\f= 1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\"\f= 1'\"'\"''",
    "sh -c 'test\u2003\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test\u2003\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test\u2003\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \u2003\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test \u2003\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test \u2003\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c '\u2003test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c '\u2003test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'\u2003test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'command\u2003test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'command\u2003test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'command\u2003test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\"\u2003= 1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\"\u2003= 1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\"\u2003= 1'\"'\"''",
    "sh -c 'test\r\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test\r\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test\r\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \r\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test \r\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test \r\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c '\rtest \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c '\rtest \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'\rtest \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'command\rtest \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'command\rtest \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'command\rtest \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\"\r= 1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\"\r= 1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\"\r= 1'\"'\"''",
    "sh -c 'test\u1680\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test\u1680\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test\u1680\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \u1680\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test \u1680\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test \u1680\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c '\u1680test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c '\u1680test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'\u1680test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'command\u1680test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'command\u1680test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'command\u1680test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\"\u1680= 1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\"\u1680= 1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\"\u1680= 1'\"'\"''",
    "sh -c 'test\u2028\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test\u2028\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test\u2028\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \u2028\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test \u2028\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test \u2028\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c '\u2028test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c '\u2028test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'\u2028test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'command\u2028test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'command\u2028test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'command\u2028test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\"\u2028= 1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\"\u2028= 1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\"\u2028= 1'\"'\"''",
    "sh -c 'test\u2029\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test\u2029\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test\u2029\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \u2029\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test \u2029\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test \u2029\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c '\u2029test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c '\u2029test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'\u2029test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'command\u2029test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'command\u2029test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'command\u2029test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\"\u2029= 1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\"\u2029= 1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\"\u2029= 1'\"'\"''",
    "sh -c 'test\u202f\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test\u202f\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test\u202f\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \u202f\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test \u202f\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test \u202f\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c '\u202ftest \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c '\u202ftest \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'\u202ftest \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'command\u202ftest \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'command\u202ftest \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'command\u202ftest \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\"\u202f= 1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\"\u202f= 1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\"\u202f= 1'\"'\"''",
    "sh -c 'test\u205f\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test\u205f\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test\u205f\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \u205f\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test \u205f\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test \u205f\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c '\u205ftest \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c '\u205ftest \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'\u205ftest \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'command\u205ftest \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'command\u205ftest \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'command\u205ftest \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\"\u205f= 1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\"\u205f= 1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\"\u205f= 1'\"'\"''",
    "sh -c 'test\u3000\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test\u3000\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test\u3000\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \u3000\"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'test \u3000\"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'test \u3000\"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c '\u3000test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c '\u3000test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'\u3000test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'command\u3000test \"${HERDR_ENV:-}\" = 1'",
    "rtk proxy /bin/sh -c 'command\u3000test \"${HERDR_ENV:-}\" = 1'",
    "sh -c 'sh -c '\"'\"'command\u3000test \"${HERDR_ENV:-}\" = 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\"\u3000= 1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\"\u3000= 1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\"\u3000= 1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1 &'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1 &'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1 &'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1;'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1;'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1;'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1 &&'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1 &&'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1 &&'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1 ||'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1 ||'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1 ||'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1 |'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1 |'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1 |'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1 2>&1'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1 2>&1'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1 2>&1'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1 2>&-'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1 2>&-'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1 2>&-'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1 > /tmp/output'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1 > /tmp/output'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1 > /tmp/output'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1 < /tmp/input'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1 < /tmp/input'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1 < /tmp/input'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1 <<'\"'\"'EOF'\"'\"'\nplain data\nEOF'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1 <<'\"'\"'EOF'\"'\"'\nplain data\nEOF'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1 <<'\"'\"'\"'\"'\"'\"'\"'\"'EOF'\"'\"'\"'\"'\"'\"'\"'\"'\nplain data\nEOF'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1 <<EOF\nplain data\nEOF'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1 <<EOF\nplain data\nEOF'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1 <<EOF\nplain data\nEOF'\"'\"''",
    "sh -c 'test \"${HERDR_ENV:-}\" = 1 # comment'",
    "rtk proxy /bin/sh -c 'test \"${HERDR_ENV:-}\" = 1 # comment'",
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = 1 # comment'\"'\"''",
  ])("refuses unproved original predicate lexical syntax: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .toThrow();
  });
  it.each([
    "sh -c 'test\t\"${HERDR_ENV:-}\"\t=\t1'",
    "rtk proxy /bin/sh -c 'test\t\"${HERDR_ENV:-}\"\t=\t1'",
    "sh -c 'sh -c '\"'\"'test\t\"${HERDR_ENV:-}\"\t=\t1'\"'\"''",
    "sh -c '[\t\"${HERDR_ENV:-}\"\t=\t1\t]'",
    "rtk proxy /bin/sh -c '[\t\"${HERDR_ENV:-}\"\t=\t1\t]'",
    "sh -c 'sh -c '\"'\"'[\t\"${HERDR_ENV:-}\"\t=\t1\t]'\"'\"''",
    'sh -c \'test "${HERDR_ENV:-}" = "1"\'',
    'rtk proxy /bin/sh -c \'test "${HERDR_ENV:-}" = "1"\'',
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = \"1\"'\"'\"''",
    'sh -c \'test "${HERDR_ENV:-}" = ""\'',
    'rtk proxy /bin/sh -c \'test "${HERDR_ENV:-}" = ""\'',
    "sh -c 'sh -c '\"'\"'test \"${HERDR_ENV:-}\" = \"\"'\"'\"''",
    "sh -c '\tcommand -- test \"${HERDR_ENV:-}\" = 1\t'",
    "rtk proxy /bin/sh -c '\tcommand -- test \"${HERDR_ENV:-}\" = 1\t'",
    "sh -c 'sh -c '\"'\"'\tcommand -- test \"${HERDR_ENV:-}\" = 1\t'\"'\"''",
  ])("preserves exact ASCII predicate boundaries: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(false);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .not.toThrow();
  });
  it("preserves configured command and CLI policies", () => {
    const command = "rtk proxy sh -c " + quote(predicate);
    for (const config of [
      { allowedEnvironmentVariables: ["HERDR_ENV"], additionalDangerousBashPatterns: ["^test"] },
      {
        allowedEnvironmentVariables: ["HERDR_ENV"],
        additionalDangerousBashPatterns: ["^rtk proxy sh"],
      },
      {
        allowedEnvironmentVariables: ["HERDR_ENV"],
        additionalBlockedCliTools: [{ tool: "test", suggestion: "approved-predicate" }],
      },
    ])
      expect(() =>
        createCredentialGuard(config).handleToolExecuteBefore(
          { tool: "Bash" },
          { args: { command } },
        ),
      ).toThrow();
  });
});

// Policy input only; represented jq and external shell commands are never executed.
describe("bounded readonly jq projections", () => {
  const guard = createCredentialGuard();
  it.each([
    "rtk shasum -a 256 /private/tmp/example-measurement/run.ts /private/tmp/example-measurement/control.json /private/tmp/example-measurement/evidence.md && rtk cat /private/tmp/example-measurement/control.json | rtk jq '{control,base:.base,changed:.changed,delta,source:.changedInput,closure:.closure,selection:.selection,toolchain:.toolchain,checkpointEligible}'",
    "rtk jq '.graph.projects[] | select(.path|contains(\"Example.Api\")) | {path,runnableTest,projectReferences}' /private/tmp/example-measurement/dimension.json",
    "jq '{control,base:.base,delta}' report.json",
    "jq '.jobs[] | {id,status}' report.json",
    "jq '.items | {id,value:.data}' report.json",
    "jq '.items[] | select(.name | contains(\"example\")) | {name,score:.score}' report.json",
    "jq '{a:.x,b:.y}' report.json",
    "jq '{dependencies, peerDependencies}' report.json",
    "jq '{a: .items | map(.value) | length}' report.json",
    "jq '.a > .b' report.json",
    "jq 'map(select(.status == \"passed\"))' report.json",
    "cat report.json | rtk jq '.jobs[] | {id,status}'",
    "jq -rc -- '{a,base:.base}' report.json",
    "jq '.env' settings.json",
  ])("allows literal data projections: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(false);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .not.toThrow();
  });
  it.each([
    "jq env",
    "jq '$ENV' report.json",
    "jq '{a:env,b:.b}' report.json",
    "jq '{a:$ENV,b:.b}' report.json",
    "jq 'import \"module\" as m; {a,b}' report.json",
    "jq 'include \"module\"; {a,b}' report.json",
    "jq -f /tmp/program '{a,b}' report.json",
    "jq --from-file /tmp/program '{a,b}' report.json",
    "jq -L /tmp/modules '{a,b}' report.json",
    "jq --arg value env '{a,b}' report.json",
    "jq '{a,b}' --from-file /tmp/program",
    "jq '{a,b}' .env",
    "jq '.graph.projects[] | select(.path|contains(\"Example.Api\")) | {path,runnableTest,projectReferences}' ~/.kube/config",
    "jq --rawfile value .env '{a,b}' report.json",
    "jq '.graph.projects[] | select(.path|contains(\"Example.Api\")) | {path,runnableTest,projectReferences}' report.json > .env",
    "rtk proxy bash /private/tmp/example-measurement/run-once.sh",
    "jq '{control,base:.base,changed:.changed,delta,source:.changedInput,closure:.closure,selection:.selection,toolchain:.toolchain,checkpointEligible}' report.json | sh",
    "jq '{control,base:.base,changed:.changed,delta,source:.changedInput,closure:.closure,selection:.selection,toolchain:.toolchain,checkpointEligible}' report.json | xargs",
    "jq '{control,base:.base,changed:.changed,delta,source:.changedInput,closure:.closure,selection:.selection,toolchain:.toolchain,checkpointEligible}' report.json | opaque-consumer",
    "jq '.graph.projects[] | select(.path|contains(\"Example.Api\")) | {path,runnableTest,projectReferences}' report.json | sh",
    "jq '.graph.projects[] | select(.path|contains(\"Example.Api\")) | {path,runnableTest,projectReferences}' report.json | xargs",
    "jq '.graph.projects[] | select(.path|contains(\"Example.Api\")) | {path,runnableTest,projectReferences}' report.json | opaque-consumer",
    "jq '.items[] | select(.name|contains(\"\\(env)\")) | {a,b}' report.json",
    "jq '.items[] | select(.name|contains(env)) | {a,b}' report.json",
    "jq '.items[] | select(.name|contains(\"x\")) | {a,b}; env' report.json",
  ])("refuses executable or sensitive jq roles: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .toThrow();
  });
});

// Policy-only jq consumer compatibility witnesses.
describe("readonly jq consumer chains", () => {
  const guard = createCredentialGuard();
  it.each([
    "jq '{a,b}' report.json | cat",
    "jq '{a,b}' report.json | rtk cat",
    "jq '{a,b}' report.json | sort",
    "jq '{a,b}' report.json | sort -rn",
    "jq '{a,b}' report.json | wc -l",
    "jq '{a,b}' report.json | uniq",
    "jq '{a,b}' report.json | uniq -c",
    "jq '{a,b}' report.json | tr -d '\\r'",
    "jq '{a,b}' report.json | tr 'a-z' 'A-Z'",
    "jq '{a,b}' report.json | cat | sort | uniq -c | wc -l",
    "jq '{a,b}' report.json | sort | cat notes.txt",
    "jq '{a,b}' report.json | cat | rtk jq '{a,b}' | sort | wc -l",
  ])("allows native data consumers: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(false);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .not.toThrow();
  });
  it.each([
    "jq '{a,b}' report.json | sort --compress-program=sh",
    "jq '{a,b}' report.json | sort --compress-program sh",
    "jq '{a,b}' report.json | sort --compress=sh",
    "jq '{a,b}' report.json | sort --comp=sh",
    "jq '{a,b}' report.json | sort --files0-from=.env",
    "jq '{a,b}' report.json | wc --files0-from=.env",
    "jq '{a,b}' report.json | cat .env",
    "jq '{a,b}' report.json | sort .env",
    "jq '{a,b}' report.json | uniq .env",
    "jq '{a,b}' report.json | wc -l .env",
    "jq '{a,b}' report.json | cat > .env",
    "jq '{a,b}' report.json | sort | opaque-consumer",
    "jq '{a,b}' report.json | cat | xargs",
    "jq '{a,b}' report.json | tr a b | sh",
    "jq '{a,b}' report.json | sort | jq env",
    "jq '{a,b}' report.json | sort | jq '$ENV'",
    "jq '{a,b}' report.json | opaque-consumer",
    "bun run db-tool query --sql 'select 1' | cat",
    "bun run db-tool query --sql 'select 1' | sort",
    "bun run db-tool query --sql 'select 1' | wc -l",
  ])("refuses execution and protected consumer paths: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .toThrow();
  });
});

// Policy-only native sort option boundary.
it.each([
  "jq '{a,b}' report.json | sort --files0-from=-",
  "jq '{a,b}' report.json | sort --random-source=/tmp/random",
  "jq '{a,b}' report.json | sort --random-source /tmp/random",
  "jq '{a,b}' report.json | sort --unknown-option",
  "jq '{a,b}' report.json | sort -o /tmp/output",
  "jq '{a,b}' report.json | sort -T /tmp",
])("refuses unproved jq sort consumer options: %s", (command) => {
  const guard = createCredentialGuard();
  expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
  expect
    .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
    .toThrow();
});

// Policy-only bounded nested jq object-map projections.
describe("bounded nested jq object maps", () => {
  const guard = createCredentialGuard();
  it.each([
    "jq '{queueJobId,queueWaitMs,runMs,elapsedMs,startedAt,completedAt,exitCode,accepted,phases:(.phases|map({name,elapsedMs,exitCode}))}' /private/tmp/example-measurement/a.json /private/tmp/example-measurement/b.json /private/tmp/example-measurement/c.json /private/tmp/example-measurement/d.json",
    "rtk jq '{id,items:(.items | map({name,value}))}' report.json",
    "rtk jq '{id,items:.items|map({name,value})}' report.json",
    "rtk jq '{alias:.identity.id,rows:(.data.rows|map({label:.name,value}))}' report.json",
    "rtk jq '{first:(.first|map({id,value})),second:(.second|map({name,score:.score})),tag}' report.json",
    "rtk jq '.groups[] | {id,rows:(.rows | map({name,value}))}' report.json",
    "rtk jq '.groups[] | select(.name|contains(\"example\")) | {id,rows:(.rows | map({name,value}))}' report.json",
    "cat report.json | rtk jq '{id,items:(.items | map({name,value}))}' | sort -rn | uniq -c | wc -l",
    "jq -rc -- '{id,items:(.items | map({name,value}))}' a.json b.json",
  ])("allows static one-level object maps: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(false);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .not.toThrow();
  });
  it.each([
    "jq '{id,items:(.items|map({name,value:env}))}' report.json",
    "jq '{id,items:(.items|map({name,value:$ENV}))}' report.json",
    "jq '{id,items:(.items|map({name,value:\"\\(env)\"}))}' report.json",
    "jq '{id,items:(.items|map({name,value:(include \"module\"; .value)}))}' report.json",
    "jq 'import \"module\" as m; {id,items:(.items | map({name,value}))}' report.json",
    "jq '{id,items:(.items|map({name,items:(.items|map({name,value}))}))}' report.json",
    "jq '{id,items:(.items|map({name,value}))}; env' report.json",
    "jq '{id,items:(.items|map({name,value}))} | env' report.json",
    "jq '{id,items:(.items | map({name,value}))}' a.json b.json .env d.json",
    "jq '{id,items:(.items | map({name,value}))}' ~/.kube/config b.json c.json d.json",
    "jq '{id,items:(.items | map({name,value}))}' a.json b.json c.json ~/.aws/credentials",
    "rtk jq '{id,items:(.items | map({name,value}))}' report.json | xargs",
    "rtk jq '{id,items:(.items | map({name,value}))}' report.json | sh",
    "rtk jq '{id,items:(.items | map({name,value}))}' report.json | opaque-consumer",
    "rtk jq '{id,items:(.items | map({name,value}))}' report.json | sort --compress-program=sh",
    "rtk jq '{id,items:(.items | map({name,value}))}' report.json | sort --files0-from=-",
    "jq '{id,items:(.items | map({name,value}))}' report.json > .env",
    "jq --from-file /tmp/program '{id,items:(.items | map({name,value}))}' report.json",
    "jq --arg value env '{id,items:(.items | map({name,value}))}' report.json",
    "jq --rawfile value .env '{id,items:(.items | map({name,value}))}' report.json",
    "rtk proxy bash /private/tmp/example-measurement/run-once.sh",
  ])("refuses unproved nested map roles: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .toThrow();
  });
});

// Policy-only uniq INPUT/OUTPUT argument-role witnesses.
describe("readonly jq uniq operand roles", () => {
  const guard = createCredentialGuard();
  it.each([
    "jq '{a,b}' r.json | uniq",
    "jq '{a,b}' r.json | uniq -c",
    "jq '{a,b}' r.json | rtk uniq -c",
    "jq '{a,b}' r.json | uniq -",
    "jq '{a,b}' r.json | uniq input.txt",
    "jq '{a,b}' r.json | uniq -ci input.txt",
    "jq '{a,b}' r.json | uniq -f 2 -s3 -w 8 input.txt",
    "jq '{a,b}' r.json | uniq -f2 -s 3 -w8 -",
    "jq '{a,b}' r.json | uniq --skip-fields=2 --skip-chars 3 --check-chars=8 input.txt",
    "jq '{a,b}' r.json | uniq --count --unique -- input.txt",
    "jq '{a,b}' r.json | uniq -- -",
    "jq '{a,b}' r.json | uniq -- -named-input",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -c",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | rtk uniq -c",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq input.txt",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -ci input.txt",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -f 2 -s3 -w 8 input.txt",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -f2 -s 3 -w8 -",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq --skip-fields=2 --skip-chars 3 --check-chars=8 input.txt",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq --count --unique -- input.txt",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -- -",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -- -named-input",
  ])("allows flags and at most one input: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(false);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .not.toThrow();
  });
  it.each([
    "jq '{a,b}' r.json | uniq - package.json",
    "jq '{a,b}' r.json | uniq - ~/.bashrc",
    "jq '{a,b}' r.json | uniq input.txt output.txt",
    "jq '{a,b}' r.json | uniq -c - package.json",
    "jq '{a,b}' r.json | uniq -f 2 - package.json",
    "jq '{a,b}' r.json | uniq -f2 - package.json",
    "jq '{a,b}' r.json | uniq --skip-fields 2 -- - package.json",
    "jq '{a,b}' r.json | uniq --check-chars=8 - package.json",
    "jq '{a,b}' r.json | uniq -- - package.json",
    "jq '{a,b}' r.json | uniq -- input.txt output.txt",
    "jq '{a,b}' r.json | uniq -f package.json",
    "jq '{a,b}' r.json | uniq -s",
    "jq '{a,b}' r.json | uniq --skip-fields=invalid",
    "jq '{a,b}' r.json | uniq --unknown-option",
    "jq '{a,b}' r.json | uniq -x",
    "jq '{a,b}' r.json | uniq input.txt -c",
    "jq '{a,b}' r.json | uniq .env",
    "jq '{a,b}' r.json | uniq -w \"$TOKEN\" -",
    "jq '{a,b}' r.json | uniq - > .env",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq - package.json",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq - ~/.bashrc",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq input.txt output.txt",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -c - package.json",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -f 2 - package.json",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -f2 - package.json",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq --skip-fields 2 -- - package.json",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq --check-chars=8 - package.json",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -- - package.json",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -- input.txt output.txt",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -f package.json",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -s",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq --skip-fields=invalid",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq --unknown-option",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -x",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq input.txt -c",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq .env",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq -w \"$TOKEN\" -",
    "rtk jq '{id,rows:(.rows|map({name,value}))}' r.json | uniq - > .env",
  ])("refuses output operands and unproved flags: %s", (command) => {
    expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
    expect
      .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
      .toThrow();
  });
});

// Policy-only explicit empty numeric option values.
it.each([
  "jq '{a,b}' r.json | uniq --skip-fields= 0 input.txt",
  "jq '{a,b}' r.json | uniq --skip-chars= 0 -",
  "jq '{a,b}' r.json | uniq --check-chars= 0 input.txt",
])("refuses empty attached uniq numeric values: %s", (command) => {
  const guard = createCredentialGuard();
  expect.soft(guard.isDangerousBashCommand(command)).toBe(true);
  expect
    .soft(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }))
    .toThrow();
});
