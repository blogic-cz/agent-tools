import { dirname } from "node:path";

import { Context, Data, Effect, Layer, Schema } from "effect";

import type { AgentToolsConfig, GitHubRepoConfig } from "./types";
import { DbMutationOperationSchema } from "./types";

const CliToolOverrideSchema = Schema.Struct({
  tool: Schema.String,
  suggestion: Schema.String,
});

const CredentialGuardConfigSchema = Schema.Struct({
  additionalBlockedPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalAllowedPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalBlockedCliTools: Schema.optionalKey(Schema.Array(CliToolOverrideSchema)),
  additionalDangerousBashPatterns: Schema.optionalKey(Schema.Array(Schema.String)),
});

const CleanupPolicySchema = Schema.Literals(["leave-running", "stop-if-started"]);

const VpnPrerequisiteSchema = Schema.Struct({
  type: Schema.Literal("vpn"),
  key: Schema.String,
  cleanup: Schema.optionalKey(CleanupPolicySchema),
});

const PrerequisiteSchema = VpnPrerequisiteSchema;
const PrerequisitesSchema = Schema.Array(PrerequisiteSchema);

const MacosScutilVpnDriverConfigSchema = Schema.Struct({
  type: Schema.Literal("macos-scutil"),
  serviceName: Schema.optionalKey(Schema.String),
  secretEnvVar: Schema.optionalKey(Schema.String),
});

const LinuxNmcliVpnDriverConfigSchema = Schema.Struct({
  type: Schema.Literal("linux-nmcli"),
  connectionName: Schema.optionalKey(Schema.String),
});

const WindowsRasdialVpnDriverConfigSchema = Schema.Struct({
  type: Schema.Literal("windows-rasdial"),
  entryName: Schema.optionalKey(Schema.String),
});

const VpnDriverConfigSchema = Schema.Union([
  MacosScutilVpnDriverConfigSchema,
  LinuxNmcliVpnDriverConfigSchema,
  WindowsRasdialVpnDriverConfigSchema,
]);

const VpnConfigSchema = Schema.Struct({
  name: Schema.String,
  auto: Schema.optionalKey(Schema.Boolean),
  defaultCleanup: Schema.optionalKey(CleanupPolicySchema),
  connectTimeoutMs: Schema.optionalKey(Schema.Number),
  disconnectTimeoutMs: Schema.optionalKey(Schema.Number),
  cooldownMs: Schema.optionalKey(Schema.Number),
  leaseTtlMs: Schema.optionalKey(Schema.Number),
  secretEnvVar: Schema.optionalKey(Schema.String),
  drivers: Schema.optionalKey(
    Schema.Struct({
      darwin: Schema.optionalKey(MacosScutilVpnDriverConfigSchema),
      linux: Schema.optionalKey(LinuxNmcliVpnDriverConfigSchema),
      win32: Schema.optionalKey(WindowsRasdialVpnDriverConfigSchema),
    }),
  ),
  driver: Schema.optionalKey(VpnDriverConfigSchema),
});

const AzureConfigSchema = Schema.Struct({
  organization: Schema.String,
  defaultProject: Schema.String,
  timeoutMs: Schema.optionalKey(Schema.Number),
});

const K8sConfigSchema = Schema.Struct({
  kubeconfig: Schema.optionalKey(Schema.String),
  clusterId: Schema.String,
  namespaces: Schema.Record(Schema.String, Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Number),
  apiProbeTimeoutMs: Schema.optionalKey(Schema.Number),
  prerequisites: Schema.optionalKey(PrerequisitesSchema),
  vpn: Schema.optionalKey(Schema.String),
});

const DbEnvConfigSchema = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  user: Schema.String,
  database: Schema.String,
  password: Schema.optionalKey(Schema.String),
  passwordEnvVar: Schema.optionalKey(Schema.String),
  prerequisites: Schema.optionalKey(PrerequisitesSchema),
  vpn: Schema.optionalKey(Schema.String),
});

const DbAllowedMutationTargetsSchema = Schema.Struct({
  insert: Schema.optionalKey(Schema.Array(Schema.String)),
  update: Schema.optionalKey(Schema.Array(Schema.String)),
  delete: Schema.optionalKey(Schema.Array(Schema.String)),
});

