export const restPullFixture = (
  number = 42,
  options: { head?: string; state?: string; title?: string; owner?: string; name?: string } = {},
) => ({
  number,
  html_url: `https://github.com/${options.owner ?? "owner"}/${options.name ?? "repo"}/pull/${number}`,
  title: options.title ?? "Example PR",
  state: options.state === "MERGED" ? "closed" : (options.state ?? "OPEN").toLowerCase(),
  merged: options.state === "MERGED",
  merged_at: options.state === "MERGED" ? "2026-10-01T10:00:00Z" : null,
  draft: false,
  mergeable: true,
  merge_commit_sha: null,
  body: "Example PR body.",
  created_at: "2026-10-01T08:00:00Z",
  user: { login: "author", type: "User" },
  head: {
    ref: "feat/example",
    sha: options.head ?? "a".repeat(40),
    user: { login: options.owner ?? "owner", type: "User" },
  },
  base: {
    ref: "main",
    sha: "b".repeat(40),
    user: { login: options.owner ?? "owner", type: "User" },
  },
  requested_reviewers: [],
  requested_teams: [],
});
