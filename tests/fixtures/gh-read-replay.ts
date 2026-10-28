const pr = {
  author: { login: "author", is_bot: false },
  baseRefName: "main",
  body: "Example PR body.",
  createdAt: "2026-10-01T08:00:00Z",
  headRefName: "feat/example",
  headRefOid: "a".repeat(40),
  headRepositoryOwner: { login: "owner" },
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeCommit: null,
  number: 42,
  reviewDecision: "",
  reviewRequests: [],
  state: "OPEN",
  title: "Example PR",
  url: "https://github.com/owner/repo/pull/42",
};
const issue = {
  assignees: [{ login: "author" }],
  author: { login: "author" },
  body: "Example issue body.",
  closedAt: null,
  createdAt: "2026-10-01T08:00:00Z",
  labels: [{ name: "bug" }],
  number: 7,
  state: "OPEN",
  title: "Example issue",
  url: "https://github.com/owner/repo/issues/7",
};
const comment = {
  id: 17,
  user: { login: "reviewer" },
  body: "Example discussion.",
  created_at: "2026-10-01T09:00:00Z",
  html_url: "https://github.com/owner/repo/issues/7#issuecomment-17",
};
const run = {
  attempt: 1,
  conclusion: "success",
  createdAt: "2026-10-01T08:00:00Z",
  databaseId: 100,
  displayTitle: "Example CI",
  event: "pull_request",
  headBranch: "feat/example",
  headSha: "a".repeat(40),
  jobs: [
    {
      completedAt: "2026-10-01T08:01:00Z",
      conclusion: "success",
      databaseId: 1000,
      name: "Build",
      startedAt: "2026-10-01T08:00:00Z",
      status: "completed",
      steps: [
        {
          completedAt: "2026-10-01T08:01:00Z",
          conclusion: "success",
          name: "Compile",
          number: 1,
          startedAt: "2026-10-01T08:00:00Z",
          status: "completed",
        },
      ],
      url: "https://github.com/owner/repo/actions/runs/100/job/1000",
    },
  ],
  status: "completed",
  url: "https://github.com/owner/repo/actions/runs/100",
  workflowName: "CI",
  workflowDatabaseId: 10,
};
export const replayCases = [
  ...[
    "threads",
    "comments",
    "reviews",
    "last-human-reviewer",
    "feedback",
    "issue-comments",
    "issue-comments-latest",
    "discussion-summary",
    "review-triage",
  ].map((command) => ["pr", command, "--pr", "42"]),
  ["pr", "review-triage-batch", "--prs", "42,43"],
  ["pr", "stack", "view", "--pr", "42"],
  ["repo", "info"],
  ["repo", "list", "--org", "owner"],
  ["repo", "search-code", "--org", "owner", "--query", "example"],
  ["release", "list"],
  ["release", "view", "--tag", "v1.0.0"],
  ["release", "status"],
  ["gist", "list"],
  ["gist", "view", "--id", "example"],
  ["pr", "view", "--pr", "42"],
  ["pr", "view", "--prs", "42,43"],
  ["pr", "status"],
  ["pr", "list"],
  ["pr", "wait-mergeable", "--pr", "42"],
  ["pr", "checks", "--pr", "42"],
  ["pr", "checks", "--prs", "42,43,44"],
  ["pr", "checks-failed", "--pr", "43"],
  ["issue", "view", "--issue", "7"],
  ["issue", "list"],
  ["issue", "comments", "--issue", "7"],
  ["issue", "triage", "--issue", "7", "--verbosity", "full"],
  ["issue", "snapshot-batch", "--issues", "7"],
  ["workflow", "list"],
  ...["100", "101", "102"].flatMap((id) => [
    ["workflow", "view", "--run", id],
    ["workflow", "jobs", "--run", id],
  ]),
  ["workflow", "watch", "--run", "102", "--timeout", "1"],
  ["workflow", "logs", "--run", "102"],
  ["workflow", "job-logs", "--run", "102", "--job", "Build"],
  ["workflow", "annotations", "--run", "102"],
];

