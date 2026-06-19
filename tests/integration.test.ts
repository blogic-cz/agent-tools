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
import { Readable } from "node:stream";

const TOOLS_ROOT = join(__dirname, "..");

if (!("Bun" in globalThis)) {
  const spawnForNodeVitest = ((
    cmd: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin?: "ignore";
      stdout?: "ignore";
      stderr?: "pipe" | "ignore";
    },
  ) => {
    const child = spawn(cmd[0] ?? "", cmd.slice(1), {
      cwd: options?.cwd,
      env: options?.env as NodeJS.ProcessEnv | undefined,
      stdio: [options?.stdin ?? "ignore", options?.stdout ?? "ignore", options?.stderr ?? "pipe"],
    });

    return {
      stderr: child.stderr ? Readable.toWeb(child.stderr) : null,
      exited: new Promise<number>((resolve) => {
        child.once("exit", (code) => resolve(code ?? 0));
      }),
      kill: () => {
        child.kill();
      },
    } as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;

  Object.defineProperty(globalThis, "Bun", {
    configurable: true,
    value: { spawn: spawnForNodeVitest },
  });
}

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

  it("observability-tool --help exits 0 with config", () => {
    const result = runTool("src/observability-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LGTM");
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

  it("session-tool list returns one row per session", () => {
    const homeDir = join(tmpdir(), `agent-tools-session-home-${Date.now()}`);
    const workDir = join(tmpdir(), `agent-tools-session-work-${Date.now()}`);
    const sessionDir = join(workDir, "message", "ses_test");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(workDir, "session"), { recursive: true });

    writeFileSync(
      join(workDir, "agent-tools.json5"),
      JSON.stringify({
        session: {
          storagePath: workDir,
        },
      }),
    );
    writeFileSync(
      join(sessionDir, "one.json"),
      JSON.stringify({
        id: "one",
        sessionID: "ses_test",
        role: "assistant",
        summary: { title: "Older", body: "" },
        time: { created: 1 },
      }),
    );
    writeFileSync(
      join(sessionDir, "two.json"),
      JSON.stringify({
        id: "two",
        sessionID: "ses_test",
        role: "assistant",
        summary: { title: "Newest", body: "" },
        time: { created: 2 },
      }),
    );

    const result = runToolWithEnv(
      "src/session-tool/index.ts",
      ["list", "--all", "--source", "opencode", "--format", "json"],
      workDir,
      { HOME: homeDir },
    );
    const parsed = JSON.parse(result.stdout.trim()) as {
      data?: { results?: Array<{ sessionID: string; title: string }> };
    };

    expect(result.status).toBe(0);
    expect(parsed.data?.results).toHaveLength(1);
    expect(parsed.data?.results?.[0]?.sessionID).toBe("ses_test");
    expect(parsed.data?.results?.[0]?.title).toBe("Newest");

    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it("observability-tool commands work with config and create audit rows", async () => {
    const homeDir = join(tmpdir(), `agent-tools-observability-home-${Date.now()}`);
    const workDir = join(tmpdir(), `agent-tools-observability-work-${Date.now()}`);
    const auditDbPath = join(homeDir, ".agent-tools", "audit.sqlite");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    let stopServer: (() => void) | undefined;
    const serverUrl = await new Promise<string>((resolve, reject) => {
      const server = spawn(
        "bun",
        [
          "-e",
          `import { createServer } from "node:http";
const server = createServer((req, res) => {
  if (req.url === "/api/datasources") {
    const body = JSON.stringify([
      { id: 1, uid: "prometheus", name: "Prometheus", type: "prometheus", url: "http://prometheus:9090" },
      { id: 2, uid: "loki", name: "Loki", type: "loki", url: "http://loki:3100" },
      { id: 3, uid: "tempo", name: "Tempo", type: "tempo", url: "http://tempo:3200" }
    ]);
    res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
    res.end(body);
    return;
  }
  if (req.url?.startsWith("/api/datasources/proxy/uid/tempo/api/traces/0b7bdf0dde1c55458364ba5588a8075e")) {
    const body = JSON.stringify({
      batches: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "mock-service" } },
            { key: "deployment.environment.name", value: { stringValue: "local" } }
          ]
        },
        scopeSpans: [{
          scope: { name: "mock-scope" },
          spans: [
            {
              traceId: "C3vfDd4cVUWDZLpViKgHXg==",
              spanId: "S0N7+zAcy2E=",
              name: "GET /health",
              kind: "SPAN_KIND_SERVER",
              startTimeUnixNano: "1000000000",
              endTimeUnixNano: "2000000000",
              status: { code: "STATUS_CODE_OK" },
              attributes: [{ key: "http.request.method", value: { stringValue: "GET" } }]
            },
            {
              traceId: "C3vfDd4cVUWDZLpViKgHXg==",
              spanId: "lpm/1p/QGE0=",
              parentSpanId: "S0N7+zAcy2E=",
              name: "select 1",
              kind: "SPAN_KIND_CLIENT",
              startTimeUnixNano: "1200000000",
              endTimeUnixNano: "1500000000",
              status: { code: "STATUS_CODE_OK" },
              attributes: [{ key: "db.system", value: { stringValue: "postgresql" } }]
            }
          ]
        }]
      }]
    });
    res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
    res.end(body);
    return;
  }
  if (req.url === "/api/ds/query" && req.method === "POST") {
    let raw = "";
    req.on("data", chunk => { raw += chunk.toString(); });
    req.on("end", () => {
      const payload = JSON.parse(raw);
      const expr = payload?.queries?.[0]?.expr;

      if (expr === '{job=~".+"} |= "0b7bdf0dde1c55458364ba5588a8075e"') {
        const body = JSON.stringify({
          results: {
            A: {
              frames: [{
                schema: {
                  fields: [
                    { name: "timestamp", type: "time" },
                    { name: "line", type: "string" },
                    { name: "labels", type: "string" }
                  ]
                },
                data: {
                  values: [
                    [1710000000000],
                    ['{"level":"info","trace_id":"0b7bdf0dde1c55458364ba5588a8075e"}'],
                    ['{"job":"mock-app"}']
                  ]
                }
              }]
            }
          }
        });
        res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
        res.end(body);
        return;
      }

      if (expr === "up") {
        const body = JSON.stringify({
          results: {
            A: {
              frames: [{
                schema: {
                  fields: [
                    { name: "Time", type: "time" },
                    { name: "Value", type: "number", labels: { job: "tempo", instance: "tempo:3200" } }
                  ]
                },
                data: {
                  values: [
                    [1710000000000, 1710000060000],
                    [1, 1]
                  ]
                }
              }]
            }
          }
        });
        res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
        res.end(body);
        return;
      }

      if (expr === '{job="mock-app"} |= "Nsure"') {
        const body = JSON.stringify({
          results: {
            A: {
              frames: [{
                schema: {
                  fields: [
                    { name: "timestamp", type: "time" },
                    { name: "line", type: "string" },
                    { name: "labels", type: "string" }
                  ]
                },
                data: {
                  values: [
                    [1710000000001],
                    ['{"body":"Nsure import failed","severity":"Error","attributes":{"JobId":"job-1","exception.message":"permission denied"}}'],
                    ['{"job":"mock-app"}']
                  ]
                }
              }]
            }
          }
        });
        res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
        res.end(body);
        return;
      }

      if (expr === '{job="field-label-app"}') {
        const body = JSON.stringify({
          results: {
            A: {
              frames: [{
                schema: {
                  fields: [
                    { name: "timestamp", type: "time" },
                    { name: "line", type: "string", labels: { job: "field-label-app", pod: "pod-1" } }
                  ]
                },
                data: {
                  values: [
                    [1710000000002],
                    ["field labels log"]
                  ]
                }
              }]
            }
          }
        });
        res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
        res.end(body);
        return;
      }

      if (expr === '{job="mixed-label-app"}') {
        const body = JSON.stringify({
          results: {
            A: {
              frames: [{
                schema: {
                  fields: [
                    { name: "timestamp", type: "time" },
                    { name: "line", type: "string", labels: { job: "mixed-label-app", pod: "pod-2" } },
                    { name: "labelTypes", type: "other" }
                  ]
                },
                data: {
                  values: [
                    [1710000000003],
                    ["mixed labels log"],
                    [{ job: "S", pod: "S" }]
                  ]
                }
              }]
            }
          }
        });
        res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
        res.end(body);
        return;
      }

      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "unexpected expr: " + expr }));
    });
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
      stopServer = () => {
        server.kill();
      };

      let stderr = "";
      server.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      server.stdout.once("data", (chunk) => {
        resolve(`http://127.0.0.1:${chunk.toString().trim()}`);
      });

      server.once("exit", (code) => {
        reject(new Error(`Mock Grafana server exited early with code ${code}: ${stderr}`));
      });
    });

    writeFileSync(
      join(workDir, "agent-tools.json5"),
      JSON.stringify({
        observability: {
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

    const traceResult = runToolWithEnv(
      "src/observability-tool/index.ts",
      ["trace", "get", "0b7bdf0dde1c55458364ba5588a8075e", "--format", "json"],
      workDir,
      { HOME: homeDir },
      30000,
    );
    expect(traceResult.status).toBe(0);
    expect(JSON.parse(traceResult.stdout.trim())).toMatchObject({
      success: true,
      data: { summary: { spanCount: 2 } },
    });

    const logsResult = runToolWithEnv(
      "src/observability-tool/index.ts",
      ["trace", "logs", "0b7bdf0dde1c55458364ba5588a8075e", "--format", "json"],
      workDir,
      { HOME: homeDir },
      30000,
    );
    expect(logsResult.status).toBe(0);
    expect(JSON.parse(logsResult.stdout.trim())).toMatchObject({
      success: true,
      data: { logCount: 1 },
    });

    const metricsResult = runToolWithEnv(
      "src/observability-tool/index.ts",
      ["metrics", "query", "up", "--format", "json"],
      workDir,
      { HOME: homeDir },
      30000,
    );
    expect(metricsResult.status).toBe(0);
    expect(JSON.parse(metricsResult.stdout.trim())).toMatchObject({
      success: true,
      data: { seriesCount: 1 },
    });

    const logQueryResult = runToolWithEnv(
      "src/observability-tool/index.ts",
      ["logs", "query", '{job="mock-app"} |= "Nsure"', "--format", "json"],
      workDir,
      { HOME: homeDir },
      30000,
    );
    expect(logQueryResult.status).toBe(0);
    expect(JSON.parse(logQueryResult.stdout.trim())).toMatchObject({
      success: true,
      data: {
        logCount: 1,
        logs: [
          {
            body: "Nsure import failed",
            severity: "Error",
            attributes: { JobId: "job-1", "exception.message": "permission denied" },
          },
        ],
      },
    });

    const fieldLabelsLogQueryResult = runToolWithEnv(
      "src/observability-tool/index.ts",
      ["logs", "query", '{job="field-label-app"}', "--format", "json"],
      workDir,
      { HOME: homeDir },
      30000,
    );
    expect(fieldLabelsLogQueryResult.status).toBe(0);
    expect(JSON.parse(fieldLabelsLogQueryResult.stdout.trim())).toMatchObject({
      success: true,
      data: {
        logCount: 1,
        logs: [
          {
            line: "field labels log",
            labels: { job: "field-label-app", pod: "pod-1" },
          },
        ],
      },
    });

    const mixedLabelsLogQueryResult = runToolWithEnv(
      "src/observability-tool/index.ts",
      ["logs", "query", '{job="mixed-label-app"}', "--format", "json"],
      workDir,
      { HOME: homeDir },
      30000,
    );
    expect(mixedLabelsLogQueryResult.status).toBe(0);
    expect(JSON.parse(mixedLabelsLogQueryResult.stdout.trim())).toMatchObject({
      success: true,
      data: {
        logCount: 1,
        logs: [
          {
            line: "mixed labels log",
            labels: { job: "mixed-label-app", pod: "pod-2" },
          },
        ],
      },
    });

    expect(existsSync(auditDbPath)).toBe(true);
    const rows = readAuditRows(auditDbPath, 4);
    expect(rows[0]?.tool).toBe("observability");
    expect(rows[1]?.tool).toBe("observability");
    expect(rows[2]?.tool).toBe("observability");
    expect(rows[3]?.tool).toBe("observability");
    expect(rows[0]?.project).toBe(realpathSync(workDir));

    stopServer?.();
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

  const runDbTunnelTest = (
    service: string | undefined,
    expectedService: string,
    options?: { withVpn?: boolean; requireVpnForTunnel?: boolean; withKubeconfig?: boolean },
  ) => {
    const dbDir = join(tmpdir(), `agent-tools-db-tunnel-${Date.now()}`);
    const binDir = join(dbDir, "bin");
    const tunnelReadyPath = join(dbDir, "tunnel-ready");
    const vpnReadyPath = join(dbDir, "vpn-ready");
    const kubectlArgsPath = join(dbDir, "kubectl-args.txt");
    const psqlArgsPath = join(dbDir, "psql-args.txt");
    const psqlAttemptsPath = join(dbDir, "psql-attempts");
    const vpnArgsPath = join(dbDir, "vpn-args.txt");
    // eslint-disable-next-line eslint/no-template-curly-in-string -- verifies config env-template expansion
    const testDbUserTemplate = "${TEST_DB_USER}";

    mkdirSync(binDir, { recursive: true });

    const kubeconfigTemplate = ["$", "{TEST_KUBECONFIG}"].join("");

    writeFileSync(
      join(dbDir, "agent-tools.json5"),
      JSON.stringify({
        ...(options?.withVpn
          ? {
              vpns: {
                appVpn: {
                  name: "ExampleVPN",
                  secretEnvVar: "TEST_VPN_SECRET",
                  connectTimeoutMs: 1000,
                },
              },
            }
          : {}),
        database: {
          default: {
            ...(options?.withVpn ? { vpn: "appVpn" } : {}),
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
                user: testDbUserTemplate,
                database: "app-test",
                passwordEnvVar: "TEST_DB_PASSWORD",
              },
            },
            kubectl: {
              ...(options?.withKubeconfig ? { kubeconfig: kubeconfigTemplate } : {}),
              context: "example-cluster",
              namespace: "system",
              ...(service === undefined ? {} : { service }),
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

    if (options?.withVpn) {
      const vpnToolName =
        process.platform === "darwin"
          ? "scutil"
          : process.platform === "linux"
            ? "nmcli"
            : "rasdial";
      const vpnPath = join(binDir, vpnToolName);
      writeFileSync(
        vpnPath,
        `#!/bin/sh
printf '%s\\n' "$*" >> "${vpnArgsPath}"
if [ "${vpnToolName}" = "scutil" ]; then
  if [ "$1" = "--nc" ] && [ "$2" = "status" ]; then
    if [ -f "${vpnReadyPath}" ]; then
      echo "Connected"
    else
      echo "Disconnected"
    fi
    exit 0
  fi
  if [ "$1" = "--nc" ] && [ "$2" = "start" ]; then
    touch "${vpnReadyPath}"
    exit 0
  fi
  if [ "$1" = "--nc" ] && [ "$2" = "stop" ]; then
    rm -f "${vpnReadyPath}"
    exit 0
  fi
fi
if [ "${vpnToolName}" = "nmcli" ]; then
  if [ "$1" = "-t" ]; then
    if [ -f "${vpnReadyPath}" ]; then
      echo "ExampleVPN"
    fi
    exit 0
  fi
  if [ "$1" = "connection" ] && [ "$2" = "up" ]; then
    touch "${vpnReadyPath}"
    exit 0
  fi
  if [ "$1" = "connection" ] && [ "$2" = "down" ]; then
    rm -f "${vpnReadyPath}"
    exit 0
  fi
fi
if [ "${vpnToolName}" = "rasdial" ]; then
  if [ "$2" = "/disconnect" ]; then
    rm -f "${vpnReadyPath}"
    exit 0
  fi
  if [ "$1" = "ExampleVPN" ]; then
    touch "${vpnReadyPath}"
    exit 0
  fi
  exit 0
fi
exit 1
`,
      );
      chmodSync(vpnPath, 0o755);
    }

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
attempts=0
if [ -f "${psqlAttemptsPath}" ]; then
  attempts=$(cat "${psqlAttemptsPath}")
fi
attempts=$((attempts + 1))
printf '%s' "$attempts" > "${psqlAttemptsPath}"
if [ "${options?.requireVpnForTunnel ? "yes" : "no"}" = "yes" ] && [ ! -f "${vpnReadyPath}" ]; then
  printf 'connection requires VPN\n' >&2
  exit 1
fi
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
        TEST_DB_USER: "readonly-user",
        TEST_DB_PASSWORD: "secret",
        TEST_VPN_SECRET: "vpn-secret",
        TEST_KUBECONFIG: "/tmp/test-kubeconfig",
      },
    );

    const parsed = JSON.parse(result.stdout.trim()) as {
      success: boolean;
      data?: Array<{ ok: number }>;
    };
    const kubectlArgs = readFileSync(kubectlArgsPath, "utf8");
    const psqlArgs = readFileSync(psqlArgsPath, "utf8");
    const psqlAttempts = existsSync(psqlAttemptsPath)
      ? readFileSync(psqlAttemptsPath, "utf8")
      : "0";
    const vpnArgs =
      options?.withVpn && existsSync(vpnArgsPath) ? readFileSync(vpnArgsPath, "utf8") : "";

    rmSync(dbDir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual([{ ok: 1 }]);
    const expectedKubectlArgs = options?.withKubeconfig
      ? `--kubeconfig /tmp/test-kubeconfig port-forward --context example-cluster --namespace system svc/${expectedService} 25437:5432`
      : `port-forward --context example-cluster --namespace system svc/${expectedService} 25437:5432`;
    expect(kubectlArgs).toContain(expectedKubectlArgs);
    expect(psqlArgs).toContain("-h 127.0.0.1 -p 25437 -U readonly-user -d app-test");

    if (options?.requireVpnForTunnel) {
      expect(vpnArgs).toContain("ExampleVPN");
      expect(psqlAttempts).toBe("2");
    } else if (options?.withVpn) {
      expect(vpnArgs).toBe("");
      expect(psqlAttempts).toBe("1");
    }
  };

  it("db-tool opens a tunnel to the default PostgreSQL service", () => {
    runDbTunnelTest(undefined, "postgresql");
  });

  it("db-tool opens a tunnel to a configured service", () => {
    runDbTunnelTest("database", "database");
  });

  it("db-tool passes configured kubeconfig to kubectl tunnel", () => {
    runDbTunnelTest("database", "database", { withKubeconfig: true });
  });

  it("db-tool skips VPN prerequisites when direct database access works", () => {
    runDbTunnelTest("database", "database", { withVpn: true });
  });

  it("db-tool starts VPN prerequisites when direct database access fails", () => {
    runDbTunnelTest("database", "database", { withVpn: true, requireVpnForTunnel: true });
  });
});

describe("Integration: VPN prerequisite cross-process cleanup", () => {
  const getChildStderr = (child: ReturnType<typeof Bun.spawn>) =>
    child.stderr && typeof child.stderr !== "number"
      ? new Response(child.stderr).text()
      : Promise.resolve("");

  const waitForFile = async (
    path: string,
    child?: ReturnType<typeof Bun.spawn>,
    timeoutMs = 15000,
  ) => {
    const start = Date.now();
    while (!existsSync(path)) {
      if (child) {
        const exitCode = await Promise.race([child.exited, Promise.resolve(undefined)]);
        if (exitCode !== undefined) {
          const stderr = await getChildStderr(child);
          throw new Error(
            `Child process exited with ${exitCode} before creating ${path}. stderr: ${stderr}`,
          );
        }
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for ${path}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const waitForExit = async (child: ReturnType<typeof Bun.spawn>, timeoutMs = 15000) => {
    const stderrPromise = getChildStderr(child);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("timedOut");
    const result = await Promise.race([
      child.exited,
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);

    if (timeout) {
      clearTimeout(timeout);
    }

    if (result === timedOut) {
      child.kill();
      const stderr = await stderrPromise;
      throw new Error(`Timed out waiting for child process. stderr: ${stderr}`);
    }

    const stderr = await stderrPromise;
    expect(stderr).toBe("");
    expect(result).toBe(0);
  };

  const createVpnTestPaths = () => {
    const testDir = join(tmpdir(), `agent-tools-vpn-race-${Date.now()}`);
    return {
      testDir,
      runtimeDir: join(testDir, "runtime"),
      vpnReady: join(testDir, "vpn-ready"),
      commandLog: join(testDir, "commands.log"),
      AActive: join(testDir, "a-active"),
      ARelease: join(testDir, "a-release"),
      BActive: join(testDir, "b-active"),
      BRelease: join(testDir, "b-release"),
      CActive: join(testDir, "c-active"),
      CRelease: join(testDir, "c-release"),
      AStartEntered: join(testDir, "a-start-entered"),
    };
  };

  const spawnVpnRuntimeProcess = (
    name: string,
    paths: Record<string, string>,
    cleanupPolicy?: "leave-running" | "stop-if-started",
    options?: { connectTimeoutMs?: number; startDelayMs?: number },
  ) => {
    const script = `
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { runWithProfilePrerequisites } from "./src/shared/prerequisites/runtime.ts";

const name = process.env.PROCESS_NAME ?? "process";
const activePath = process.env.ACTIVE_PATH ?? "";
const releasePath = process.env.RELEASE_PATH ?? "";
const readyPath = process.env.VPN_READY_PATH ?? "";
const commandLogPath = process.env.COMMAND_LOG_PATH ?? "";
const startEnteredPath = process.env.START_ENTERED_PATH ?? "";
const connectTimeoutMs = Number(process.env.CONNECT_TIMEOUT_MS ?? "1000");
const startDelayMs = Number(process.env.START_DELAY_MS ?? "0");
const sleepSync = (ms) => {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
};

const driver = process.platform === "darwin"
  ? { type: "macos-scutil", platform: "darwin", serviceName: "ExampleVPN" }
  : process.platform === "linux"
    ? { type: "linux-nmcli", platform: "linux", connectionName: "ExampleVPN" }
    : { type: "windows-rasdial", platform: "win32", entryName: "ExampleVPN" };

const config = {
  vpns: {
    appVpn: {
      name: "ExampleVPN",
      auto: false,
      driver,
      connectTimeoutMs,
      leaseTtlMs: 10000,
    },
  },
};

const cleanupPolicy = process.env.CLEANUP_POLICY;
const prerequisite = cleanupPolicy
  ? { type: "vpn", key: "appVpn", cleanup: cleanupPolicy }
  : { type: "vpn", key: "appVpn" };
const profile = { prerequisites: [prerequisite] };

const runCommand = (_command, label) =>
  Effect.sync(() => {
    appendFileSync(commandLogPath, name + ":" + label + "\\n");

    if (label.includes("status")) {
      return { stdout: existsSync(readyPath) ? "Connected ExampleVPN\\n" : "Disconnected\\n", stderr: "", exitCode: 0 };
    }

    if (label.includes("connection show")) {
      return { stdout: existsSync(readyPath) ? "ExampleVPN\\n" : "", stderr: "", exitCode: 0 };
    }

    if (label === "rasdial") {
      return { stdout: existsSync(readyPath) ? "Connected to ExampleVPN\\n" : "No connections\\n", stderr: "", exitCode: 0 };
    }

    if (label.includes("start") || label.includes("connection up") || label === "rasdial ExampleVPN") {
      if (startEnteredPath !== "") {
        writeFileSync(startEnteredPath, name);
      }
      sleepSync(startDelayMs);
      writeFileSync(readyPath, name);
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (label.includes("stop") || label.includes("connection down") || label.includes("/disconnect")) {
      rmSync(readyPath, { force: true });
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    return { stdout: "", stderr: "unexpected command", exitCode: 1 };
  });

const work = Effect.promise(
  () =>
    new Promise((resolve) => {
      writeFileSync(activePath, name);
      const interval = setInterval(() => {
        if (existsSync(releasePath)) {
          clearInterval(interval);
          resolve(undefined);
        }
      }, 20);
    }),
);

Effect.runPromise(runWithProfilePrerequisites(config, profile, runCommand, work)).then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
`.trim();

    return Bun.spawn(["bun", "-e", script], {
      cwd: TOOLS_ROOT,
      env: {
        ...process.env,
        PROCESS_NAME: name,
        AGENT_TOOLS_RUNTIME_DIR: paths.runtimeDir,
        ACTIVE_PATH: paths[`${name}Active`],
        RELEASE_PATH: paths[`${name}Release`],
        VPN_READY_PATH: paths.vpnReady,
        COMMAND_LOG_PATH: paths.commandLog,
        START_ENTERED_PATH: paths[`${name}StartEntered`] ?? "",
        CONNECT_TIMEOUT_MS: String(options?.connectTimeoutMs ?? 1000),
        START_DELAY_MS: String(options?.startDelayMs ?? 0),
        ...(cleanupPolicy ? { CLEANUP_POLICY: cleanupPolicy } : {}),
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
  };

  it("keeps an explicitly leave-running VPN connected after cleanup", async () => {
    const paths = createVpnTestPaths();
    mkdirSync(paths.testDir, { recursive: true });
    writeFileSync(paths.commandLog, "");

    const child = spawnVpnRuntimeProcess("A", paths, "leave-running");

    try {
      await waitForFile(paths.AActive, child);
      writeFileSync(paths.ARelease, "release");
      await waitForExit(child);

      const finalLog = readFileSync(paths.commandLog, "utf8");
      expect(existsSync(paths.vpnReady)).toBe(true);
      expect(finalLog).not.toContain("stop");
      expect(finalLog).not.toContain("connection down");
      expect(finalLog).not.toContain("/disconnect");
    } finally {
      child.kill();
      rmSync(paths.testDir, { recursive: true, force: true });
    }
  }, 30000);

  it("does not stop a VPN that was already connected before the process started", async () => {
    const paths = createVpnTestPaths();
    mkdirSync(paths.testDir, { recursive: true });
    writeFileSync(paths.commandLog, "");
    writeFileSync(paths.vpnReady, "preexisting");

    const child = spawnVpnRuntimeProcess("A", paths);

    try {
      await waitForFile(paths.AActive, child);
      writeFileSync(paths.ARelease, "release");
      await waitForExit(child);

      const finalLog = readFileSync(paths.commandLog, "utf8");
      expect(existsSync(paths.vpnReady)).toBe(true);
      expect(finalLog).not.toContain("stop");
      expect(finalLog).not.toContain("connection down");
      expect(finalLog).not.toContain("/disconnect");
    } finally {
      child.kill();
      rmSync(paths.testDir, { recursive: true, force: true });
    }
  }, 30000);

  it("leave-running overlap keeps VPN connected and prevents later default cleanup", async () => {
    const paths = createVpnTestPaths();
    mkdirSync(paths.testDir, { recursive: true });
    writeFileSync(paths.commandLog, "");

    const processA = spawnVpnRuntimeProcess("A", paths);
    const childProcesses: Array<ReturnType<typeof Bun.spawn>> = [];

    try {
      await waitForFile(paths.AActive, processA);
      await waitForFile(paths.vpnReady, processA);

      const processB = spawnVpnRuntimeProcess("B", paths, "leave-running");
      childProcesses.push(processB);
      await waitForFile(paths.BActive, processB);

      writeFileSync(paths.ARelease, "release");
      await waitForExit(processA);
      writeFileSync(paths.BRelease, "release");
      await waitForExit(processB);

      expect(existsSync(paths.vpnReady)).toBe(true);
      const logAfterOverlap = readFileSync(paths.commandLog, "utf8");
      expect(logAfterOverlap).not.toContain("stop");
      expect(logAfterOverlap).not.toContain("connection down");
      expect(logAfterOverlap).not.toContain("/disconnect");

      const processC = spawnVpnRuntimeProcess("C", paths);
      childProcesses.push(processC);
      await waitForFile(paths.CActive, processC);
      writeFileSync(paths.CRelease, "release");
      await waitForExit(processC);

      const finalLog = readFileSync(paths.commandLog, "utf8");
      expect(existsSync(paths.vpnReady)).toBe(true);
      expect(finalLog).not.toContain("stop");
      expect(finalLog).not.toContain("connection down");
      expect(finalLog).not.toContain("/disconnect");
    } finally {
      processA.kill();
      for (const child of childProcesses) {
        child.kill();
      }
      rmSync(paths.testDir, { recursive: true, force: true });
    }
  }, 30000);

  it("waits for another process to finish connecting before acquiring the VPN lease", async () => {
    const paths = createVpnTestPaths();
    mkdirSync(paths.testDir, { recursive: true });
    writeFileSync(paths.commandLog, "");

    const processA = spawnVpnRuntimeProcess("A", paths, undefined, {
      connectTimeoutMs: 8000,
      startDelayMs: 6000,
    });
    const childProcesses: Array<ReturnType<typeof Bun.spawn>> = [];

    try {
      await waitForFile(paths.AStartEntered, processA);

      const processB = spawnVpnRuntimeProcess("B", paths, undefined, { connectTimeoutMs: 8000 });
      childProcesses.push(processB);
      await waitForFile(paths.BActive, processB, 30000);

      writeFileSync(paths.ARelease, "release");
      writeFileSync(paths.BRelease, "release");
      await waitForExit(processA, 30000);
      await waitForExit(processB, 30000);

      const finalLog = readFileSync(paths.commandLog, "utf8");
      expect(finalLog).toContain("A:");
      expect(finalLog).toContain("B:");
    } finally {
      processA.kill();
      for (const child of childProcesses) {
        child.kill();
      }
      rmSync(paths.testDir, { recursive: true, force: true });
    }
  }, 120000);

  it("does not stop an agent-started VPN while another process still holds a lease", async () => {
    const paths = createVpnTestPaths();

    mkdirSync(paths.testDir, { recursive: true });
    writeFileSync(paths.commandLog, "");

    const processA = spawnVpnRuntimeProcess("A", paths);
    const processBProcesses: Array<ReturnType<typeof Bun.spawn>> = [];

    try {
      await waitForFile(paths.AActive, processA);
      await waitForFile(paths.vpnReady, processA);

      const processB = spawnVpnRuntimeProcess("B", paths);
      processBProcesses.push(processB);
      await waitForFile(paths.BActive, processB);

      writeFileSync(paths.ARelease, "release");
      await waitForExit(processA);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(existsSync(paths.vpnReady)).toBe(true);
      const logAfterAExit = readFileSync(paths.commandLog, "utf8");
      expect(logAfterAExit).not.toContain("stop");
      expect(logAfterAExit).not.toContain("connection down");
      expect(logAfterAExit).not.toContain("/disconnect");

      writeFileSync(paths.BRelease, "release");
      await waitForExit(processB);

      const finalLog = readFileSync(paths.commandLog, "utf8");
      const stopCount = finalLog
        .split("\n")
        .filter(
          (line) =>
            line.includes("stop") ||
            line.includes("connection down") ||
            line.includes("/disconnect"),
        ).length;

      expect(existsSync(paths.vpnReady)).toBe(false);
      expect(stopCount).toBe(1);
    } finally {
      processA.kill();
      for (const child of processBProcesses) {
        child.kill();
      }
      rmSync(paths.testDir, { recursive: true, force: true });
    }
  }, 30000);
});
