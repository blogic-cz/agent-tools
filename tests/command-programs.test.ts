import { SessionServiceLayer } from "#session/service";
import { ResolvedPaths } from "#session/config";
import { run as runSession } from "#session/main";
import { makeAuditServiceLayer, withAudit } from "#shared/audit";
import { ghCommand } from "./helpers/gh-command";
import { renderCauseToStderr } from "#shared/error-renderer";
import { BunServices } from "@effect/platform-bun";
import { Command } from "effect/cli";
import { ConfigService } from "#config";
import { mainCommand as k8sCommand } from "#k8s/main";
import { K8sServiceLayer } from "#k8s/service";
import { processResultLayer } from "./helpers/process-result";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { loadConfig } from "#config/loader";
import {
  createCredentialGuard,
  detectSecrets,
  handleToolExecuteBefore,
  isPathAllowed,
} from "#guard";
import { captureOutput } from "./helpers/capture-output";
import { observabilityResponses } from "./fixtures/observability-responses";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const runToolWithEnv = async (
  toolPath: string,
  args: string[],
  cwd?: string,
  env: Record<string, string> = {},
  _timeout?: number,
) => {
  const result = await captureOutput(
    async () => {
      process.argv = ["bun", toolPath, ...args];
      const module = await import(
        new URL("../" + toolPath.replace("index.ts", "main.ts"), import.meta.url).href
      );
      if (toolPath.includes("/gh-tool/"))
        return Effect.runPromiseExit(
          ghCommand(args, () => {
            throw new Error("Invalid arguments must not reach GitHub");
          }).pipe(Effect.tapCause(renderCauseToStderr)),
        );
      const configPath = join(cwd ?? process.cwd(), "agent-tools.json5");
      const config = JSON.parse(await Bun.file(configPath).text());
      config.audit = {
        dbPath: env.HOME
          ? join(env.HOME, ".agent-tools", "audit.sqlite")
          : join(cwd ?? process.cwd(), "audit.sqlite"),
      };
      await Bun.write(configPath, JSON.stringify(config));
      if (toolPath.includes("/session-tool/")) {
        const root = cwd ?? process.cwd();
        const layer = SessionServiceLayer.pipe(
          Layer.provideMerge(
            Layer.succeed(ResolvedPaths, {
              messagesPath: join(root, "message"),
              sessionsPath: join(root, "session"),
              claudeCodePath: null,
              codexPath: null,
              piPath: null,
            }),
          ),
          Layer.provideMerge(BunServices.layer),
          Layer.provideMerge(makeAuditServiceLayer({ dbPath: config.audit.dbPath })),
        );
        return Effect.runPromiseExit(
          withAudit("session", runSession(args)).pipe(Effect.provide(layer)),
        );
      }
      return Effect.runPromiseExit(module.runProgram(args));
    },
    { cwd, env: { ...process.env, ...env } },
  );
  return { ...result, status: Exit.isSuccess(result.value) ? 0 : 1 };
};
const runTool = (toolPath: string, args: string[], cwd?: string, timeout?: number) =>
  runToolWithEnv(toolPath, args, cwd, {}, timeout);
