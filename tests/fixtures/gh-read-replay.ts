import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
};
export const replayCases = [
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

export const createReplayGh = async (root: string, interpreter: string) => {
  const bin = join(root, "bin");
  await mkdir(bin);
  const path = join(bin, "gh");
  await writeFile(
    path,
    `#!${interpreter}
const pr = ${JSON.stringify(pr)};
const issue = ${JSON.stringify(issue)};
const comment = ${JSON.stringify(comment)};
const run = ${JSON.stringify(run)};
const args = process.argv.slice(2);
const fields = args[args.indexOf("--json") + 1];
const project = (value) => Object.fromEntries(Object.keys(value).sort().filter((key) => fields.split(",").includes(key)).map((key) => [key, value[key]]));
const print = (value) => console.log(JSON.stringify(value));
const check = (bucket) => ({ name: "Build", state: bucket === "pending" ? "IN_PROGRESS" : "FAILURE", bucket, link: "external" });
if (args[0] === "repo" && args[1] === "view") print({ owner: { login: "owner" }, name: "repo", defaultBranchRef: { name: "main" }, url: "https://github.com/owner/repo" });
else if (args[0] === "pr" && args[1] === "view") print(project({ ...pr, number: Number(args[2]) || 42 }));
else if (args[0] === "pr" && args[1] === "list") print([project(pr)]);
else if (args[0] === "pr" && args[1] === "checks") {
  if (args[2] === "44") { console.error("no checks reported"); process.exitCode = 1; }
  else print([check(args[2] === "43" ? "fail" : "pending")]);
}
else if (args[0] === "issue" && args[1] === "view") print(project(issue));
else if (args[0] === "issue" && args[1] === "list") print([project(issue)]);
else if (args[0] === "run" && args[1] === "list") print([project(run)]);
else if (args[0] === "run" && args[1] === "watch") {}
else if (args[0] === "run" && args[1] === "view") {
  const id = Number(args[2]);
  const value = { ...run, databaseId: id, attempt: id === 102 ? 2 : 1,
    status: id === 100 ? "in_progress" : "completed", conclusion: id === 100 ? "" : id === 101 ? "failure" : "success",
    jobs: run.jobs.map((job) => ({ ...job, databaseId: id * 10,
      status: id === 100 ? "in_progress" : "completed", conclusion: id === 100 ? "" : id === 101 ? "failure" : "success",
      completedAt: id === 100 ? null : job.completedAt,
      steps: job.steps.map((step) => ({ ...step, status: id === 100 ? "in_progress" : "completed",
        conclusion: id === 100 ? "" : id === 101 ? "failure" : "success" })) })) };
  if (args.includes("--log-failed") || args.includes("--log")) console.log("Build\\tCompile\\t2026-10-01T08:00:00Z example output");
  else print(project(value));
}
else if (args[0] === "api" && args[1].includes("/comments?")) print([comment]);
else if (args[0] === "api" && args[1].endsWith("/annotations")) print([]);
else if (args[0] === "api" && args[1].endsWith("/logs")) console.log("2026-10-01T08:00:00Z example output");
else if (args[0] === "api" && args.includes("--jq")) console.log("b".repeat(40));
else { console.error("Unsupported offline replay command: " + JSON.stringify(args)); process.exitCode = 98; }
`,
  );
  await chmod(path, 0o755);
  return bin;
};
