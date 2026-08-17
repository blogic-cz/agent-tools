import { Schema } from "effect";

/** Azure DevOps profile configuration */
/** Azure DevOps profile, consumed by azdo-tool. */
export type AzureConfig = {
  organization: string;
  defaultProject: string;
  timeoutMs?: number;
};

/** Azure platform (PaaS) profile, consumed by az-tool. */
export type AzurePlatformConfig = {
  subscription: string;
  timeoutMs?: number;
  /**
   * Require --profile to be passed explicitly before this subscription is
   * touched. Defaults to true for profiles keyed "prod" or "production".
   */
  production?: boolean;
  /**
   * Resource groups this profile may address. Empty or absent means every
   * resource group in the subscription is allowed.
   */
  allowedResourceGroups?: string[];
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
  /** Total bounded stop-and-confirm window in milliseconds. */
  disconnectTimeoutMs?: number;
  /** Managed VPN reuse window after the last lease. Defaults to 30000; 0 disconnects immediately. */
  idleDisconnectMs?: number;
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
  /**
   * Timeout in milliseconds for the cheap Kubernetes API-server reachability probe run
   * before each command. When the cluster API is unreachable (VPN down / off the office
   * network, or the API degraded) a real kubectl command hangs until `timeoutMs`; the
   * probe lets it fail fast with a clear message instead. Set to 0 to disable. Defaults to 2000.
   */
  apiProbeTimeoutMs?: number;
};

/** Single database environment connection details */
export type DbEnvConfig = ProfilePrerequisites & {
  host: string;
  port: number;
  user: string;
  database: string;
  /** Plain-text password for local development. Prefer passwordEnvVar for non-local environments. */
  password?: string;
  /** Name of environment variable holding the password, e.g. "DB_TEST_PWD" */
  passwordEnvVar?: string;
  /**
   * Name of an environment variable that overrides `host`, e.g. "APP_POSTGRES_HOST".
   *
   * Override with fallback, deliberately unlike `passwordEnvVar`: an unset or empty variable is
   * not an error, it keeps the literal `host` above. The variable usually exists only in a
   * per-worktree environment, and the main checkout must keep working from the literal.
   */
  hostEnvVar?: string;
  /**
   * Name of an environment variable that overrides `port`, e.g. "APP_POSTGRES_PORT".
   *
   * Same override-with-fallback rule as `hostEnvVar`: unset or empty keeps the literal `port`,
   * because only a worktree environment publishes its own port. A variable that *is* set but is
   * not an integer in 1..65535 fails instead of falling back — a silent fallback would query the
   * wrong database while the caller believes the override applied.
   */
  portEnvVar?: string;
};

/** SQL mutation operation that can be explicitly allowed for a database environment. */
export const DbMutationOperationSchema = Schema.Literals(["insert", "update", "delete"]);
export type DbMutationOperation = Schema.Schema.Type<typeof DbMutationOperationSchema>;
export type DbAllowedMutationTargets = Partial<Record<DbMutationOperation, readonly string[]>>;

/** Database profile configuration */
export type DatabaseConfig = ProfilePrerequisites & {
  /** Named database environments, e.g. { local: {...}, test: {...}, prod: {...} } */
  environments: Record<string, DbEnvConfig>;
  /** Explicitly allowed SQL mutation operations per environment. Non-local environments default to read-only. */
  allowedMutations?: Record<string, readonly DbMutationOperation[]>;
  allowedMutationTargets?: Record<string, DbAllowedMutationTargets>;
  kubectl?: {
    /** Optional kubeconfig path. Supports ${ENV_VAR} templates. */
    kubeconfig?: string;
    context: string;
    namespace: string;
    service?: string;
  };
  tunnelTimeoutMs?: number;
  /**
   * Timeout in milliseconds for the cheap Kubernetes API-server reachability probe
   * run before attempting a tunnel. When the API server is unreachable (VPN down and
   * not on the office network) `kubectl port-forward` hangs silently on TCP connect, so
   * a short probe lets the direct (no-VPN) attempt fail fast and fall back to connecting
   * the VPN instead of waiting out `tunnelTimeoutMs`. Set to 0 to disable the probe.
   * Defaults to 2000.
   */
  apiProbeTimeoutMs?: number;
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
export type GitHubPrTitlePolicy = {
  pattern: string;
  expected: string;
  example?: string;
};

export type GitHubRepoConfig = {
  owner: string;
  repo: string;
  prTitle?: GitHubPrTitlePolicy;
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
  /** Named Azure platform profiles. e.g. { default: { subscription: "..." } } */
  azurePlatform?: Record<string, AzurePlatformConfig>;
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
