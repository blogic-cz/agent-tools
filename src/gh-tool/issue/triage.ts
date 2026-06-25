import { Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";

import type { CheckResult, IssueComment, PRViewInfo, ReviewThread } from "#gh/types";

import { formatOption, logFormatted } from "#shared";
import { GitHubService } from "#gh/service";
import { fetchReviewTriage } from "#gh/pr/commands";

import { fetchIssueComments } from "./core";

const repoOption = Flag.string("repo").pipe(
  Flag.withDescription("Target repository profile name or owner/name"),
  Flag.optional,
);

const withRepo = <A, E, R>(repo: Option.Option<string>, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const gh = yield* GitHubService;
    return yield* gh.withRepoTarget(Option.getOrNull(repo), effect);
  });

const TriageVerbosity = Schema.Literals(["compact", "full"]);
type TriageVerbosity = typeof TriageVerbosity.Type;

type RawTriageIssue = {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  author: { login: string };
  body: string;
  createdAt: string;
  closedAt: string | null;
};

type TriageIssue = {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  assignees: string[];
  author: string;
  createdAt: string;
  closedAt: string | null;
};

type CompactIssueTriage = {
  issue: TriageIssue;
  body: string;
  commentsCount: number;
  latestComment: IssueComment | null;
};

type FullIssueTriage = {
  issue: TriageIssue;
  body: string;
  commentsCount: number;
  comments: IssueComment[];
};

type ReviewTriageSnapshot = {
  readonly classification: {
    readonly status: "clear" | "needs_investigation";
    readonly reasons: readonly string[];
  };
  readonly info: PRViewInfo;
  readonly unresolvedThreads: readonly ReviewThread[];
  readonly visibleOpenThreads: readonly ReviewThread[];
  readonly summary: {
    readonly visibleOpenReviewThreadsCount: number;
    readonly unrepliedReviewThreadsCount: number;
    readonly unresolvedReviewThreadsCount: number;
    readonly latestIssueComment: IssueComment | null;
  };
  readonly checks: readonly CheckResult[];
};

type IssueSnapshotClassification = {
  readonly status: "clear" | "needs_investigation";
  readonly reasons: readonly string[];
};

type IssueSnapshot = {
  readonly issue: TriageIssue;
  readonly body: string;
  readonly commentsCount: number;
  readonly comments: readonly IssueComment[];
  readonly eligible: boolean;
  readonly linkedPullRequestNumbers: readonly number[];
  readonly linkedPullRequests: readonly ReviewTriageSnapshot[];
  readonly classification: IssueSnapshotClassification;
};

function truncateBody(body: string, maxLength = 500): string {
  if (body.length <= maxLength) return body;
  return body.slice(0, maxLength) + "…";
}

function getLatestComment(comments: IssueComment[]): IssueComment | null {
  if (comments.length === 0) {
    return null;
  }

  return comments.reduce((current, next) =>
    new Date(next.createdAt).getTime() > new Date(current.createdAt).getTime() ? next : current,
  );
}

export const fetchIssueTriage = Effect.fn("issue.fetchIssueTriage")(function* (opts: {
  issue: number;
  verbosity: TriageVerbosity;
}) {
  const gh = yield* GitHubService;

  const [rawIssue, comments] = yield* Effect.all(
    [
      gh.runGhJson<RawTriageIssue>([
        "issue",
        "view",
        String(opts.issue),
        "--json",
        "number,title,state,url,labels,assignees,author,body,createdAt,closedAt",
      ]),
      fetchIssueComments(opts.issue, null, null, null),
    ],
    { concurrency: "unbounded" },
  );

  const issue: TriageIssue = {
    number: rawIssue.number,
    title: rawIssue.title,
    state: rawIssue.state,
    url: rawIssue.url,
    labels: rawIssue.labels.map((label) => label.name),
    assignees: rawIssue.assignees.map((assignee) => assignee.login),
    author: rawIssue.author.login,
    createdAt: rawIssue.createdAt,
    closedAt: rawIssue.closedAt,
  };

  if (opts.verbosity === "full") {
    const result: FullIssueTriage = {
      issue,
      body: rawIssue.body,
      commentsCount: comments.length,
      comments,
    };

    return result;
  }

  const result: CompactIssueTriage = {
    issue,
    body: truncateBody(rawIssue.body),
    commentsCount: comments.length,
    latestComment: getLatestComment(comments),
  };

  return result;
});

export const parseIssueNumbers = (input: string): readonly number[] =>
  input
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((number) => Number.isInteger(number) && number > 0);

