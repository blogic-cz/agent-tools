export type AzSecurityCheckOptions = {
  /** Empty or absent allows every resource group in the subscription. */
  allowedResourceGroups?: readonly string[];
};

export type AzSecurityCheckResult = {
  allowed: boolean;
  command: string;
  argv?: string[];
  verb?: string;
  resourceGroup?: string;
  reason?: string;
  hint?: string;
};
