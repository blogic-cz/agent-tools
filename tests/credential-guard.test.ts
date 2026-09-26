import { describe, expect, it, test } from "vitest";
import corpus from "./fixtures/credential-guard-corpus.json";

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

// eslint-disable-next-line eslint/no-useless-concat -- intentionally split to avoid credential guard self-detection
const GENERIC_SECRET_VALUE = "my-super-" + "secret-password-12345-abcdef";
const CREDENTIAL_GUARD_HOOK_PATH = ".agent/hooks/credential-guard.ts";

describe("credential guard corpus", () => {
  const guard = createCredentialGuard();

  it.each(corpus)("$label: $command", ({ command, label }) => {
    expect(guard.isDangerousBashCommand(command)).toBe(label !== "FP");
  });
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
    "F=/tmp/x; grep -o -E 'a{2,}' $F",
    "F=/tmp/x; grep -o -E 'a{,5}' $F",
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
