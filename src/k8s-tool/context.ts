/** Kept free of I/O so the caller spawns kubectl itself instead of piping through sh, jq and head. */

type KubeContextEntry = {
  readonly name?: unknown;
  readonly context?: { readonly cluster?: unknown };
};

type KubeClusterEntry = {
  readonly name?: unknown;
  readonly cluster?: { readonly server?: unknown };
};

type KubeConfigView = {
  readonly contexts?: readonly KubeContextEntry[];
  readonly clusters?: readonly KubeClusterEntry[];
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export const parseKubeConfigView = (stdout: string): KubeConfigView | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null ? (parsed as KubeConfigView) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Two strategies, in the same order the previous jq pipelines used:
 * an exact context.cluster match first, then a cluster whose server URL contains the id.
 * Returns the first match so a multi-context kubeconfig resolves the same way it did before.
 */
export const selectKubeContext = (
  view: KubeConfigView | undefined,
  clusterId: string,
): string | undefined => {
  if (!view) {
    return undefined;
  }

  const contexts = view.contexts ?? [];

  for (const entry of contexts) {
    const name = asString(entry.name);
    if (name !== undefined && asString(entry.context?.cluster) === clusterId) {
      return name;
    }
  }

  const clusters = view.clusters ?? [];

  for (const entry of contexts) {
    const name = asString(entry.name);
    const clusterName = asString(entry.context?.cluster);
    if (name === undefined || clusterName === undefined) {
      continue;
    }

    const matchesServer = clusters.some(
      (cluster) =>
        asString(cluster.name) === clusterName &&
        (asString(cluster.cluster?.server) ?? "").includes(clusterId),
    );

    if (matchesServer) {
      return name;
    }
  }

  return undefined;
};