export const replayFlags = (argv: readonly string[]) => [
  ...argv,
  ...(argv[0] === "gist" || (argv[0] === "repo" && argv[1] !== "info")
    ? []
    : ["--repo", "owner/repo"]),
  "--format",
  "json",
];

export const createReplayGh = () => {
  let assigned = false;
  return (args: readonly string[]) => {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    const printText = (value: string) => {
      stdout += value + "\n";
    };
    const printError = (value: string) => {
      stderr += value + "\n";
    };
    const inline = {
      id: 1,
      in_reply_to_id: null,
      user: { login: "reviewer" },
      body: "Example inline comment.",
      path: "file.ts",
      line: 1,
      created_at: "2026-10-01T09:00:00Z",
      updated_at: "2026-10-01T09:00:00Z",
      commit_id: pr.headRefOid,
      pull_request_review_id: 1,
    };
    const review = {
      id: 1,
      user: { login: "reviewer" },
      state: "COMMENTED",
      body: "Example review summary.",
      submitted_at: "2026-10-01T09:00:00Z",
      html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-1",
      commit_id: pr.headRefOid,
    };
    const release = {
      tagName: "v1.0.0",
      name: "Example release",
      isDraft: false,
      isPrerelease: false,
      isLatest: true,
      createdAt: "2026-10-01T08:00:00Z",
      publishedAt: "2026-10-01T09:00:00Z",
      url: "https://github.com/owner/repo/releases/tag/v1.0.0",
      body: "Example notes.",
      targetCommitish: "main",
      author: { login: "author" },
      assets: [],
    };
    const gist = {
      id: "example",
      description: "Example gist",
      public: true,
      html_url: "https://gist.github.com/owner/example",
      created_at: "2026-10-01T08:00:00Z",
      updated_at: "2026-10-01T09:00:00Z",
      owner: { login: "owner" },
      files: {
        "example.ts": {
          filename: "example.ts",
          language: "TypeScript",
          type: "text/plain",
          size: 12,
          content: "example text",
        },
      },
    };
    const fields = args[args.indexOf("--json") + 1] ?? "";
    const target = args[1] ?? "";
    const project = (value: Record<string, unknown>) =>
      Object.fromEntries(
        Object.keys(value)
          .toSorted()
          .filter((key) => fields.split(",").includes(key))
          .map((key) => [key, value[key]]),
      );
    const print = (value: unknown) => printText(JSON.stringify(value));
    const login = "fixture-operator";
    const check = (bucket: string) => ({
      name: "Build",
      state: bucket === "pending" ? "IN_PROGRESS" : "FAILURE",
      bucket,
      link: "external",
    });
    if (args[0] === "repo" && target === "view")
      print({
        owner: { login: "owner" },
        name: "repo",
        defaultBranchRef: { name: "main" },
        url: "https://github.com/owner/repo",
      });
    else if (args[0] === "repo" && target === "list")
      print([
        {
          name: "repo",
          description: "Example",
          visibility: "PUBLIC",
          updatedAt: "2026-10-01T08:00:00Z",
          url: "https://github.com/owner/repo",
          isArchived: false,
        },
      ]);
    else if (args[0] === "release" && target === "list") print([project(release)]);
    else if (args[0] === "release" && target === "view") print(project(release));
    else if (args[0] === "pr" && target === "view")
      print(project({ ...pr, number: Number(args[2]) || 42 }));
    else if (args[0] === "pr" && target === "list") print([project(pr)]);
    else if (args[0] === "pr" && target === "checks") {
      if (args[2] === "44") {
        printError("no checks reported");
        exitCode = 1;
      } else print([check(args[2] === "43" ? "fail" : "pending")]);
    } else if (args[0] === "issue" && target === "view")
      print(project(assigned ? { ...issue, assignees: [{ login }] } : issue));
    else if (args[0] === "issue" && target === "edit") {
      assigned = true;
    } else if (args[0] === "issue" && target === "list") print([project(issue)]);
    else if (
      args[0] === "api" &&
      args.some((arg) => arg.endsWith("/issues/42/comments")) &&
      args.includes("POST")
    )
      print({ ...comment, body: "Thanks @fixture-operator for reviewing.", user: { login } });
    else if (args[0] === "run" && target === "list") print([project(run)]);
    else if (args[0] === "run" && target === "watch") {
      // The external watch completed.
    } else if (args[0] === "run" && target === "view") {
      const id = Number(args[2]);
      const value = {
        ...run,
        databaseId: id,
        attempt: id === 102 ? 2 : 1,
        status: id === 100 ? "in_progress" : "completed",
        conclusion: id === 100 ? "" : id === 101 ? "failure" : "success",
        // eslint-disable-next-line oxc/no-map-spread -- Build an independent response snapshot.
        jobs: run.jobs.map((job) => ({
          ...job,
          databaseId: id * 10,
          status: id === 100 ? "in_progress" : "completed",
          conclusion: id === 100 ? "" : id === 101 ? "failure" : "success",
          completedAt: id === 100 ? null : job.completedAt,
          steps: job.steps.map((step) => ({
            ...step,
            status: id === 100 ? "in_progress" : "completed",
            conclusion: id === 100 ? "" : id === 101 ? "failure" : "success",
          })),
        })),
      };
      if (args.includes("--log-failed") || args.includes("--log"))
        printText("Build\tCompile\t2026-10-01T08:00:00Z example output");
      else print(project(value));
    } else if (args[0] === "api" && target === "graphql") {
      const query = args.join(" ");
      const node = query.includes("reviewThreads")
        ? {
            reviewThreads: {
              nodes: [
                {
                  id: "thread-1",
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        id: "comment-1",
                        databaseId: 1,
                        path: inline.path,
                        line: inline.line,
                        body: inline.body,
                        author: { login: "reviewer" },
                        commit: { oid: pr.headRefOid },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          }
        : {
            reviewRequests: {
              nodes: [{ requestedReviewer: { __typename: "User", login: "reviewer" } }],
            },
            reviews: {
              nodes: [
                {
                  author: { login: "reviewer" },
                  state: "COMMENTED",
                  submittedAt: review.submitted_at,
                },
              ],
            },
          };
      print({ data: { repository: { pullRequest: node } } });
    } else if (args[0] === "api" && target.includes("/comments?"))
      print([target.includes("/pulls/") ? inline : comment]);
    else if (args[0] === "api" && target.includes("/reviews?")) print([review]);
    else if (args[0] === "api" && target.startsWith("gists?")) print([gist]);
    else if (args[0] === "api" && target.startsWith("gists/")) print(gist);
    else if (args[0] === "api" && target === "rate_limit")
      print({
        resources: {
          core: { limit: 5000, used: 120, remaining: 4880, reset: 1 },
          graphql: { limit: 5000, used: 80, remaining: 4920, reset: 1 },
        },
      });
    else if (args[0] === "api" && target.startsWith("/search/code?"))
      print({
        items: [
          {
            repository: { full_name: "owner/repo" },
            path: "file.ts",
            html_url: "https://github.com/owner/repo/blob/main/file.ts",
          },
        ],
      });
    else if (args[0] === "api" && target.endsWith("/annotations")) print([]);
    else if (args[0] === "api" && target.endsWith("/logs"))
      printText("2026-10-01T08:00:00Z example output");
    else if (args[0] === "api" && args.includes("--jq")) printText("b".repeat(40));
    else {
      printError("Unsupported offline replay command: " + JSON.stringify(args));
      exitCode = 98;
    }
    return { stdout, stderr, exitCode };
  };
};
