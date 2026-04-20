import {
  handleToolExecuteBefore,
  detectSecrets,
  isPathAllowed,
  createCredentialGuard,
} from "#guard";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { Readable } from "node:stream";

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

function runTool(toolPath: string, args: string[], cwd?: string, timeout = 15000) {
  return spawnSync("bun", ["run", join(TOOLS_ROOT, toolPath), ...args], {
    cwd: cwd ?? TOOLS_ROOT,
    encoding: "utf8",
    timeout,
  });
}

function runToolWithEnv(
  toolPath: string,
  args: string[],
  cwd: string,
  envOverrides: Record<string, string>,
  timeout = 15000,
) {
  return spawnSync("bun", ["run", join(TOOLS_ROOT, toolPath), ...args], {
    cwd,
    encoding: "utf8",
    timeout,
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
}

function readAuditRows(dbPath: string, limit: number) {
  const result = spawnSync(
    "bun",
    [
      "-e",
      `
import { Database } from "bun:sqlite";

const db = new Database(process.env.DB_PATH, { strict: true });
const rows = db.query("SELECT tool, project, args, success FROM audit_log ORDER BY id DESC LIMIT ?").all(Number(process.env.LIMIT ?? "1"));
db.close(false);
console.log(JSON.stringify(rows));
      `.trim(),
    ],
    {
      cwd: TOOLS_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        DB_PATH: dbPath,
        LIMIT: String(limit),
      },
    },
  );

  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim()) as Array<{
    tool: string;
    project: string;
    args: string;
    success: number;
  }>;
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

  it("session-tool list creates an audit row in an isolated HOME", () => {
    const homeDir = join(tmpdir(), `agent-tools-audit-home-${Date.now()}`);
    const workDir = join(tmpdir(), `agent-tools-audit-work-${Date.now()}`);
    const auditDbPath = join(homeDir, ".agent-tools", "audit.sqlite");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(workDir, "message"), { recursive: true });
    mkdirSync(join(workDir, "session"), { recursive: true });

    writeFileSync(
      join(workDir, "agent-tools.json5"),
      JSON.stringify({
        session: {
          storagePath: workDir,
        },
      }),
    );

    const result = runToolWithEnv(
      "src/session-tool/index.ts",
      ["list", "--format", "json"],
      workDir,
      { HOME: homeDir },
    );

    expect(result.status).toBe(0);
    expect(existsSync(auditDbPath)).toBe(true);

    const rows = readAuditRows(auditDbPath, 1);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool).toBe("session");
    expect(rows[0]?.project).toBe(realpathSync(workDir));
    expect(rows[0]?.args).toContain("list");
    expect(rows[0]?.success).toBe(1);

    const auditResult = runToolWithEnv(
      "src/audit-tool/index.ts",
      ["list", "--limit", "1", "--project", realpathSync(workDir), "--format", "json"],
      workDir,
      { HOME: homeDir },
    );
    const parsedAuditResult = JSON.parse(auditResult.stdout.trim()) as {
      success: boolean;
      data?: Array<{ tool: string }>;
    };

    expect(auditResult.status).toBe(0);
    expect(parsedAuditResult.success).toBe(true);
    expect(parsedAuditResult.data?.[0]?.tool).toBe("session");

    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it("grafana-tool commands work with config and create audit rows", async () => {
    const homeDir = join(tmpdir(), `agent-tools-grafana-home-${Date.now()}`);
    const workDir = join(tmpdir(), `agent-tools-grafana-work-${Date.now()}`);
    const auditDbPath = join(homeDir, ".agent-tools", "audit.sqlite");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    let server: ReturnType<typeof spawn> | undefined;
    const serverUrl = await new Promise<string>((resolve, reject) => {
      server = spawn(
        "bun",
        [
          "-e",
          `import { createServer } from "node:http";
const server = createServer((req, res) => {
  if (req.url === "/api/health") {
    const body = JSON.stringify({ database: "ok", version: "1.0.0", commit: "test" });
    res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
    res.end(body);
    return;
  }
  if (req.url?.startsWith("/api/search")) {
    const body = JSON.stringify([{ id: 1, uid: "dash-1", title: "Mock Dashboard", url: "/d/dash-1/mock-dashboard", type: "dash-db", tags: ["test"], folderTitle: "Test Folder" }]);
    res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
    res.end(body);
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "not found" }));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    process.exit(1);
  }
  process.stdout.write(String(address.port));
});
setInterval(() => {}, 1000);`,
        ],
        {
          cwd: TOOLS_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stderr = "";
      server?.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const stdout = server?.stdout as Readable | undefined;
      stdout?.once("data", (chunk) => {
        resolve(`http://127.0.0.1:${chunk.toString().trim()}`);
      });

      server?.once("exit", (code) => {
        reject(new Error(`Mock Grafana server exited early with code ${code}: ${stderr}`));
      });
    });

    writeFileSync(
      join(workDir, "agent-tools.json5"),
      JSON.stringify({
        grafana: {
          default: {
            environments: {
              local: {
                url: serverUrl,
                prometheusUid: "prometheus",
                lokiUid: "loki",
              },
            },
          },
        },
      }),
    );

    const healthResult = runToolWithEnv(
      "src/grafana-tool/index.ts",
      ["health", "--format", "json"],
      workDir,
      { HOME: homeDir },
      30000,
    );
    expect(healthResult.status).toBe(0);
    expect(JSON.parse(healthResult.stdout.trim())).toMatchObject({ success: true });

    const dashboardsResult = runToolWithEnv(
      "src/grafana-tool/index.ts",
      ["dashboards", "list", "--format", "json"],
      workDir,
      { HOME: homeDir },
      30000,
    );
    expect(dashboardsResult.status).toBe(0);
    expect(JSON.parse(dashboardsResult.stdout.trim())).toMatchObject({
      success: true,
      data: { count: 1 },
    });

    expect(existsSync(auditDbPath)).toBe(true);
    const rows = readAuditRows(auditDbPath, 2);
    expect(rows[0]?.tool).toBe("grafana");
    expect(rows[1]?.tool).toBe("grafana");
    expect(rows[0]?.project).toBe(realpathSync(workDir));

    server?.kill("SIGTERM");
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }, 35000);
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

  it("db-tool opens a tunnel for remote envs that use localhost forwarded ports", () => {
    const dbDir = join(tmpdir(), `agent-tools-db-tunnel-${Date.now()}`);
    const binDir = join(dbDir, "bin");
    const tunnelReadyPath = join(dbDir, "tunnel-ready");
    const kubectlArgsPath = join(dbDir, "kubectl-args.txt");
    const psqlArgsPath = join(dbDir, "psql-args.txt");

    mkdirSync(binDir, { recursive: true });

    writeFileSync(
      join(dbDir, "agent-tools.json5"),
      JSON.stringify({
        database: {
          default: {
            environments: {
              local: {
                host: "127.0.0.1",
                port: 25538,
                user: "local-user",
                database: "local-db",
              },
              test: {
                host: "127.0.0.1",
                port: 25437,
                user: "readonly-user",
                database: "app-test",
                passwordEnvVar: "TEST_DB_PASSWORD",
              },
            },
            kubectl: {
              context: "cloud2-example-cz",
              namespace: "bl-system",
            },
            remotePort: 5432,
            tunnelTimeoutMs: 1000,
          },
        },
      }),
    );

    const kubectlPath = join(binDir, "kubectl");
    writeFileSync(
      kubectlPath,
      `#!/bin/sh
printf '%s' "$*" > "${kubectlArgsPath}"
touch "${tunnelReadyPath}"
trap 'exit 0' TERM INT
while true; do
  sleep 1
done
`,
    );
    chmodSync(kubectlPath, 0o755);

    const ncPath = join(binDir, "nc");
    writeFileSync(
      ncPath,
      `#!/bin/sh
if [ -f "${tunnelReadyPath}" ]; then
  exit 0
fi
exit 1
`,
    );
    chmodSync(ncPath, 0o755);

    const psqlPath = join(binDir, "psql");
    writeFileSync(
      psqlPath,
      `#!/bin/sh
printf '%s' "$*" > "${psqlArgsPath}"
printf '[{"ok":1}]\n'
`,
    );
    chmodSync(psqlPath, 0o755);

    const result = runToolWithEnv(
      "src/db-tool/index.ts",
      ["sql", "--env", "test", "--sql", "select 1 as ok", "--format", "json"],
      dbDir,
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TEST_DB_PASSWORD: "secret",
      },
    );

    const parsed = JSON.parse(result.stdout.trim()) as {
      success: boolean;
      data?: Array<{ ok: number }>;
    };
    const kubectlArgs = readFileSync(kubectlArgsPath, "utf8");
    const psqlArgs = readFileSync(psqlArgsPath, "utf8");

    rmSync(dbDir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual([{ ok: 1 }]);
    expect(kubectlArgs).toContain(
      "port-forward --context cloud2-example-cz --namespace bl-system svc/postgresql 25437:5432",
    );
    expect(psqlArgs).toContain("-h 127.0.0.1 -p 25437 -U readonly-user -d app-test");
  });
});
