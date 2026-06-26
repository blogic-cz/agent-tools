/**
 * Shared kubectl API-server reachability probe, used by every VPN-gated tool
 * (db-tool, k8s-tool) to fail fast instead of hanging on a silently unreachable cluster.
 *
 * Hitting `/version` via `--raw` is the cheapest authenticated round-trip; `--request-timeout`
 * bounds it so an unreachable server (VPN down / off the office network, or the cluster API
 * degraded) fails in ~`timeoutMs` with a clear message instead of waiting out the tool's full
 * command/tunnel timeout.
 */
export function buildApiProbeArgs(
  kubeconfig: string | undefined,
  context: string,
  timeoutMs: number,
): string[] {
  return [
    ...(kubeconfig ? ["--kubeconfig", kubeconfig] : []),
    "--context",
    context,
    "get",
    "--raw=/version",
    `--request-timeout=${timeoutMs}ms`,
  ];
}
