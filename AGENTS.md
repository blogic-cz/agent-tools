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

For the credential guard, the guarded fact is that command text names no secret source
and supplies no uninspectable code. Bash and PowerShell feed one shared policy. Parser
errors, analysis limits, and unresolved executable, code, path, or environment-name
operands refuse. Unknown executable names with literal nonsensitive operands may pass;
this does not certify the executable, existing scripts, or trusted host startup files.
The guard catches mistakes of a cooperative agent; it does not stop an agent that tries to
bypass it, which is the job of an OS sandbox. An undeclared option of a registered command
passes as data; declare the options that carry code, a program, a pager, or a path. Judge a
guard change against the previous release: it must not pass a command that read a secret
there, and it should refuse fewer innocent commands.
Keep argument roles explicit. A pattern or prompt is data; a file reader operand is a
path. Apply configured rules to nested shell bodies and resolved invocations as well as
the original text. New command support belongs in the shared parser, policy, or registry,
not a whole-command exception in the public hook. HOME, PWD, OLDPWD, and PATH are built-in
non-secret names. Their approval removes ambient-expansion refusals only; path, code,
and startup-mutation checks still apply.

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

`lstatSync` and `realpathSync` are also permitted in the credential guard's copy-destination proof in `src/credential-guard/index.ts` when `chainCopyDestinations` is non-empty. The guard API is synchronous. This proof refuses filesystem errors, symlinks, and paths outside the configured directories.

Asynchronous `node:fs/promises` is permitted in modules covered by the Vitest suite.
Vitest runs under Bun. Tests inject process and IPC boundaries and never launch real zsh.
`node:child_process` remains permitted in `src/shared/secret-env.ts` because its resolver
needs an extra fd 3 pipe and process-group termination. Prefer Bun APIs elsewhere.

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
version does not mean `bun install` can resolve it. For v1.3.0, the manifest listed the
version while `GET .../-/agent-tools-1.3.0.tgz` still returned 404 for several minutes. The
publish job polls the tarball URL every five seconds for up to 15 minutes after publish and
ends green only after it returns HTTP 200. The 15-minute bound allows for the several-minute
delay seen in past releases and fails the run if the tarball does not appear.

## Private guard corpus

The committed guard corpus contains only generic synthetic cases. Set `AGENT_TOOLS_PRIVATE_GUARD_CORPUS` to a private history corpus and run `bun scripts/measure-guard-private-corpus.ts` to measure it locally against the pinned base. Generate the sibling `.base.json` with `bun scripts/build-guard-base-verdicts.ts <private-corpus.jsonl> <private-corpus.base.json>`; keep the reviewed `.exceptions.json` beside it. The measurement fails on new or stale exceptions. An unset variable skips this optional check. Never commit history commands or private baseline files.
