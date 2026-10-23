export type AzSecurityCheckOptions = {
  /** Empty or absent allows every resource group in the subscription. */
  allowedResourceGroups?: readonly string[];
  allowEntra?: boolean;
  allowTenantScope?: boolean;
  /** The pinned subscription. Absent, every resource ID is refused. */
  subscription?: string;
};

export type AzSecurityCheckResult = {
  allowed: boolean;
  command: string;
  argv?: string[];
  verb?: string;
  resourceGroup?: string;
  /** The command rejects --subscription, so it must not receive one. */
  omitsSubscription?: boolean;
  /** Authenticates against the default az login tenant rather than the pinned subscription's. */
  usesDefaultLoginTenant?: boolean;
  /** Log Analytics workspace GUIDs to verify against the pinned subscription before running. */
  workspaces?: string[];
  reason?: string;
  hint?: string;
};
