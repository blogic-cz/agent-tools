import { Effect } from "effect";

import { GitHubService } from "#gh/service";

import type { StackMember, StackView } from "#gh/types";

type StacksListResponse = Array<{ number: number }>;

type StackResponse = {
  number: number;
  base: { ref: string };
  open: boolean;
  pull_requests: Array<{
    number: number;
    title: string;
    state: "open" | "closed";
    merged_at: string | null;
    draft: boolean;
    html_url: string;
    head: { ref: string };
    base: { ref: string };
  }>;
};

export const readStack = Effect.fn("pr.readStack")(function* (opts: { pr: number }) {
  const gh = yield* GitHubService;
  const repo = yield* gh.getRepoInfo();
  const base = `repos/${repo.owner}/${repo.name}`;

  const unstacked: StackView = {
    pr: opts.pr,
    isStacked: false,
    stackNumber: null,
    baseRef: null,
    members: [],
  };

  // A 404 is the repository having no stacks surface at all, which reads the same as a PR
  // that belongs to no stack. Every caller gets that reading from here, not its own.
  const stacks = yield* gh
    .apiRequest<StacksListResponse>({ path: `${base}/stacks?pull_request=${opts.pr}` })
    .pipe(Effect.catchTag("GitHubNotFoundError", () => Effect.succeed(null)));

  if (stacks === null) {
    return unstacked;
  }

  const stackNumber = stacks.body?.[0]?.number;
  if (stackNumber === undefined) {
    return unstacked;
  }

  const stack = yield* gh.apiRequest<StackResponse>({ path: `${base}/stacks/${stackNumber}` });

  const members: StackMember[] = stack.body.pull_requests.map((member, index) => ({
    position: index + 1,
    number: member.number,
    title: member.title,
    headRefName: member.head.ref,
    baseRefName: member.base.ref,
    state: member.merged_at === null ? member.state : "merged",
    isDraft: member.draft,
    url: member.html_url,
  }));

  return {
    pr: opts.pr,
    isStacked: true,
    stackNumber: stack.body.number,
    baseRef: stack.body.base.ref,
    members,
  } satisfies StackView;
});
