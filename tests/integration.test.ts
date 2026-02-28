import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  it("exports handleToolExecuteBefore and detectSecrets", async () => {
    const mod = await import("../src/credential-guard/index");
    expect(typeof mod.handleToolExecuteBefore).toBe("function");
    expect(typeof mod.detectSecrets).toBe("function");
    expect(typeof mod.isPathAllowed).toBe("function");
    expect(typeof mod.createCredentialGuard).toBe("function");
  });

  it("detectSecrets finds AWS keys", async () => {
    const { detectSecrets } = await import("../src/credential-guard/index");
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
