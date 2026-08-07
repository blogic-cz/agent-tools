// Parsed in-process instead of `sh -c "... | jq -r ... | head -1"`: that pipeline needs sh, jq and
// head on PATH, which a stock Windows install lacks, and a missing one looked like "no context
// found" rather than a missing-tool error.

type KubeContextEntry = { name: string; cluster: string };

export const parseKubeConfigView = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readContexts = (view: unknown): KubeContextEntry[] => {
  if (!isRecord(view) || !Array.isArray(view.contexts)) {
    return [];
  }

  return view.contexts.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !isRecord(entry.context)) {
      return [];
    }

    const cluster = entry.context.cluster;
    return typeof cluster === "string" ? [{ name: entry.name, cluster }] : [];
  });
};

const readClusterServers = (view: unknown): Map<string, string> => {
  const servers = new Map<string, string>();
  if (!isRecord(view) || !Array.isArray(view.clusters)) {
    return servers;
  }

  for (const entry of view.clusters) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !isRecord(entry.cluster)) {
      continue;
    }

    const server = entry.cluster.server;
    if (typeof server === "string") {
      servers.set(entry.name, server);
    }
  }

  return servers;
};

export const selectKubeContext = (view: unknown, clusterId: string): string | undefined => {
  const contexts = readContexts(view);

  const exactClusterNameMatch = contexts.find((entry) => entry.cluster === clusterId);
  if (exactClusterNameMatch !== undefined) {
    return exactClusterNameMatch.name;
  }

  const servers = readClusterServers(view);
  const serverUrlMatch = contexts.find((entry) => servers.get(entry.cluster)?.includes(clusterId));

  return serverUrlMatch?.name;
};