export const collectLinkedPullRequestNumbers = (
  body: string,
  comments: readonly { readonly body: string }[],
): readonly number[] => {
  const text = [body, ...comments.map((comment) => comment.body)].join("\n");
  const numbers = new Set<number>();
  for (const match of text.matchAll(/(?:pull\/|\/pulls\/)(\d+)|\bPR\s+#?(\d+)/gi)) {
    const number = Number.parseInt(match[1] ?? match[2] ?? "", 10);
    if (Number.isInteger(number) && number > 0) {
      numbers.add(number);
    }
  }

  return Array.from(numbers).toSorted((left, right) => left - right);
};

function classifyIssueSnapshot(opts: {
  eligible: boolean;
  linkedPullRequestNumbers: readonly number[];
  linkedPullRequests: readonly ReviewTriageSnapshot[];
}): IssueSnapshotClassification {
  const reasons = [
    ...(!opts.eligible ? ["not_owned_by_automation_owner"] : []),
    ...(opts.eligible && opts.linkedPullRequestNumbers.length === 0
      ? ["no_linked_pull_request"]
      : []),
    ...opts.linkedPullRequests.flatMap((pr) =>
      pr.classification.status === "needs_investigation"
        ? pr.classification.reasons.map((reason) => `linked_pr_${pr.info.number}_${reason}`)
        : [],
    ),
  ];
  return { status: reasons.length > 0 ? "needs_investigation" : "clear", reasons };
}

export const fetchIssueSnapshot = Effect.fn("issue.fetchIssueSnapshot")(function* (opts: {
  issue: number;
  owner: string | null;
}) {
  const triage = yield* fetchIssueTriage({ issue: opts.issue, verbosity: "full" });
  if (!("comments" in triage)) {
    throw new Error("Expected full issue triage");
  }

  const owner = opts.owner?.toLowerCase() ?? null;
  const eligible =
    owner !== null &&
    triage.issue.assignees.length === 1 &&
    triage.issue.assignees[0]?.toLowerCase() === owner;
  const linkedPullRequestNumbers = collectLinkedPullRequestNumbers(triage.body, triage.comments);
  const linkedPullRequests = eligible
    ? yield* Effect.all(
        linkedPullRequestNumbers.map((prNumber) => fetchReviewTriage(prNumber)),
        { concurrency: "unbounded" },
      )
    : [];
  const classification = classifyIssueSnapshot({
    eligible,
    linkedPullRequestNumbers,
    linkedPullRequests,
  });

  const result: IssueSnapshot = {
    issue: triage.issue,
    body: triage.body,
    commentsCount: triage.commentsCount,
    comments: triage.comments,
    eligible,
    linkedPullRequestNumbers,
    linkedPullRequests,
    classification,
  };
  return result;
});

export const fetchIssueSnapshotBatch = Effect.fn("issue.fetchIssueSnapshotBatch")(function* (opts: {
  issues: readonly number[];
  owner: string | null;
}) {
  return yield* Effect.all(
    opts.issues.map((issue) => fetchIssueSnapshot({ issue, owner: opts.owner })),
    { concurrency: "unbounded" },
  );
});

export const issueTriageCommand = Command.make(
  "triage",
  {
    format: formatOption,
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number")),
    repo: repoOption,
    verbosity: Flag.choice("verbosity", ["compact", "full"] as const).pipe(
      Flag.withDescription("Output detail level: compact or full"),
      Flag.withDefault("compact"),
    ),
  },
  ({ format, issue, repo, verbosity }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const result = yield* fetchIssueTriage({ issue, verbosity });
        yield* logFormatted(result, format);
      }),
    ),
).pipe(
  Command.withDescription("Composite: fetch issue details and discussion comments in one call"),
);

export const issueSnapshotBatchCommand = Command.make(
  "snapshot-batch",
  {
    format: formatOption,
    issues: Flag.string("issues").pipe(Flag.withDescription("Comma-separated issue numbers")),
    owner: Flag.string("owner").pipe(
      Flag.withDescription("Automation owner login used to mark eligible issues"),
      Flag.optional,
    ),
    repo: repoOption,
  },
  ({ format, issues, owner, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const result = yield* fetchIssueSnapshotBatch({
          issues: parseIssueNumbers(issues),
          owner: Option.getOrNull(owner),
        });
        yield* logFormatted(result, format);
      }),
    ),
).pipe(
  Command.withDescription(
    "Composite: fetch full issue triage plus linked PR review-triage for multiple issues",
  ),
);
