import { dirname } from "node:path";

import { Data, Effect, Layer, Schema, ServiceMap } from "effect";

import type { AgentToolsConfig } from "./types.ts";

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

const AzureConfigSchema = Schema.Struct({
  organization: Schema.String,
  defaultProject: Schema.String,
  timeoutMs: Schema.optionalKey(Schema.Number),
});

const K8sConfigSchema = Schema.Struct({
  clusterId: Schema.String,
  namespaces: Schema.Record(Schema.String, Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Number),
});

const DbEnvConfigSchema = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  user: Schema.String,
  database: Schema.String,
  passwordEnvVar: Schema.optionalKey(Schema.String),
});

const DatabaseConfigSchema = Schema.Struct({
  environments: Schema.Record(Schema.String, DbEnvConfigSchema),
  kubectl: Schema.optionalKey(
    Schema.Struct({
      context: Schema.String,
      namespace: Schema.String,
    }),
  ),
  tunnelTimeoutMs: Schema.optionalKey(Schema.Number),
  remotePort: Schema.optionalKey(Schema.Number),
});

const LogsConfigSchema = Schema.Struct({
  localDir: Schema.String,
  remotePath: Schema.String,
});

const AgentToolsConfigSchema = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  azure: Schema.optionalKey(Schema.Record(Schema.String, AzureConfigSchema)),
  kubernetes: Schema.optionalKey(Schema.Record(Schema.String, K8sConfigSchema)),
  database: Schema.optionalKey(Schema.Record(Schema.String, DatabaseConfigSchema)),
  logs: Schema.optionalKey(Schema.Record(Schema.String, LogsConfigSchema)),
  session: Schema.optionalKey(
    Schema.Struct({
      storagePath: Schema.String,
    }),
  ),
  credentialGuard: Schema.optionalKey(CredentialGuardConfigSchema),
  defaultEnvironment: Schema.optionalKey(Schema.String),
});

async function findConfigFile(startDirectory: string = process.cwd()): Promise<string | undefined> {
  let currentDirectory = startDirectory;

  while (true) {
    const json5Path = `${currentDirectory}/agent-tools.json5`;
    if (await Bun.file(json5Path).exists()) {
      return json5Path;
    }

    const jsonPath = `${currentDirectory}/agent-tools.json`;
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

  try {
    const decoded = Schema.decodeUnknownSync(AgentToolsConfigSchema)(parsed);
    return decoded as AgentToolsConfig;
  } catch (error) {
    throw new Error(
      `Invalid agent-tools config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export class ConfigService extends ServiceMap.Service<
  ConfigService,
  AgentToolsConfig | undefined
>()("@agent-tools/ConfigService") {}

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

type ProfiledSection = keyof Pick<AgentToolsConfig, "azure" | "kubernetes" | "database" | "logs">;

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
