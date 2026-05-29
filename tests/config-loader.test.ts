import { describe, expect, it } from "vitest";

import {
  decodeConfig,
  getDefaultEnvironment,
  getGitHubConfig,
  getToolConfig,
  resolveGitHubRepoTarget,
} from "#config/loader";
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

describe("GitHub repo resolver", () => {
  it("prefers default when it exists", () => {
    const config: AgentToolsConfig = {
      github: {
        be: { owner: "sabservis", repo: "nexus-be" },
        default: { owner: "sabservis", repo: "nexus-fe" },
      },
    };

    expect(getGitHubConfig(config)).toEqual({ owner: "sabservis", repo: "nexus-fe" });
    expect(resolveGitHubRepoTarget(config)).toBe("sabservis/nexus-fe");
  });

  it("auto-selects a single non-default profile", () => {
    const config: AgentToolsConfig = {
      github: {
        be: { owner: "sabservis", repo: "nexus-be" },
      },
    };

    expect(resolveGitHubRepoTarget(config)).toBe("sabservis/nexus-be");
  });

  it("requires --repo when multiple non-default profiles exist", () => {
    const config: AgentToolsConfig = {
      github: {
        be: { owner: "sabservis", repo: "nexus-be" },
        fe: { owner: "sabservis", repo: "nexus-fe" },
      },
    };

    expect(() => resolveGitHubRepoTarget(config)).toThrow(
      "Multiple github profiles found: [be, fe]. Use --repo <name> to select one.",
    );
  });

  it("resolves named profiles and preserves explicit owner/name targets", () => {
    const config: AgentToolsConfig = {
      github: {
        be: { owner: "sabservis", repo: "nexus-be" },
      },
    };

    expect(resolveGitHubRepoTarget(config, "be")).toBe("sabservis/nexus-be");
    expect(resolveGitHubRepoTarget(config, "sabservis/nexus-infra")).toBe("sabservis/nexus-infra");
  });

  it("lists available names for an unknown profile", () => {
    const config: AgentToolsConfig = {
      github: {
        be: { owner: "sabservis", repo: "nexus-be" },
        fe: { owner: "sabservis", repo: "nexus-fe" },
      },
    };

    expect(() => resolveGitHubRepoTarget(config, "docs")).toThrow(
      "Unknown github profile 'docs'. Available profiles: [be, fe]. Use --repo owner/name for an explicit repository.",
    );
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

describe("decodeConfig", () => {
  it("ignores unknown top-level sections while keeping known sections available", () => {
    const config = decodeConfig(
      {
        github: {
          default: {
            owner: "example-owner",
            repo: "example-repo",
          },
        },
        observability: {
          default: {
            environments: {
              local: {
                url: "http://grafana.local",
              },
            },
          },
        },
      },
      "test-config.json5",
    );

    expect(config.github).toEqual({
      default: {
        owner: "example-owner",
        repo: "example-repo",
      },
    });
    expect(config.observability).toEqual({
      default: {
        environments: {
          local: {
            url: "http://grafana.local",
          },
        },
      },
    });
  });

  it("still rejects invalid known github sections while ignoring unknown ones", () => {
    expect(() =>
      decodeConfig(
        {
          github: {
            owner: "example-owner",
            repo: "example-repo",
          },
          observability: {
            anything: true,
          },
        },
        "test-config.json5",
      ),
    ).toThrow(/Invalid agent-tools config/);
  });
});

describe("VPN prerequisites config", () => {
  it("keeps top-level vpns and profile prerequisites during decode", () => {
    const config = decodeConfig({
      vpns: {
        exampleVpn: { name: "ExampleVPN" },
      },
      kubernetes: {
        appCluster: {
          clusterId: "example-cluster",
          namespaces: { app: "app" },
          prerequisites: [{ type: "vpn", key: "exampleVpn", cleanup: "stop-if-started" }],
        },
      },
    });

    expect(config.vpns?.exampleVpn?.name).toBe("ExampleVPN");
    expect(config.vpns?.exampleVpn?.auto).toBeUndefined();
    expect(config.kubernetes?.appCluster?.prerequisites).toEqual([
      { type: "vpn", key: "exampleVpn", cleanup: "stop-if-started" },
    ]);
  });

  it("accepts vpn profile sugar without normalizing at decode time", () => {
    const config = decodeConfig({
      vpns: { exampleVpn: { name: "ExampleVPN" } },
      logs: {
        default: {
          localDir: "logs",
          remotePath: "/app/logs",
          kubernetesProfile: "appCluster",
          vpn: "exampleVpn",
        },
      },
    });

    expect(config.logs?.default?.vpn).toBe("exampleVpn");
    expect(config.logs?.default?.kubernetesProfile).toBe("appCluster");
  });

  it("accepts VPN prerequisites on database profiles", () => {
    const config = decodeConfig({
      vpns: { exampleVpn: { name: "ExampleVPN" } },
      database: {
        default: {
          environments: {
            staging: {
              host: "127.0.0.1",
              port: 25439,
              user: "app-readonly",
              database: "app",
            },
          },
          kubectl: {
            context: "example-cluster",
            namespace: "data",
            service: "database",
          },
          vpn: "exampleVpn",
        },
      },
    });

    expect(config.database?.default?.vpn).toBe("exampleVpn");
    expect(config.database?.default?.kubectl?.service).toBe("database");
  });

  it("accepts VPN prerequisites on database environments", () => {
    const config = decodeConfig({
      vpns: { stagingVpn: { name: "StagingVPN" }, prodVpn: { name: "ProdVPN" } },
      database: {
        default: {
          vpn: "stagingVpn",
          environments: {
            staging: {
              host: "127.0.0.1",
              port: 25439,
              user: "app-readonly",
              database: "app",
              vpn: "prodVpn",
              prerequisites: [{ type: "vpn", key: "prodVpn", cleanup: "leave-running" }],
            },
          },
        },
      },
    });

    expect(config.database?.default?.environments.staging?.vpn).toBe("prodVpn");
    expect(config.database?.default?.environments.staging?.prerequisites).toEqual([
      { type: "vpn", key: "prodVpn", cleanup: "leave-running" },
    ]);
  });

  it("accepts per-environment database mutation permissions", () => {
    const config = decodeConfig({
      database: {
        default: {
          environments: {
            staging: { host: "127.0.0.1", port: 25439, user: "u", database: "app" },
          },
          allowedMutations: {
            staging: ["insert", "update"],
          },
        },
      },
    });

    expect(config.database?.default?.allowedMutations?.staging).toEqual(["insert", "update"]);
  });

  it("accepts kubeconfig paths on kubernetes and database profiles", () => {
    const kubeconfigTemplate = ["$", "{NEXUS_KUBECONFIG}"].join("");
    const config = decodeConfig({
      kubernetes: {
        default: {
          kubeconfig: kubeconfigTemplate,
          clusterId: "cluster",
          namespaces: { test: "test" },
        },
      },
      database: {
        default: {
          environments: {
            staging: { host: "127.0.0.1", port: 25439, user: "u", database: "app" },
          },
          kubectl: {
            kubeconfig: kubeconfigTemplate,
            context: "cluster",
            namespace: "data",
          },
        },
      },
    });

    expect(config.kubernetes?.default?.kubeconfig).toBe(kubeconfigTemplate);
    expect(config.database?.default?.kubectl?.kubeconfig).toBe(kubeconfigTemplate);
  });

  it("rejects unsupported VPN prerequisite cleanup policies", () => {
    expect(() =>
      decodeConfig({
        kubernetes: {
          default: {
            clusterId: "cluster",
            namespaces: { test: "test" },
            prerequisites: [{ type: "vpn", key: "exampleVpn", cleanup: "always" }],
          },
        },
      }),
    ).toThrow("Invalid agent-tools config");
  });
});
