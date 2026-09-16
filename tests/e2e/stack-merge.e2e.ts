// DESTRUCTIVE: creates and DELETES a throwaway GitHub repository under the
// authenticated user. Excluded from `bun run check`; run deliberately with
//   AGENT_TOOLS_E2E=1 bun tests/e2e/stack-merge.e2e.ts
// A mocked GitHub cannot prove the one thing this proves: whether a child's squash
// commit still carries its squashed parent's diff.

const GATE = process.env["AGENT_TOOLS_E2E"];
if (GATE !== "1") {
  console.error("Refusing to run: set AGENT_TOOLS_E2E=1 to allow throwaway repo creation.");
  process.exit(2);
}

const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
if (token === undefined || token.length === 0) {
  console.error("Refusing to run: GH_TOKEN or GITHUB_TOKEN must be set.");
  process.exit(2);
}

const REPO_NAME = process.env["AGENT_TOOLS_E2E_REPO"] ?? "agent-tools-stack-e2e";

type Json = Record<string, unknown>;
type ApiResult = { status: number; body: Json };
type Commit = { sha: string; commit: { message: string }; parents: unknown[] };
type Ref = { ref: string };

const field = <T>(source: unknown, ...path: string[]): T => {
  let value: unknown = source;
  for (const key of path) {
    value = (value as Json)[key];
  }
  return value as T;
};

const api = async (path: string, init?: RequestInit): Promise<ApiResult> => {
  const res = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await res.text();
  const body = text.length === 0 ? null : JSON.parse(text);
  if (res.status >= 400) {
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  }
  return { status: res.status, body };
};

const results: Array<{ ok: boolean; name: string; detail: string }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` :: ${detail}`}`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const me = await api("user");
const OWNER: string = field<string>(me.body, "login");
const SLUG = `${OWNER}/${REPO_NAME}`;

const tool = async (args: string[]) => {
  const proc = Bun.spawn(["bun", "src/gh-tool/index.ts", ...args, "--repo", SLUG], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode, all: `${stdout}\n${stderr}` };
};

const repoExists = async () => {
  try {
    await api(`repos/${SLUG}`);
    return true;
  } catch {
    return false;
  }
};

const rootCommitOf = async (defaultBranch: string) => {
  const commits = (await api(`repos/${SLUG}/commits?sha=${defaultBranch}&per_page=100`))
    .body as unknown as Json[];
  const oldest = commits.at(-1);
  if (oldest === undefined) throw new Error("repository has no commits");
  return oldest["sha"] as string;
};

// The token here carries `repo` but not `delete_repo`, so the repository is reused and
// reset rather than recreated: every non-default branch is removed (which closes its PR)
// and the default branch is force-reset to its initial commit.
const resetRepo = async () => {
  if (!(await repoExists())) {
    const created = await api("user/repos", {
      method: "POST",
      body: JSON.stringify({
        name: REPO_NAME,
        private: true,
        auto_init: true,
        description: "throwaway: agent-tools stack merge e2e",
      }),
    });
    await sleep(2000);
    return field<string>(created.body, "default_branch");
  }

  const repo = await api(`repos/${SLUG}`);
  const defaultBranch = field<string>(repo.body, "default_branch");

  const openPrs = (await api(`repos/${SLUG}/pulls?state=open&per_page=100`))
    .body as unknown as Json[];
  for (const pr of openPrs) {
    await api(`repos/${SLUG}/pulls/${pr["number"]}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }

  const refs = (await api(`repos/${SLUG}/git/matching-refs/heads/`)).body as unknown as Ref[];
  for (const ref of refs) {
    const name = ref.ref.replace("refs/heads/", "");
    if (name === defaultBranch) continue;
    await api(`repos/${SLUG}/git/refs/heads/${name}`, { method: "DELETE" });
  }

  const root = await rootCommitOf(defaultBranch);
  await api(`repos/${SLUG}/git/refs/heads/${defaultBranch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: root, force: true }),
  });

  return defaultBranch;
};

const headSha = async (branch: string) =>
  field<string>((await api(`repos/${SLUG}/git/ref/heads/${branch}`)).body, "object", "sha");

const branchFrom = async (name: string, sha: string) => {
  await api(`repos/${SLUG}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
  });
};

