import { Command, Flag } from "effect/unstable/cli";
import { Effect, Option, Schema } from "effect";

import type { IssueComment } from "#gh/types";

import { formatOption, logFormatted } from "#shared";
import { GitHubService } from "#gh/service";

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
