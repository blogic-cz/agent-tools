import type { Op } from "./keys";

export type CacheClass =
  | { readonly kind: "immutable" }
  | { readonly kind: "ttl" | "etag"; readonly ttlMs: number }
  | { readonly kind: "gated"; readonly ttlMs: number; readonly maxAgeMs: number }
  | { readonly kind: "passthrough" };

export const OPS = {
  prHead: { kind: "etag", ttlMs: 5000 },
  checkSignal: { kind: "etag", ttlMs: 5000 },
  prView: { kind: "gated", ttlMs: 5000, maxAgeMs: 15000 },
  prChecks: { kind: "gated", ttlMs: 5000, maxAgeMs: 60000 },
  prList: { kind: "ttl", ttlMs: 15000 },
  prComments: { kind: "etag", ttlMs: 15000 },
  prReviews: { kind: "etag", ttlMs: 15000 },
  reviewThreads: { kind: "gated", ttlMs: 5000, maxAgeMs: 60000 },
  lastHumanReviewer: { kind: "ttl", ttlMs: 15000 },
  issueView: { kind: "ttl", ttlMs: 30000 },
  issueList: { kind: "ttl", ttlMs: 15000 },
  issueComments: { kind: "etag", ttlMs: 15000 },
  runList: { kind: "ttl", ttlMs: 15000 },
  runView: { kind: "ttl", ttlMs: 15000 },
  runJobs: { kind: "ttl", ttlMs: 15000 },
  completedAttemptJobs: { kind: "immutable" },
  runLog: { kind: "ttl", ttlMs: 15000 },
  jobLog: { kind: "passthrough" },
  annotations: { kind: "passthrough" },
  jobIdentity: { kind: "immutable" },
  commitAuthor: { kind: "ttl", ttlMs: 300000 },
} as const satisfies Record<Op, CacheClass>;
