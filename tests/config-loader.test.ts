import { describe, expect, it } from "vitest";

import { getDefaultEnvironment, getToolConfig } from "#config/loader";
import type { AgentToolsConfig } from "#config/types";

describe("getToolConfig", () => {
  it("returns undefined when config is undefined", () => {
    const result = getToolConfig<{ organization: string }>(undefined, "azure");
    expect(result).toBeUndefined();
  });

  it("returns undefined when section is missing", () => {
    const config: AgentToolsConfig = {
      kubernetes: {
        default: {
          clusterId: "cluster",
          namespaces: { test: "ns-test" },
        },
      },
    };

    const result = getToolConfig<{ organization: string }>(config, "azure");
    expect(result).toBeUndefined();
  });

  it("returns undefined when section exists but is empty", () => {
    const config: AgentToolsConfig = {
      azure: {},
    };

    const result = getToolConfig<{ organization: string }>(config, "azure");
    expect(result).toBeUndefined();
  });

  it("returns the explicitly selected profile", () => {
    const config: AgentToolsConfig = {
      azure: {
        default: {
          organization: "https://dev.azure.com/main",
          defaultProject: "platform",
        },
        legacy: {
          organization: "https://dev.azure.com/legacy",
          defaultProject: "legacy",
        },
      },
    };

    const result = getToolConfig<{ organization: string; defaultProject: string }>(
      config,
      "azure",
      "legacy",
    );

    expect(result).toEqual({
      organization: "https://dev.azure.com/legacy",
      defaultProject: "legacy",
    });
  });

  it("returns the only profile when no profile is specified", () => {
    const config: AgentToolsConfig = {
      logs: {
        teamA: {
          localDir: "apps/web/logs",
          remotePath: "/app/logs",
        },
      },
    };

    const result = getToolConfig<{ localDir: string; remotePath: string }>(config, "logs");
    expect(result).toEqual({
      localDir: "apps/web/logs",
      remotePath: "/app/logs",
    });
  });

  it("returns default profile when multiple profiles exist and no profile is provided", () => {
    const config: AgentToolsConfig = {
      database: {
        default: {
          environments: {
            local: {
              host: "127.0.0.1",
              port: 5432,
              user: "app",
              database: "app_db",
            },
          },
        },
        analytics: {
          environments: {
            local: {
              host: "127.0.0.1",
              port: 5433,
              user: "analytics",
              database: "analytics_db",
            },
          },
        },
      },
    };

    const result = getToolConfig<{
      environments: Record<string, { host: string; port: number; user: string }>;
    }>(config, "database");

    expect(result?.environments.local?.host).toBe("127.0.0.1");
    expect(result?.environments.local?.port).toBe(5432);
    expect(result?.environments.local?.user).toBe("app");
  });

  it("throws when multiple profiles exist and default profile is missing", () => {
    const config: AgentToolsConfig = {
      azure: {
        orgA: {
          organization: "https://dev.azure.com/org-a",
          defaultProject: "proj-a",
        },
        orgB: {
          organization: "https://dev.azure.com/org-b",
          defaultProject: "proj-b",
        },
      },
    };

    expect(() => getToolConfig(config, "azure")).toThrow(
      "Multiple azure profiles found: [orgA, orgB]. Use --profile <name> to select one.",
    );
  });

  it("returns undefined when profile specified but does not exist", () => {
    const config: AgentToolsConfig = {
      azure: {
        default: {
          organization: "https://dev.azure.com/main",
          defaultProject: "platform",
        },
      },
    };

    const result = getToolConfig<{ organization: string }>(config, "azure", "nonexistent");
    expect(result).toBeUndefined();
  });

  it("works across all profiled sections", () => {
    const config: AgentToolsConfig = {
      azure: { default: { organization: "org", defaultProject: "proj" } },
      kubernetes: { default: { clusterId: "cluster", namespaces: { test: "ns" } } },
      database: {
        default: {
          environments: { local: { host: "localhost", port: 5432, user: "u", database: "d" } },
        },
      },
      logs: { default: { localDir: "/logs", remotePath: "/remote" } },
    };

    expect(getToolConfig(config, "azure")).toBeDefined();
    expect(getToolConfig(config, "kubernetes")).toBeDefined();
    expect(getToolConfig(config, "database")).toBeDefined();
    expect(getToolConfig(config, "logs")).toBeDefined();
  });
});

describe("getDefaultEnvironment", () => {
  it("returns undefined when config is undefined", () => {
    const result = getDefaultEnvironment(undefined);
    expect(result).toBeUndefined();
  });

  it("returns undefined when defaultEnvironment is not set", () => {
    const config: AgentToolsConfig = {
      kubernetes: {
        default: {
          clusterId: "cluster",
          namespaces: { test: "ns-test" },
        },
      },
    };

    const result = getDefaultEnvironment(config);
    expect(result).toBeUndefined();
  });

  it("returns the configured defaultEnvironment string", () => {
    const config: AgentToolsConfig = {
      defaultEnvironment: "test",
      kubernetes: {
        default: {
          clusterId: "cluster",
          namespaces: { test: "ns-test" },
        },
      },
    };

    const result = getDefaultEnvironment(config);
    expect(result).toBe("test");
  });

  it("returns defaultEnvironment even when set to prod", () => {
    const config: AgentToolsConfig = {
      defaultEnvironment: "prod",
      kubernetes: {
        default: {
          clusterId: "cluster",
          namespaces: { prod: "ns-prod" },
        },
      },
    };

    const result = getDefaultEnvironment(config);
    expect(result).toBe("prod");
  });

  it("returns defaultEnvironment for local environment", () => {
    const config: AgentToolsConfig = {
      defaultEnvironment: "local",
      database: {
        default: {
          environments: {
            local: {
              host: "localhost",
              port: 5432,
              user: "app",
              database: "app_db",
            },
          },
        },
      },
    };

    const result = getDefaultEnvironment(config);
    expect(result).toBe("local");
  });

  it("works with empty config object", () => {
    const config: AgentToolsConfig = {};
    const result = getDefaultEnvironment(config);
    expect(result).toBeUndefined();
  });
});