const DatabaseConfigSchema = Schema.Struct({
  environments: Schema.Record(Schema.String, DbEnvConfigSchema),
  allowedMutations: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Array(DbMutationOperationSchema)),
  ),
  allowedMutationTargets: Schema.optionalKey(
    Schema.Record(Schema.String, DbAllowedMutationTargetsSchema),
  ),
  kubectl: Schema.optionalKey(
    Schema.Struct({
      kubeconfig: Schema.optionalKey(Schema.String),
      context: Schema.String,
      namespace: Schema.String,
      service: Schema.optionalKey(Schema.String),
    }),
  ),
  tunnelTimeoutMs: Schema.optionalKey(Schema.Number),
  remotePort: Schema.optionalKey(Schema.Number),
  prerequisites: Schema.optionalKey(PrerequisitesSchema),
  vpn: Schema.optionalKey(Schema.String),
});

const LogsConfigSchema = Schema.Struct({
  localDir: Schema.String,
  remotePath: Schema.String,
  kubernetesProfile: Schema.optionalKey(Schema.String),
  prerequisites: Schema.optionalKey(PrerequisitesSchema),
  vpn: Schema.optionalKey(Schema.String),
});

const ObservabilityEnvTargetSchema = Schema.Struct({
  url: Schema.String,
  tokenEnvVar: Schema.optionalKey(Schema.String),
  prometheusUid: Schema.optionalKey(Schema.String),
  lokiUid: Schema.optionalKey(Schema.String),
});

const ObservabilityConfigSchema = Schema.Struct({
  environments: Schema.Record(Schema.String, ObservabilityEnvTargetSchema),
});

const AuditConfigSchema = Schema.Struct({
  retentionDays: Schema.optionalKey(Schema.Number),
  dbPath: Schema.optionalKey(Schema.String),
});

const GitHubRepoConfigSchema = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  prTitle: Schema.optionalKey(
    Schema.Struct({
      pattern: Schema.String,
      expected: Schema.String,
      example: Schema.optionalKey(Schema.String),
    }),
  ),
});

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "azure",
  "vpns",
  "kubernetes",
  "database",
  "observability",
  "logs",
  "session",
  "audit",
  "credentialGuard",
  "defaultEnvironment",
  "github",
]);

const AgentToolsConfigSchema = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  azure: Schema.optionalKey(Schema.Record(Schema.String, AzureConfigSchema)),
  vpns: Schema.optionalKey(Schema.Record(Schema.String, VpnConfigSchema)),
  kubernetes: Schema.optionalKey(Schema.Record(Schema.String, K8sConfigSchema)),
  database: Schema.optionalKey(Schema.Record(Schema.String, DatabaseConfigSchema)),
  observability: Schema.optionalKey(Schema.Record(Schema.String, ObservabilityConfigSchema)),
  logs: Schema.optionalKey(Schema.Record(Schema.String, LogsConfigSchema)),
  session: Schema.optionalKey(
    Schema.Struct({
      storagePath: Schema.String,
    }),
  ),
  audit: Schema.optionalKey(AuditConfigSchema),
  credentialGuard: Schema.optionalKey(CredentialGuardConfigSchema),
  defaultEnvironment: Schema.optionalKey(Schema.String),
  github: Schema.optionalKey(Schema.Record(Schema.String, GitHubRepoConfigSchema)),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUnknownTopLevelKeys(parsed: unknown): unknown {
  if (!isRecord(parsed)) {
    return parsed;
  }

  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => KNOWN_TOP_LEVEL_KEYS.has(key)),
  );
}

