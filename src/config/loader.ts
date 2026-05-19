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
});

const DatabaseConfigSchema = Schema.Struct({
  environments: Schema.Record(Schema.String, DbEnvConfigSchema),
  allowedMutations: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Array(DbMutationOperationSchema)),
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

function stripUnknownTopLevelKeys(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
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

async function findConfigFile(startDirectory: string = process.cwd()): Promise<string | undefined> {
  let currentDirectory = startDirectory;

  while (true) {
    const json5Path = `${currentDirectory}/agent-tools.json5`;
    // eslint-disable-next-line eslint/no-await-in-loop -- sequential directory walk, each iteration may short-circuit
    if (await Bun.file(json5Path).exists()) {
      return json5Path;
    }

    const jsonPath = `${currentDirectory}/agent-tools.json`;
    // eslint-disable-next-line eslint/no-await-in-loop -- sequential directory walk, each iteration may short-circuit
    if (await Bun.file(jsonPath).exists()) {
      return jsonPath;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

export async function loadConfig(): Promise<AgentToolsConfig | undefined> {
  const configPath = await findConfigFile();
  if (!configPath) {
    return undefined;
  }

  const fileContent = await Bun.file(configPath).text();
  const parsed = Bun.JSON5.parse(fileContent);

  return decodeConfig(parsed, configPath);
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
  if (keys.length === 1) return repos[keys[0] ?? ""];
  if ("default" in repos) return repos.default;

  throw new Error(
    `Multiple github profiles found: [${keys.join(", ")}]. Use --repo <name> to select one.`,
  );
}
