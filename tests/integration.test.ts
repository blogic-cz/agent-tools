import {
  handleToolExecuteBefore,
  detectSecrets,
  isPathAllowed,
  createCredentialGuard,
} from "#guard";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TOOLS_ROOT = join(__dirname, "..");

// Temp dir with valid config for tools that need it
let configDir: string;

beforeAll(() => {
  configDir = join(tmpdir(), `agent-tools-integration-${Date.now()}`);
  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, "agent-tools.json5"),
    JSON.stringify({
      kubernetes: {
        default: {
          clusterId: "test-cluster-id",
          namespaces: { test: "test-ns", prod: "prod-ns" },
        },
      },
      logs: {
        default: {
          localDir: "apps/web-app/logs",
          remotePath: "/app/logs",
        },
      },
      azure: {
        default: {
          organization: "https://dev.azure.com/test-org",
          defaultProject: "test-project",
        },
      },
      database: {
        default: {
          environments: {
            local: { host: "127.0.0.1", port: 5432, user: "test", database: "testdb" },
          },
        },
      },
      session: {
        storagePath: configDir,
      },
    }),
  );
});

afterAll(() => {
  try {
    rmSync(configDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

function runTool(toolPath: string, args: string[], cwd?: string) {
  return spawnSync("bun", ["run", join(TOOLS_ROOT, toolPath), ...args], {
    cwd: cwd ?? TOOLS_ROOT,
    encoding: "utf8",
    timeout: 15000,
  });
}

function runToolWithEnv(
  toolPath: string,
  args: string[],
  cwd: string,
  envOverrides: Record<string, string>,
) {
  return spawnSync("bun", ["run", join(TOOLS_ROOT, toolPath), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
}

describe("Integration: tool --help in zero-config mode", () => {
  it("gh-tool --help works without config file", () => {
    const result = runTool("src/gh-tool/index.ts", ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GitHub");
  });
});

describe("Integration: tools --help with config file", () => {
  it("k8s-tool --help exits 0 with config", () => {
    const result = runTool("src/k8s-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Kubernetes");
  });

  it("az-tool --help exits 0 with config", () => {
    const result = runTool("src/az-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Azure");
  });

  it("db-tool --help exits 0 with config", () => {
    const result = runTool("src/db-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Database");
  });

  it("logs-tool --help exits 0 with config", () => {
    const result = runTool("src/logs-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Logs");
  });

  it("session-tool --help exits 0 with config", () => {
    const result = runTool("src/session-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("session");
  });
});

describe("Integration: credential-guard import", () => {
  it("exports handleToolExecuteBefore and detectSecrets", () => {
    expect(typeof handleToolExecuteBefore).toBe("function");
    expect(typeof detectSecrets).toBe("function");
    expect(typeof isPathAllowed).toBe("function");
    expect(typeof createCredentialGuard).toBe("function");
  });

  it("detectSecrets finds AWS keys", () => {
    // eslint-disable-next-line eslint/no-useless-concat -- intentionally split to avoid credential guard self-detection
    const fakeKey = "AKIA" + "IOSFODNN7EXAMPLE";
    const found = detectSecrets(fakeKey);
    expect(found).toBeDefined();
    expect(found?.name).toContain("AWS");
  });
});

describe.skip("Integration: config loader (Bun-only, skipped in Vitest/Node)", () => {
  it("loadConfig returns undefined when no config file", async () => {
    // loadConfig uses Bun.file() — only works in Bun runtime, not Node/Vitest
    // Covered by CLI subprocess tests above (tools call loadConfig internally)
  });
});

describe("Integration: env safety + k8s namespace fallback", () => {
  let prodDefaultDir: string;

  beforeAll(() => {
    prodDefaultDir = join(tmpdir(), `agent-tools-prod-default-${Date.now()}`);
    mkdirSync(prodDefaultDir, { recursive: true });

    writeFileSync(
      join(prodDefaultDir, "agent-tools.json5"),
      JSON.stringify({
        defaultEnvironment: "prod",
        kubernetes: {
          default: {
            clusterId: "prod-cluster-id",
            namespaces: { test: "test-ns", prod: "prod-ns" },
          },
        },
        logs: {
          default: {
            localDir: "apps/web-app/logs",
            remotePath: "/app/logs",
          },
        },
        database: {
          default: {
            environments: {
              prod: { host: "127.0.0.1", port: 5432, user: "db", database: "prod" },
            },
          },
        },
      }),
    );
  });

  afterAll(() => {
    rmSync(prodDefaultDir, { recursive: true, force: true });
  });

  it("blocks implicit prod in db-tool unless --env prod is explicit", () => {
    const result = runTool(
      "src/db-tool/index.ts",
      ["sql", "--sql", "SELECT 1", "--format", "json"],
      prodDefaultDir,
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("Implicit prod access blocked");
    expect(output).toContain("--env prod");
  });

  it("blocks implicit prod in logs-tool unless --env prod is explicit", () => {
    const result = runTool("src/logs-tool/index.ts", ["list", "--format", "json"], prodDefaultDir);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("Implicit prod access blocked");
    expect(output).toContain("--env prod");
  });

  it("blocks implicit prod in k8s-tool unless --env prod is explicit", () => {
    const result = runTool(
      "src/k8s-tool/index.ts",
      ["pods", "--format", "json", "--dry-run"],
      prodDefaultDir,
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("Implicit prod access blocked");
    expect(output).toContain("--env prod");
  });

  it("k8s structured pods uses namespace from env mapping when --namespace is omitted", () => {
    const k8sDir = join(tmpdir(), `agent-tools-k8s-fallback-${Date.now()}`);
    const binDir = join(k8sDir, "bin");

    mkdirSync(binDir, { recursive: true });

    writeFileSync(
      join(k8sDir, "agent-tools.json5"),
      JSON.stringify({
        defaultEnvironment: "test",
        kubernetes: {
          default: {
            clusterId: "test-cluster-id",
            namespaces: { test: "mapped-test-ns", prod: "mapped-prod-ns" },
          },
        },
      }),
    );

    const kubectlPath = join(binDir, "kubectl");
    writeFileSync(
      kubectlPath,
      '#!/bin/sh\nif [ "$1" = "config" ] && [ "$2" = "view" ]; then\n  echo \'{"contexts":[{"name":"ctx-test","context":{"cluster":"test-cluster-id"}}],"clusters":[{"name":"test-cluster-id","cluster":{"server":"https://test"}}]}\'\n  exit 0\nfi\necho "kubectl-mock"\n',
    );
    chmodSync(kubectlPath, 0o755);

    const jqPath = join(binDir, "jq");
    writeFileSync(jqPath, "#!/bin/sh\necho ctx-test\n");
    chmodSync(jqPath, 0o755);

    const result = runToolWithEnv(
      "src/k8s-tool/index.ts",
      ["pods", "--env", "test", "--dry-run", "--format", "json"],
      k8sDir,
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    rmSync(k8sDir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as { command: string };
    expect(parsed.command).toContain("get pods");
    expect(parsed.command).toContain("-n mapped-test-ns");
  });
});