export function decodeConfig(
  parsed: unknown,
  configPath: string = "agent-tools.json5",
): AgentToolsConfig {
  const sanitized = stripUnknownTopLevelKeys(parsed);

  try {
    const decoded = Schema.decodeUnknownSync(AgentToolsConfigSchema)(sanitized);
    return decoded as AgentToolsConfig;
  } catch (error) {
    throw new Error(
      `Invalid agent-tools config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

const BASE_CONFIG_FILES = ["agent-tools.json", "agent-tools.json5"] as const;
const LOCAL_CONFIG_FILES = ["agent-tools.local.json", "agent-tools.local.json5"] as const;

async function existingFile(filePath: string): Promise<string | undefined> {
  return (await Bun.file(filePath).exists()) ? filePath : undefined;
}

async function findBaseConfigDirectory(
  startDirectory: string = process.cwd(),
): Promise<string | undefined> {
  let currentDirectory = startDirectory;

  while (true) {
    for (const fileName of BASE_CONFIG_FILES) {
      // eslint-disable-next-line eslint/no-await-in-loop -- sequential directory walk, each iteration may short-circuit
      if (await Bun.file(`${currentDirectory}/${fileName}`).exists()) {
        return currentDirectory;
      }
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

async function findConfigFiles(startDirectory: string = process.cwd()): Promise<readonly string[]> {
  const baseDirectory = await findBaseConfigDirectory(startDirectory);
  if (!baseDirectory) {
    return [];
  }

  const directories: string[] = [];
  let currentDirectory = startDirectory;
  while (true) {
    directories.push(currentDirectory);
    if (currentDirectory === baseDirectory) {
      break;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return [];
    }
    currentDirectory = parentDirectory;
  }
  directories.reverse();

  const configFiles: string[] = [];
  for (const directory of directories) {
    const fileNames =
      directory === baseDirectory
        ? [...BASE_CONFIG_FILES, ...LOCAL_CONFIG_FILES]
        : LOCAL_CONFIG_FILES;

    for (const fileName of fileNames) {
      // eslint-disable-next-line eslint/no-await-in-loop -- config precedence is directory/file order
      const filePath = await existingFile(`${directory}/${fileName}`);
      if (filePath) {
        configFiles.push(filePath);
      }
    }
  }

  return configFiles;
}

function mergeConfigValue(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) {
    return right;
  }

  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = key in merged ? mergeConfigValue(merged[key], value) : value;
  }
  return merged;
}

export async function loadConfig(): Promise<AgentToolsConfig | undefined> {
  const configPaths = await findConfigFiles();
  if (configPaths.length === 0) {
    return undefined;
  }

  let parsed: unknown = {};
  for (const configPath of configPaths) {
    // eslint-disable-next-line eslint/no-await-in-loop -- config precedence is file order
    const fileContent = await Bun.file(configPath).text();
    parsed = mergeConfigValue(parsed, Bun.JSON5.parse(fileContent));
  }

  return decodeConfig(parsed, configPaths.join(", "));
}

export class ConfigService extends Context.Service<ConfigService, AgentToolsConfig | undefined>()(
  "@agent-tools/ConfigService",
) {}

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly cause: unknown;
}> {}

export const ConfigServiceLayer = Layer.effect(
  ConfigService,
  Effect.tryPromise({
    try: () => loadConfig(),
    catch: (error) => new ConfigLoadError({ cause: error }),
  }),
);

type ProfiledSection = keyof Pick<
  AgentToolsConfig,
  "azure" | "kubernetes" | "database" | "observability" | "logs"
>;

export function getToolConfig<T>(
  config: AgentToolsConfig | undefined,
  section: ProfiledSection,
  profile?: string,
): T | undefined {
  if (!config) {
    return undefined;
  }

  const sectionData = config[section] as Record<string, T> | undefined;
  if (!sectionData) {
    return undefined;
  }

  const keys = Object.keys(sectionData);
  if (keys.length === 0) {
    return undefined;
  }

  if (profile) {
    return sectionData[profile];
  }

  if (keys.length === 1) {
    const onlyKey = keys[0];
    if (!onlyKey) {
      return undefined;
    }
    return sectionData[onlyKey];
  }

  if ("default" in sectionData) {
    return sectionData.default;
  }

  throw new Error(
    `Multiple ${section} profiles found: [${keys.join(", ")}]. Use --profile <name> to select one.`,
  );
}

export function getDefaultEnvironment(config: AgentToolsConfig | undefined): string | undefined {
  return config?.defaultEnvironment;
}

export function getGitHubConfig(
  config: AgentToolsConfig | undefined,
  profile?: string,
): GitHubRepoConfig | undefined {
  const repos = config?.github;
  if (!repos) return undefined;

  const keys = Object.keys(repos);
  if (keys.length === 0) return undefined;

  if (profile) return repos[profile];
  if ("default" in repos) return repos.default;
  if (keys.length === 1) return repos[keys[0] ?? ""];

  throw new Error(
    `Multiple github profiles found: [${keys.join(", ")}]. Use --repo <name> to select one.`,
  );
}

export function resolveGitHubRepoTarget(
  config: AgentToolsConfig | undefined,
  target?: string | null,
): string | undefined {
  if (target && target.includes("/")) {
    return target;
  }

  const repos = config?.github;
  if (!repos) return target ?? undefined;

  const keys = Object.keys(repos);
  if (target) {
    const repo = repos[target];
    if (!repo) {
      throw new Error(
        `Unknown github profile '${target}'. Available profiles: [${keys.join(", ")}]. Use --repo owner/name for an explicit repository.`,
      );
    }
    return `${repo.owner}/${repo.repo}`;
  }

  const repo = getGitHubConfig(config);
  return repo ? `${repo.owner}/${repo.repo}` : undefined;
}
