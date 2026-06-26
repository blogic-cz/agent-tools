export const DEFAULT_MERGE_STRATEGY = "squash" as const;
export const DEFAULT_DELETE_BRANCH = true as const;
export const CI_CHECK_WATCH_TIMEOUT_MS = 600_000 as const; // 10 minutes
export const GRAPHQL_PAGE_SIZE = 100 as const;
export const GH_BINARY = "gh" as const;

export const MERGE_STRATEGIES = ["squash", "merge", "rebase"] as const;

// Floor a watch --timeout at 1s so a 0 or negative value can't fire an instant timeout that skips
// the wait. Shared so the enforced duration and the "timed out after Ns" message never disagree
// (both use the clamped value, so a negative input reports "1s", not e.g. "-5s").
export const clampWatchSeconds = (seconds: number): number => Math.max(1, seconds);