const writeFile = async (opts: {
  branch: string;
  path: string;
  content: string;
  message: string;
  sha?: string;
}) =>
  api(`repos/${SLUG}/contents/${opts.path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: opts.message,
      content: Buffer.from(opts.content).toString("base64"),
      branch: opts.branch,
      ...(opts.sha === undefined ? {} : { sha: opts.sha }),
    }),
  });

const openPr = async (opts: { title: string; head: string; base: string; draft?: boolean }) =>
  (
    await api(`repos/${SLUG}/pulls`, {
      method: "POST",
      body: JSON.stringify({ ...opts, body: opts.title, draft: opts.draft ?? false }),
    })
  ).body["number"] as number;

const commitsSince = async (baseSha: string) => {
  const all = (await api(`repos/${SLUG}/commits?sha=main&per_page=50`)).body as unknown as Commit[];
  const landed: Commit[] = [];
  for (const commit of all) {
    if (commit.sha === baseSha) break;
    landed.push(commit);
  }
  return landed.toReversed();
};

const patchOf = async (sha: string) => {
  const full = await api(`repos/${SLUG}/commits/${sha}`);
  return field<Json[]>(full.body, "files")
    .map((file) => (file["patch"] ?? "") as string)
    .join("\n");
};

console.log(`\n### Setting up ${SLUG}`);
const DEF = await resetRepo();
const rootSha = await headSha(DEF);
console.log(`default branch ${DEF} at ${rootSha.slice(0, 8)}`);

console.log("\n### Scenario A — three-deep stack, squash merge from a bottom-PR reference");

await branchFrom("a1", rootSha);
const a1File = await writeFile({
  branch: "a1",
  path: "shared.txt",
  content: "base\nA1\n",
  message: "feat: a1",
});
await branchFrom("a2", await headSha("a1"));
const a2File = await writeFile({
  branch: "a2",
  path: "shared.txt",
  content: "base\nA1\nA2\n",
  message: "feat: a2",
  sha: field<string>(a1File.body, "content", "sha"),
});
await branchFrom("a3", await headSha("a2"));
await writeFile({
  branch: "a3",
  path: "shared.txt",
  content: "base\nA1\nA2\nA3\n",
  message: "feat: a3",
  sha: field<string>(a2File.body, "content", "sha"),
});

const pr1 = await openPr({ title: "a1", head: "a1", base: DEF });
const pr2 = await openPr({ title: "a2", head: "a2", base: "a1" });
const pr3 = await openPr({ title: "a3", head: "a3", base: "a2" });
await api(`repos/${SLUG}/stacks`, {
  method: "POST",
  body: JSON.stringify({ pull_requests: [pr1, pr2, pr3] }),
});

const view = await tool(["pr", "stack", "view", "--pr", String(pr2)]);
check("stack view reports all three members", /members\[3\]/.test(view.stdout), view.stdout.trim());
check(
  "stack view orders members bottom-up",
  view.stdout.indexOf(`1,${pr1},`) < view.stdout.indexOf(`3,${pr3},`),
);

const ordinaryMerge = await tool([
  "pr",
  "merge",
  "--pr",
  String(pr2),
  "--strategy",
  "squash",
  "--confirm",
]);
check(
  "ordinary pr merge refuses a member with open PRs below it",
  /sits above 1 open PR/.test(ordinaryMerge.all),
  ordinaryMerge.all.trim().split("\n")[0],
);
check(
  "the refusal names the member that would also land",
  new RegExp(`#${pr1}`).test(ordinaryMerge.all),
);
const afterOrdinary = await commitsSince(rootSha);
check(
  "refused ordinary merge landed nothing",
  afterOrdinary.length === 0,
  `${afterOrdinary.length} commits`,
);

const bottomMerge = await tool(["pr", "merge", "--pr", String(pr1), "--strategy", "squash"]);
check(
  "ordinary pr merge still allows the bottom member",
  !/sits above/.test(bottomMerge.all),
  bottomMerge.all.trim().split("\n")[0],
);

const dry = await tool(["pr", "stack", "merge", "--pr", String(pr1), "--strategy", "squash"]);
check("dry-run is the default", /dryRun: true/.test(dry.stdout));
check("dry-run targets the top member", new RegExp(`target: ${pr3}`).test(dry.stdout));
check("dry-run merges nothing", /merged: false/.test(dry.stdout));

const beforeDry = await commitsSince(rootSha);
check("dry-run left the trunk untouched", beforeDry.length === 0, `${beforeDry.length} commits`);

const merged = await tool([
  "pr",
  "stack",
  "merge",
  "--pr",
  String(pr1),
  "--strategy",
  "squash",
  "--confirm",
]);
check("confirmed merge reports success", /merged: true/.test(merged.stdout), merged.all.trim());

const landed = await commitsSince(rootSha);
console.log(
  `  landed: ${landed.map((c) => `${c.sha.slice(0, 8)} ${c.commit.message.split("\n")[0]}`).join(" | ")}`,
);
check("exactly three commits landed", landed.length === 3, `got ${landed.length}`);
check(
  "no merge commit",
  landed.every((commit) => commit.parents.length === 1),
);
check(
  "commits landed bottom-up",
  landed.map((c) => c.commit.message.split("\n")[0].replace(/\s*\(#\d+\)$/, "")).join(",") ===
    "feat: a1,feat: a2,feat: a3",
  landed.map((c) => c.commit.message.split("\n")[0]).join(" | "),
);

for (const [index, commit] of landed.entries()) {
  const patch = await patchOf(commit.sha);
  const own = `A${index + 1}`;
  const added = [...patch.matchAll(/^\+(A\d)$/gm)].map((match) => match[1]);
  check(
    `commit ${index + 1} adds only its own line (${own})`,
    added.length === 1 && added[0] === own,
    `added ${JSON.stringify(added)}`,
  );
}

const finalFile = await api(`repos/${SLUG}/contents/shared.txt?ref=${DEF}`);
const finalContent = Buffer.from(field<string>(finalFile.body, "content"), "base64").toString();
check(
  "trunk content has every line exactly once",
  finalContent === "base\nA1\nA2\nA3\n",
  JSON.stringify(finalContent),
);

for (const number of [pr1, pr2, pr3]) {
  const pr = await api(`repos/${SLUG}/pulls/${number}`);
  check(`PR #${number} is merged`, pr.body["merged"] === true, `state=${String(pr.body["state"])}`);
}

const refsAfter = (await api(`repos/${SLUG}/git/matching-refs/heads/`)).body as unknown as Ref[];
const survivors = refsAfter.map((ref) => ref.ref.replace("refs/heads/", ""));
check(
  "GitHub leaves the stack branches standing",
  ["a1", "a2", "a3"].every((branch) => survivors.includes(branch)),
  survivors.join(", "),
);

const again = await tool([
  "pr",
  "stack",
  "merge",
  "--pr",
  String(pr1),
  "--strategy",
  "squash",
  "--confirm",
]);
check(
  "re-running on a fully merged stack refuses instead of acting",
  /no open pull requests left/.test(again.all),
  again.all.trim().split("\n")[0],
);

console.log("\n### Scenario B — a draft member blocks the whole stack");

const trunkAfterA = await headSha(DEF);
await branchFrom("b1", trunkAfterA);
const b1File = await writeFile({
  branch: "b1",
  path: "b.txt",
  content: "B1\n",
  message: "feat: b1",
});
await branchFrom("b2", await headSha("b1"));
await writeFile({
  branch: "b2",
  path: "b.txt",
  content: "B1\nB2\n",
  message: "feat: b2",
  sha: field<string>(b1File.body, "content", "sha"),
});
const prB1 = await openPr({ title: "b1", head: "b1", base: DEF });
const prB2 = await openPr({ title: "b2", head: "b2", base: "b1", draft: true });
await api(`repos/${SLUG}/stacks`, {
  method: "POST",
  body: JSON.stringify({ pull_requests: [prB1, prB2] }),
});

const blockedPlan = await tool([
  "pr",
  "stack",
  "merge",
  "--pr",
  String(prB1),
  "--strategy",
  "squash",
]);
check(
  "the dry-run still prints a plan when a member blocks",
  /dryRun: true/.test(blockedPlan.stdout),
  blockedPlan.all.trim().split("\n")[0],
);
check(
  "the dry-run names the blocker instead of refusing",
  new RegExp(`${prB2},draft`).test(blockedPlan.stdout) || /draft/.test(blockedPlan.stdout),
  blockedPlan.stdout.trim(),
);

const blocked = await tool([
  "pr",
  "stack",
  "merge",
  "--pr",
  String(prB1),
  "--strategy",
  "squash",
  "--confirm",
]);
check(
  "draft member blocks the merge",
  /is not ready/.test(blocked.all),
  blocked.all.trim().split("\n")[0],
);
check("blocked merge names the offending PR", new RegExp(`#${prB2}`).test(blocked.all));
check("blocked merge exits non-zero", blocked.exitCode !== 0, `exit ${blocked.exitCode}`);

const afterBlocked = await commitsSince(trunkAfterA);
check("blocked merge landed nothing", afterBlocked.length === 0, `${afterBlocked.length} commits`);

const prB1State = await api(`repos/${SLUG}/pulls/${prB1}`);
check("the ready parent was not merged on its own", prB1State.body["merged"] === false);

console.log("\n### Scenario C — an unstacked PR is refused, not merged");

await branchFrom("c1", await headSha(DEF));
await writeFile({ branch: "c1", path: "c.txt", content: "C1\n", message: "feat: c1" });
const prC1 = await openPr({ title: "c1", head: "c1", base: DEF });

const unstackedView = await tool(["pr", "stack", "view", "--pr", String(prC1)]);
check(
  "stack view reports an unstacked PR as unstacked",
  /isStacked: false/.test(unstackedView.stdout),
);

const unstacked = await tool([
  "pr",
  "stack",
  "merge",
  "--pr",
  String(prC1),
  "--strategy",
  "squash",
  "--confirm",
]);
check(
  "stack merge refuses an unstacked PR",
  /is not part of a GitHub stack/.test(unstacked.all),
  unstacked.all.trim().split("\n")[0],
);
const prC1State = await api(`repos/${SLUG}/pulls/${prC1}`);
check("the refused PR is still open", prC1State.body["state"] === "open");

console.log("\n### Cleanup");
console.log(`  ${SLUG} is left in place (the token has no delete_repo scope).`);
console.log("  It is private and reset at the start of every run; delete it by hand when done.");

const failed = results.filter((result) => !result.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} assertions passed ===`);
if (failed.length > 0) {
  for (const failure of failed) console.log(`  FAILED: ${failure.name} :: ${failure.detail}`);
  process.exit(1);
}
console.log("RESULT: PASSED");

export {};
