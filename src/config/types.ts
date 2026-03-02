/** Azure DevOps profile configuration */
export type AzureConfig = {
  organization: string;
  defaultProject: string;
  timeoutMs?: number;
};

/** Kubernetes cluster profile configuration */
export type K8sConfig = {
  clusterId: string;
  /** Named namespaces, e.g. { test: "my-app-test", prod: "my-app-prod" } */
  namespaces: Record<string, string>;
  timeoutMs?: number;
};

/** Single database environment connection details */
export type DbEnvConfig = {
  host: string;
  port: number;
  user: string;
  database: string;
  /** Plain-text password for local development. Prefer passwordEnvVar for non-local environments. */
  password?: string;
  /** Name of environment variable holding the password, e.g. "DB_TEST_PWD" */
  passwordEnvVar?: string;
};

/** Database profile configuration */
export type DatabaseConfig = {
  /** Named database environments, e.g. { local: {...}, test: {...}, prod: {...} } */
  environments: Record<string, DbEnvConfig>;
  kubectl?: {
    context: string;
    namespace: string;
  };
  tunnelTimeoutMs?: number;
  remotePort?: number;
};

/** Logs profile configuration */
export type LogsConfig = {
  localDir: string;
  remotePath: string;
};

export type CliToolOverride = {
  tool: string;
  suggestion: string;
};

/** Credential guard config - merged with built-in defaults */
export type CredentialGuardConfig = {
  additionalBlockedPaths?: string[];
  additionalAllowedPaths?: string[];
  additionalBlockedCliTools?: CliToolOverride[];
  additionalDangerousBashPatterns?: string[];
};

/**
 * Root agent-tools configuration.
 *
 * Each tool section (azure, kubernetes, database, logs) is a Record<string, ToolConfig>
 * of named profiles. Tools select a profile via the --profile <name> flag (default = "default" key).
 * If only one profile exists, it is used automatically.
 *
 * session and credentialGuard are global - not per-profile.
 */
export type AgentToolsConfig = {
  $schema?: string;
  /** Named Azure DevOps profiles. e.g. { default: { organization: "...", defaultProject: "..." } } */
  azure?: Record<string, AzureConfig>;
  /** Named Kubernetes cluster profiles. e.g. { default: {...}, staging: {...} } */
  kubernetes?: Record<string, K8sConfig>;
  /** Named database profiles. e.g. { default: {...}, analytics: {...} } */
  database?: Record<string, DatabaseConfig>;
  /** Named logs profiles. e.g. { default: { localDir: "...", remotePath: "..." } } */
  logs?: Record<string, LogsConfig>;
  /** Global session config (not per-profile) */
  session?: {
    storagePath: string;
  };
  /** Global credential guard config (merged with built-in defaults, not per-profile) */
  credentialGuard?: CredentialGuardConfig;
  /** Optional default environment name (local|test|prod) used by tools when no --env flag is provided */
  defaultEnvironment?: string;
};
