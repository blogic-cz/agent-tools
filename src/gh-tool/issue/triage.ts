import { Command, Flag } from "effect/unstable/cli";
import { Effect } from "effect";

import { formatOption, logFormatted } from "#shared";
import { GitHubService } from "#gh/service";

// ---------------------------------------------------------------------------
// Raw types (gh CLI JSON output)
// ---------------------------------------------------------------------------

type RawTriageIssue = {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  author: { login: string };
  body: string;
  comments: Array<unknown>;
  createdAt: string;
};

type RawTriagePR = {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: Array<{ name: string }>;
  author: { login: string };
  body: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string;
  statusCheckRollup: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    context: string;
  }>;
};

// ---------------------------------------------------------------------------
// Classification types
// ---------------------------------------------------------------------------

type IssueClassification = "QUESTION" | "BUG" | "FEATURE" | "OTHER";
type PRClassification = "BUGFIX" | "OTHER";
type Confidence = "HIGH" | "MEDIUM" | "LOW";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

type TriageIssue = {
  number: number;
  title: string;
  author: string;
  labels: string[];
  classification: IssueClassification;
  confidence: Confidence;
  body: string;
  commentsCount: number;
  createdAt: string;
  url: string;
};

type TriagePR = {
  number: number;
  title: string;
  author: string;
  labels: string[];
  classification: PRClassification;
  confidence: Confidence;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string;
  ciStatus: string;
  body: string;
  url: string;
};

type TriageSummary = {
  repo: string;
  fetchedAt: string;
  issues: TriageIssue[];
  prs: TriagePR[];
  summary: {
    totalIssues: number;
    totalPRs: number;
    issuesByType: Record<string, number>;
    prsByType: Record<string, number>;
  };
};

// ---------------------------------------------------------------------------
// Classification logic (pure functions)
// ---------------------------------------------------------------------------

function classifyIssue(
  labels: string[],
  title: string,
): { classification: IssueClassification; confidence: Confidence } {
  const lowerLabels = new Set(labels.map((l) => l.toLowerCase()));
  const lowerTitle = title.toLowerCase();

  // Labels first — HIGH confidence
  if (lowerLabels.has("bug")) {
    return { classification: "BUG", confidence: "HIGH" };
  }
  if (lowerLabels.has("question") || lowerLabels.has("help wanted")) {
    return { classification: "QUESTION", confidence: "HIGH" };
  }
  if (
    lowerLabels.has("enhancement") ||
    lowerLabels.has("feature") ||
    lowerLabels.has("feature request")
  ) {
    return { classification: "FEATURE", confidence: "HIGH" };
  }

  // Title patterns — MEDIUM confidence
  if (/\[bug\]/i.test(title) || /^bug:/i.test(title) || /^fix:/i.test(title)) {
    return { classification: "BUG", confidence: "MEDIUM" };
  }
  if (
    lowerTitle.includes("?") ||
    /\[question\]/i.test(title) ||
    /how to/i.test(title) ||
    /is it possible/i.test(title)
  ) {
    return { classification: "QUESTION", confidence: "MEDIUM" };
  }
  if (
    /\[feature\]/i.test(title) ||
    /\[enhancement\]/i.test(title) ||
    /\[rfe\]/i.test(title) ||
    /^feat:/i.test(title)
  ) {
    return { classification: "FEATURE", confidence: "MEDIUM" };
  }

  // Default — LOW confidence
  return { classification: "OTHER", confidence: "LOW" };
}

function classifyPR(
  labels: string[],
  title: string,
  branch: string,
): { classification: PRClassification; confidence: Confidence } {
  const lowerLabels = new Set(labels.map((l) => l.toLowerCase()));

  // Labels first — HIGH confidence
  if (lowerLabels.has("bug")) {
    return { classification: "BUGFIX", confidence: "HIGH" };
  }

  // Title/branch patterns — MEDIUM confidence
  if (/^fix/i.test(title)) {
    return { classification: "BUGFIX", confidence: "MEDIUM" };
  }
  if (branch.startsWith("fix/") || branch.startsWith("bugfix/")) {
    return { classification: "BUGFIX", confidence: "MEDIUM" };
  }

  // Default — LOW confidence
  return { classification: "OTHER", confidence: "LOW" };
}

