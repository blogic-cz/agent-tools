# agent-tools

This project contains safe CLI wrappers for AI coding agents. The tools provide controlled access to GitHub, databases, Kubernetes, Azure platform resources, Azure DevOps, application logs, and OpenCode sessions — with project-specific configuration via JSON5.

## KISS

Keep It Simple, Stupid.

## Code Quality

**CRITICAL: Always run `bun run check` after every change. If it fails, your code is wrong — fix it. Never bypass or ignore failing checks.**

```bash
bun run check      # format + lint + typecheck + effect diagnostics + test
bun run check ci   # all parallel, format --check only (no file modification)
```

## Guards fail closed

A guard that cannot establish the fact it guards on refuses; it never falls through. The
happy path stays green either way, so the tests do not catch this — read every early exit
and default value in a guard and ask what happens when the lookup _fails_ rather than
returns false. `?? 0`, `orElseSucceed(() => null)`, `catch → null`, and a readiness check
ordered before the branch it protects are the four shapes this has taken here.

Distinguish "the API said no" from "I could not ask". For the stacks endpoint a 404 means
the repository has no stacks surface and the merge proceeds; a 502 means membership is
unknown and it refuses. One `pr merge` guard shipped all three of the shapes above before
review caught them.

## Tests run offline

`tests/setup/no-network.ts` replaces `globalThis.fetch` with one that rejects, so a unit
test cannot reach the real API. New I/O belongs behind `GitHubService` — add a method there
rather than calling `fetch` directly, and the existing mock layer covers every test for
free. A test that genuinely needs HTTP stubs `globalThis.fetch` itself and restores it.

Adding a live call to `mergePR` once passed locally against a 404 for the fake repo and
failed in CI, where the runner's token turned the same request into a different error.

## Poll and retry loops are tested on TestClock

`Effect.whileLoop` rather than recursion, `it.effect` plus `TestClock.adjust` rather than
`it.live` — `waitForMergeable` is the reference. Real sleeps make a suite slow and, worse,
make some assertions impossible: a test for a 60s grace window inside a 300s timeout cannot
be written in real time, and the one written with `it.live` silently asserted the old
behaviour under the new behaviour's name.

Prove a bound with a mutation. Move the constant past the limit it is supposed to respect
and confirm that test, and only that test, fails.

## Runtime Filesystem Exception

Bun async filesystem APIs are preferred throughout the project. Synchronous `node:fs` is permitted only for `src/shared/prerequisites/store.ts` package-local SQLite VPN coordination and for tests that isolate that runtime state. Keep this exception bounded to private runtime-directory setup, SQLite state validation, and deterministic cleanup.

Asynchronous `node:fs/promises` is additionally permitted in a module whose logic is covered by the vitest suite. Vitest runs under Node, so `Bun.file`, `Bun.Glob` and `import("bun")` are unavailable there and any code path a test reaches cannot use them. `src/session-tool/pi.ts` is the current case. Prefer Bun APIs everywhere the tests do not reach, and revisit this if the suite ever runs under the Bun runtime.

## Version control

Standard Git. Branch with `git switch -c <prefix>/<name>` (`feat/`, `fix/`, `chore/`, `refactor/`), conventional commits, `gh pr create` for PRs. Run `bun run format` before committing and `bun run check` before pushing.

## Publishing

Publishing is tag-driven. Do not run `npm publish` locally.

1. Bump version in `package.json`
2. Commit and push to `main`
3. Create and push a git tag: `git tag v0.1.0 && git push origin v0.1.0`
4. GitHub Actions workflow (`.github/workflows/publish.yml`) picks up the tag and publishes to npm via OIDC trusted publishing

Tag only after `main` carries the bump: read `package.json` on the merged `main`, not on the
branch. A release published while your PR was open moves the target, and the version commit
then conflicts on rebase.

npm serves the metadata before the tarball. `npm view <pkg> version` reporting the new
version does not mean `bun install` can resolve it — for v1.3.0 the manifest listed it while
`GET .../-/agent-tools-1.3.0.tgz` still returned 404 for several minutes. Wait for that URL
to answer 200 before bumping any consumer.