const readAuditRows = (dbPath: string, limit: number) => {
  const db = new Database(dbPath);
  try {
    return db
      .query<{ tool: string; project: string; args: string; success: number }, [number]>(
        "SELECT tool, project, args, success FROM audit_log ORDER BY id DESC LIMIT ?",
      )
      .all(limit);
  } finally {
    db.close();
  }
};
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
      azurePlatform: {
        default: {
          subscription: "00000000-0000-0000-0000-000000000000",
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

describe("Command program: tool --help in zero-config mode", () => {
  it("gh-tool --help renders help without config file", async () => {
    const result = await runTool("src/gh-tool/index.ts", ["--help"], undefined, 15000);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GitHub");
  });

  it("gh-tool renders typed batch PR parse errors", async () => {
    for (const [prs, hint] of [
      ["1,nope", "Pass comma-separated positive integers"],
      [Array.from({ length: 51 }, (_, index) => String(index + 1)).join(","), "Split the request"],
    ]) {
      const result = await runTool("src/gh-tool/index.ts", ["pr", "view", "--prs", prs]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("GitHubCommandError:");
      expect(result.stderr).toContain(hint);
      expect(result.stderr).not.toContain("Unexpected error");
    }
  });
});

describe("Command program: tools --help with config file", () => {
  it("k8s-tool --help renders help with config", async () => {
    const result = await runTool("src/k8s-tool/index.ts", ["--help"], configDir, 15000);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Kubernetes");
  });

  it("az-tool --help renders help with config", async () => {
    const result = await runTool("src/az-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Azure Platform");
  });

  it("azdo-tool --help renders help with config", async () => {
    const result = await runTool("src/azdo-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Azure DevOps");
  });

  it("db-tool --help renders help with config", async () => {
    const result = await runTool("src/db-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Database");
  });

  it("logs-tool --help renders help with config", async () => {
    const result = await runTool("src/logs-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Logs");
  });

  it("observability-tool --help renders help with config", async () => {
    const result = await runTool("src/observability-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LGTM");
  });

  it("session-tool --help renders help with config", async () => {
    const result = await runTool("src/session-tool/index.ts", ["--help"], configDir);
    expect(result.status).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("session");
  });

  it("session-tool list records and reads its configured audit row", async () => {
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

    const result = await runToolWithEnv(
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

    const auditResult = await runToolWithEnv(
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

  it("session-tool list returns one row per session", async () => {
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

    const result = await runToolWithEnv(
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

    const serverUrl = "https://grafana.invalid";
    vi.stubGlobal("fetch", async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/datasources")
        return Response.json(observabilityResponses.datasources);
      if (url.pathname.includes("/api/traces/")) return Response.json(observabilityResponses.trace);
      if (url.pathname === "/api/ds/query") {
        const payload = JSON.parse(String(options?.body)) as { queries: { expr: string }[] };
        const expr = payload.queries[0]?.expr;
        if (expr !== undefined && Object.hasOwn(observabilityResponses, expr))
          return Response.json(Reflect.get(observabilityResponses, expr));
      }
      throw new Error("Unexpected observability request: " + url.pathname);
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

    const traceResult = await runToolWithEnv(
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

    const logsResult = await runToolWithEnv(
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

    const metricsResult = await runToolWithEnv(
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

    const logQueryResult = await runToolWithEnv(
      "src/observability-tool/index.ts",
      ["logs", "query", '{job="mock-app"} |= "ExternalService"', "--format", "json"],
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
            body: "ExternalService request failed",
            severity: "Error",
            attributes: { JobId: "job-1", "exception.message": "permission denied" },
          },
        ],
      },
    });

    const fieldLabelsLogQueryResult = await runToolWithEnv(
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

    const mixedLabelsLogQueryResult = await runToolWithEnv(
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

    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
});
describe("Command program: credential-guard import", () => {
  it("exports handleToolExecuteBefore and detectSecrets", async () => {
    expect(typeof handleToolExecuteBefore).toBe("function");
    expect(typeof detectSecrets).toBe("function");
    expect(typeof isPathAllowed).toBe("function");
    expect(typeof createCredentialGuard).toBe("function");
  });

  it("detectSecrets finds AWS keys", async () => {
    // eslint-disable-next-line eslint/no-useless-concat -- intentionally split to avoid credential guard self-detection
    const fakeKey = "AKIA" + "IOSFODNN7EXAMPLE";
    const found = detectSecrets(fakeKey);
    expect(found).toBeDefined();
    expect(found?.name).toContain("AWS");
  });
});

it("loadConfig returns undefined when no config file", async () => {
  const root = mkdtempSync(join(tmpdir(), "config-empty-"));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    expect(await loadConfig()).toBeUndefined();
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});
describe("Command program: env safety + k8s namespace fallback", () => {
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

  it("blocks implicit prod in db-tool unless --env prod is explicit", async () => {
    const result = await runTool(
      "src/db-tool/index.ts",
      ["sql", "--sql", "SELECT 1", "--format", "json"],
      prodDefaultDir,
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("Implicit prod access blocked");
    expect(output).toContain("--env prod");
  });

  it("blocks implicit prod in logs-tool unless --env prod is explicit", async () => {
    const result = await runTool(
      "src/logs-tool/index.ts",
      ["list", "--format", "json"],
      prodDefaultDir,
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("Implicit prod access blocked");
    expect(output).toContain("--env prod");
  });

  it("blocks implicit prod in k8s-tool unless --env prod is explicit", async () => {
    const result = await runTool(
      "src/k8s-tool/index.ts",
      ["pods", "--format", "json", "--dry-run"],
      prodDefaultDir,
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("Implicit prod access blocked");
    expect(output).toContain("--env prod");
  });
});

it("k8s structured pods uses namespace from env mapping when --namespace is omitted", async () => {
  const commands: string[][] = [];
  const config = Layer.succeed(ConfigService, {
    defaultEnvironment: "test",
    kubernetes: {
      default: {
        clusterId: "test-cluster-id",
        namespaces: { test: "mapped-test-ns", prod: "mapped-prod-ns" },
      },
    },
  });
  const runner = processResultLayer((args) => {
    commands.push([...args]);
    if (args.includes("config"))
      return {
        stdout: JSON.stringify({
          contexts: [{ name: "ctx-test", context: { cluster: "test-cluster-id" } }],
          clusters: [{ name: "test-cluster-id", cluster: { server: "https://test" } }],
        }),
        stderr: "",
        exitCode: 0,
      };
    throw new Error("Unexpected kubectl command: " + args.join(" "));
  });
  const layer = K8sServiceLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(BunServices.layer, config, runner)),
  );
  const result = await captureOutput(async () => {
    await Effect.runPromise(
      Command.runWith(k8sCommand, { version: "test", renderErrors: false })([
        "pods",
        "--env",
        "test",
        "--dry-run",
        "--format",
        "json",
      ]).pipe(Effect.provide(layer)),
    );
  });
  expect(result.stdout).toContain("mapped-test-ns");
  expect(result.stdout).not.toContain("mapped-prod-ns");
  expect(commands.every((args) => args.includes("config"))).toBe(true);
});