function aggregateCIStatus(checks: RawTriagePR["statusCheckRollup"]): string {
  if (checks.length === 0) return "UNKNOWN";
  if (checks.some((c) => c.conclusion === "failure")) return "FAIL";
  if (checks.some((c) => c.status !== "COMPLETED")) return "PENDING";
  return "PASS";
}

function truncateBody(body: string, maxLength = 500): string {
  if (body.length <= maxLength) return body;
  return body.slice(0, maxLength) + "…";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const fetchTriageSummary = Effect.fn("issue.fetchTriageSummary")(function* (opts: {
  state: string;
  limit: number;
}) {
  const gh = yield* GitHubService;
  const repoInfo = yield* gh.getRepoInfo();

  // Parallel fetch: issues + PRs
  const [rawIssues, rawPRs] = yield* Effect.all(
    [
      gh.runGhJson<RawTriageIssue[]>([
        "issue",
        "list",
        "--state",
        opts.state,
        "--limit",
        String(opts.limit),
        "--json",
        "number,title,state,url,labels,assignees,author,body,comments,createdAt",
      ]),
      gh.runGhJson<RawTriagePR[]>([
        "pr",
        "list",
        "--state",
        opts.state,
        "--limit",
        String(opts.limit),
        "--json",
        "number,title,state,url,labels,author,body,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup",
      ]),
    ],
    { concurrency: "unbounded" },
  );

  // Classify + transform issues
  const issues: TriageIssue[] = rawIssues.map((issue) => {
    const labelNames = issue.labels.map((l) => l.name);
    const { classification, confidence } = classifyIssue(labelNames, issue.title);

    return {
      number: issue.number,
      title: issue.title,
      author: issue.author.login,
      labels: labelNames,
      classification,
      confidence,
      body: truncateBody(issue.body),
      commentsCount: issue.comments.length,
      createdAt: issue.createdAt,
      url: issue.url,
    };
  });

  // Classify + transform PRs
  const prs: TriagePR[] = rawPRs.map((pr) => {
    const labelNames = pr.labels.map((l) => l.name);
    const { classification, confidence } = classifyPR(labelNames, pr.title, pr.headRefName);

    return {
      number: pr.number,
      title: pr.title,
      author: pr.author.login,
      labels: labelNames,
      classification,
      confidence,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      reviewDecision: pr.reviewDecision,
      ciStatus: aggregateCIStatus(pr.statusCheckRollup ?? []),
      body: truncateBody(pr.body),
      url: pr.url,
    };
  });

  // Build summary counters
  const issuesByType: Record<string, number> = {};
  for (const issue of issues) {
    issuesByType[issue.classification] = (issuesByType[issue.classification] ?? 0) + 1;
  }

  const prsByType: Record<string, number> = {};
  for (const pr of prs) {
    prsByType[pr.classification] = (prsByType[pr.classification] ?? 0) + 1;
  }

  const result: TriageSummary = {
    repo: `${repoInfo.owner}/${repoInfo.name}`,
    fetchedAt: new Date().toISOString(),
    issues,
    prs,
    summary: {
      totalIssues: issues.length,
      totalPRs: prs.length,
      issuesByType,
      prsByType,
    },
  };

  return result;
});

// ---------------------------------------------------------------------------
// CLI Command
// ---------------------------------------------------------------------------

export const issueTriageSummaryCommand = Command.make(
  "triage-summary",
  {
    format: formatOption,
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Maximum number of issues and PRs to fetch"),
      Flag.withDefault(100),
    ),
    state: Flag.choice("state", ["open", "closed", "all"]).pipe(
      Flag.withDescription("Filter by state: open, closed, all"),
      Flag.withDefault("open"),
    ),
  },
  ({ format, limit, state }) =>
    Effect.gen(function* () {
      const summary = yield* fetchTriageSummary({ limit, state });
      yield* logFormatted(summary, format);
    }),
).pipe(
  Command.withDescription(
    "Composite: fetch all issues + PRs, classify each, return structured triage summary",
  ),
);
