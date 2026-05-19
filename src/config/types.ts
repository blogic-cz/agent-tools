/** Azure DevOps profile configuration */
export type AzureConfig = {
  organization: string;
  defaultProject: string;
  timeoutMs?: number;
};

export type CleanupPolicy = "leave-running" | "stop-if-started";

export type VpnPrerequisite = {
  type: "vpn";
  key: string;
  cleanup?: CleanupPolicy;
};

export type MacosScutilVpnDriverConfig = {
  type: "macos-scutil";
  serviceName?: string;
  /** Name of environment variable holding the IPSec shared secret for scutil --nc start. */
  secretEnvVar?: string;
};

export type LinuxNmcliVpnDriverConfig = {
  type: "linux-nmcli";
  connectionName?: string;
};

export type WindowsRasdialVpnDriverConfig = {
  type: "windows-rasdial";
  entryName?: string;
};

export type VpnDriverConfig =
  | MacosScutilVpnDriverConfig
  | LinuxNmcliVpnDriverConfig
  | WindowsRasdialVpnDriverConfig;

export type VpnConfig = {
  name: string;
  /** Defaults to true. Auto maps name to the current OS driver deterministically. */
  auto?: boolean;
  defaultCleanup?: CleanupPolicy;
  connectTimeoutMs?: number;
  disconnectTimeoutMs?: number;
  cooldownMs?: number;
  leaseTtlMs?: number;
  /** Name of environment variable holding the VPN shared secret for supported drivers. */
  secretEnvVar?: string;
  drivers?: {
    darwin?: MacosScutilVpnDriverConfig;
    linux?: LinuxNmcliVpnDriverConfig;
    win32?: WindowsRasdialVpnDriverConfig;
  };
  /** Explicit current-platform driver, required when auto is false and no per-OS driver is available. */
  driver?: VpnDriverConfig;
};

export type ProfilePrerequisites = {
  prerequisites?: readonly VpnPrerequisite[];
  /** Convenience input sugar; normalize to prerequisites before execution. */
  vpn?: string;
};

/** Kubernetes cluster profile configuration */
export type K8sConfig = ProfilePrerequisites & {
  /** Optional kubeconfig path. Supports ${ENV_VAR} templates. */
  kubeconfig?: string;
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
export type DatabaseConfig = ProfilePrerequisites & {
  /** Named database environments, e.g. { local: {...}, test: {...}, prod: {...} } */
  environments: Record<string, DbEnvConfig>;
  kubectl?: {
    /** Optional kubeconfig path. Supports ${ENV_VAR} templates. */
    kubeconfig?: string;
    context: string;
    namespace: string;
    service?: string;
  };
  tunnelTimeoutMs?: number;
  remotePort?: number;
};

/** Logs profile configuration */
export type LogsConfig = ProfilePrerequisites & {
  localDir: string;
  remotePath: string;
  kubernetesProfile?: string;
};

/** Single observability environment connection details */
export type ObservabilityEnvTarget = {
  url: string;
  tokenEnvVar?: string;
  prometheusUid?: string;
  lokiUid?: string;
};

/** Observability profile configuration */
export type ObservabilityConfig = {
  environments: Record<string, ObservabilityEnvTarget>;
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

export type AuditConfig = {
  retentionDays?: number;
  dbPath?: string;
};

/** Single GitHub repository configuration */
export type GitHubRepoConfig = {
  owner: string;
  repo: string;
};

/**
 * Root agent-tools configuration.
 *
 * Each tool section (azure, kubernetes, database, logs) is a Record<string, ToolConfig>
 * of named profiles. Tools select a profile via the --profile <name> flag (default = "default" key).
 * If only one profile exists, it is used automatically.
 *
 * session, credentialGuard, and audit are global - not per-profile.
 */
export type AgentToolsConfig = {
  $schema?: string;
  /** Named Azure DevOps profiles. e.g. { default: { organization: "...", defaultProject: "..." } } */
  azure?: Record<string, AzureConfig>;
  /** Named VPN definitions referenced by profile prerequisites. */
  vpns?: Record<string, VpnConfig>;
  /** Named Kubernetes cluster profiles. e.g. { default: {...}, staging: {...} } */
  kubernetes?: Record<string, K8sConfig>;
  /** Named database profiles. e.g. { default: {...}, analytics: {...} } */
  database?: Record<string, DatabaseConfig>;
  /** Named logs profiles. e.g. { default: { localDir: "...", remotePath: "..." } } */
  logs?: Record<string, LogsConfig>;
  /** Named observability profiles. e.g. { default: { environments: { local: {...}, prod: {...} } } } */
  observability?: Record<string, ObservabilityConfig>;
  /** Global session config (not per-profile) */
  session?: {
    storagePath: string;
  };
  audit?: AuditConfig;
  /** Global credential guard config (merged with built-in defaults, not per-profile) */
  credentialGuard?: CredentialGuardConfig;
  /** Optional default environment name (local|test|prod) used by tools when no --env flag is provided */
  defaultEnvironment?: string;
  /** Named GitHub repository profiles. e.g. { default: { owner: "...", repo: "..." } } */
  github?: Record<string, GitHubRepoConfig>;
};
