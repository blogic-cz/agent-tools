# How to make agent-tools more ergonomic for AI agents

_Audit window 2026-06-19 → 2026-06-26. 10,781 tool calls; gh = 9,610 (89%). All numbers verified against `~/.agent-tools/audit.sqlite` and the source at `/Users/gabrielecegi/bp/agent-tools/src`._

## 1. TL;DR — highest-leverage changes

1. **Kill the blocking `pr checks --watch` default.** 304 watch calls burned **55.6 hrs** of agent wall-clock; **188 timeouts wasted 43.5 hrs** and return _zero_ check state. Cap the interactive watch low and return a pollable snapshot. _(fix + feature, M)_
2. **Print `nextCommand` in the error renderer.** Every guardrail error already carries the exact corrective command — `error-renderer.ts` never prints it (one dead `else` branch). **One line** makes every error in the suite self-correcting. _(fix, S)_
3. **Add `gh pr list`.** It doesn't exist; agents tried it 43× (32 hard fails). `issue list` and `repo list` exist — the omission is just inconsistent. _(feature, M)_
4. **Stop counting `--help` as a failure.** 112 of 418→530 gh "failures" are benign `ShowHelp` (exit 0). The fail-rate signal this very audit relies on is inflated ~21%. _(fix, S)_
5. **Auto-retry transient GitHub network errors + classify 401.** 101 i/o-timeout/502 fails (10.7M ms) and 13 "Bad credentials (HTTP 401)" surface as raw, non-retryable, hint-less text. No `Effect.retry` exists anywhere in gh-tool. _(fix, S/M)_

## 2. Evidence snapshot

| Tool          | Calls | Fail% (raw) | Fail% (real)¹ | Notable latency                                                               |
| ------------- | ----: | ----------: | ------------: | ----------------------------------------------------------------------------- |
| gh            | 9,610 |    6% (530) |     ~4% (418) | avg 22.9s, **max 2,729,993 ms (45 min)** — all top-20 are `pr checks --watch` |
| db            |   514 |         14% |          low² | avg 2.2s                                                                      |
| k8s           |   262 |         15% |          low² | avg 1.7s                                                                      |
| observability |   212 |          0% |            0% | avg 1.5s                                                                      |
| session       |    81 |          1% |             — | —                                                                             |
| logs          |    66 |     **50%** |      **~0%**² | avg 3 ms                                                                      |

¹ minus `error='Help requested'` (112 gh, plus k8s/db). ² db/k8s/logs fails are dominated by the **synthetic probe** (see §6).

**Where the pain actually is (top command shapes):** `issue view` 3,770 (only 17 fail), `pr checks` 1,271 (267 fail), `pr review-triage` 1,038, `pr view` 850. The blocking watch and the help-misfires concentrate in `pr checks`.

## 3. Prioritized recommendations

### HIGH impact

**H1 — `pr checks --watch` blocks the turn for up to 45 min and discards all state on timeout.**
_Problem:_ 304 watch calls = **200,031,896 ms (55.6 hrs)**; 223/304 (73%) failed; **188 timeouts = 156,729,325 ms (43.5 hrs)**. PR 290 alone was watched 61×, escalating 600→900→1800s. _Root cause:_ `fetchChecks` (`pr/core.ts:803-825`) wraps one blocking `gh pr checks --watch` in `Effect.timeoutOrElse`; the `orElse` branch (`:813-823`) does `Effect.fail` and **never calls `fetchCheckResults(pr)` first**, so the agent gets only `"CI check monitoring timed out after Ns"` and re-watches from zero — and the hint literally says _"Retry with a longer --timeout"_, fueling the escalation. _Change:_ (a) in the `orElse`, call `fetchCheckResults(pr)` and return the partial buckets (pending/passed/failed names + elapsed) as a _successful-but-incomplete_ result, not a fail (~5 lines at `pr/core.ts:813`); (b) cap the effective interactive watch at ~120s regardless of requested `--timeout` (`pr/commands.ts` flags); (c) reverse the two "prefer --watch to block" hints at `pr/core.ts:257` and `:832` to recommend re-polling the cheap snapshot. _Effort:_ M. _Type:_ fix.

**H2 — `nextCommand` is computed everywhere and printed nowhere.**
_Problem:_ every tagged error (db/k8s/logs/gh, incl. the watch-timeout) sets `nextCommand` with the exact corrective invocation, but agents never see it. _Root cause:_ `shared/error-renderer.ts` `formatError` prints `message` then `hint`; because `message` is always a string, the field-dump `else` branch (`:18-23`) that _would_ surface other fields is dead, and `nextCommand` is explicitly nowhere in the print path (confirmed: only reader of `nextCommand` in `shared/` is the type decl at `types.ts:8`). _Change:_ after the hint block (`error-renderer.ts:27`), append `if (typeof nextCommand === "string") result += \`\n Try: ${nextCommand}\`;`. _Effort:_ S. _Type:_ fix. **This is the single best ROI item — one line activates affordances already built into every tool.**

**H3 — Add `gh pr list`.**
_Problem:_ 43 `pr list` calls, **32 hard-fail** (the other 11 are `--help`). Attempted shapes: `--state open --format json`, `--author`, `--head core-332-distributed-locks`, `--base <branch>`, `--search`. _Root cause:_ the pr command group (registered in `gh-tool/index.ts`, confirmed no `list`) never wrapped `gh pr list`, though `issue list` (279×) and `repo list` exist and the resolver already shells `gh pr list --head` internally (`pr/core.ts:466-578`). _Change:_ add `prListCommand` in `pr/commands.ts` mirroring `issueListCommand` (`--state/--author/--base/--head/--search/--limit/--format` via `withRepo`), register in `index.ts`. Also fixes branch→PR lookup (`--head`). _Effort:_ M. _Type:_ feature.

**H4 — `--help` is recorded as `success=0`, inflating every fail%.**
_Problem:_ 112 gh "failures" are `error='Help requested'` (effect-cli `ShowHelp`, exit 0). Real gh fails are **418, not 530**. This distorts the per-command reliability signal driving this audit. _Root cause:_ `withAudit` `onFailure` (`shared/audit.ts:299-311`) records `success:false` for any failing `Cause` without inspecting `_tag`. _Change:_ in `onFailure`, when the FailReason is `ShowHelp` with empty `errors[]` (or `extractExitCode(cause)===0`), record `success:true` (or a `status='help'` marker). Do **not** blanket-whitelist `ShowHelp` — when `errors[]` is non-empty it's a real parse failure (see M4). _Effort:_ S. _Type:_ fix.

**H5 — Transient GitHub network failures and 401s are raw passthrough with no retry.**
_Problem:_ **101 fails** matching `i/o timeout`/`502`/`operation timed out` (10,675,318 ms wasted), plus **13** `Bad credentials (HTTP 401)`. Both hit the heaviest read commands. _Root cause:_ `runGh` (`service.ts:137-173`) classifies auth on `not logged in`/`gh auth login` only — so `HTTP 401` falls through to a bare `GitHubCommandError`. There is **no `Effect.retry`/`Schedule` anywhere in gh-tool** (grep clean); `.retryable` is set on errors but only _read_ by logs/observability/az/k8s for display, never to drive a retry. _Change:_ in `runGh`, (a) match `i/o timeout`/`dial tcp`/`502`/`503`/`operation timed out` → `GitHubCommandError{retryable:true}` and wrap idempotent read verbs in `Effect.retry(Schedule.exponential("500 millis") ∩ Schedule.recurs(2))` gated on `retryable`; (b) match `Bad credentials`/`HTTP 401` → `GitHubAuthError{nextCommand:"gh auth refresh -h github.com"}`. _This makes `.retryable` load-bearing — wire it or drop it._ _Effort:_ M. _Type:_ fix. _Note: the outages are infra flakiness; the ergonomics defect is that the tool neither retries nor labels them retryable._

### MEDIUM impact

**M1 — `workflow watch` has no timeout at all.** 29 calls, max **2,184,000 ms (36 min)**; can hang the turn indefinitely. `watchRun` (`workflow.ts:215-250`) runs `gh run watch` with no `Effect.timeout` (unlike `pr checks`). _Change:_ add `--timeout` (default ~300s) + `timeoutOrElse` falling back to `viewRun(runId)` for a final snapshot. _Effort:_ S. _Type:_ fix.

**M2 — "Could not resolve to a PullRequest" never names which repo it queried.** 7× on PR 299 (4 with `--repo be` explicit); two github profiles (nexus-fe/nexus-be) and the agent oscillates. `runGh` maps the not-found (`service.ts:152-162`) but sets `resource/identifier:"unknown"` and discards the resolved `GH_REPO`. _Change:_ populate `GitHubNotFoundError.resource` with the resolved target + hint "Queried sabservis/nexus-be; try --repo fe". _Effort:_ S. _Type:_ fix.

**M3 — No way to discover valid environment names except by failing.** 22 `Unknown environment` fails (guessed `prod`/`test`/`staging`/`legacy`/`portal`); db/k8s/logs expose no `envs` command, and `getConfigForEnv` (`db-tool/service.ts:684-688`) reveals `Available: …` only _after_ a failed call — and as a plain `throw new Error`, bypassing the tagged-error/`nextCommand` contract every other guard uses. _Change:_ add a zero-arg `envs` subcommand to db/k8s/logs printing `Object.keys(config.environments)` + default; replace the plain throw at `db-tool/service.ts:688` with a `DbConnectionError` carrying `hint:"Run db-tool envs"`. _Effort:_ S. _Type:_ feature + fix.

**M4 — "Help requested" hides the real syntax error.** The 112 ShowHelp misfires are botched commands, not help requests: `issue view --issue 348 343 330 …` (multi-id against a single `Flag.integer`), `workflow watch --timeout-seconds` (real flag is `--timeout`), `workflow view 28019…` (positional vs required `--run`). The recorded error collapses `ShowHelp.errors[]` to the opaque string. _Change:_ in `formatCause` (`audit.ts`) and `renderCauseToStderr` (`error-renderer.ts`), when `ShowHelp.errors[]` is non-empty, join them (`"UnrecognizedOption: --timeout-seconds"`) into both the audit row and stderr. _Effort:_ M. _Type:_ fix.

**M5 — `issue view` has no discoverable batch path.** Agents tried 41 ids at once (5 rows, all rejected). The batch command exists but is named `issue snapshot-batch` with `--issues` (csv), not cross-referenced from `issue view`. _Change:_ one-line pointer in `issueViewCommand` description (`issue/commands.ts:76`): "for many issues use `gh issue snapshot-batch --issues 1,2,3`"; optionally accept csv in `--issue`. _Effort:_ S. _Type:_ ux.

**M6 — toon default fights the caller.** When agents choose a format they pick **json 6,053 vs toon 418 (~94%)**; 3,149 accept the toon default. Every explicit `--format json` is wasted command-line tokens. _Root cause:_ `formatOption` defaults to toon (`shared/format.ts`). _Change:_ either flip per-command defaults to json where structured re-parsing dominates (`issue view`, `pr list`, `pr threads`), or keep toon but add a copy-paste json example to `--help` so agents stop reflexively appending it. _Effort:_ S. _Type:_ config. _Skeptical note: the 94% override is a real signal agents distrust toon — measure whether they parse toon correctly before keeping it as default._

### LOW impact

**L1 — `pr create --base` silently defaults to `"test"`.** `pr/commands.ts:144` hardcodes `Flag.withDefault("test")`; trunk is `main`. Agents always pass `--base main` explicitly, but any omission opens a wrong-base PR. _Change:_ drop the literal default; resolve to `getRepoInfo().defaultBranch` or require the flag. _Effort:_ S. _Type:_ config.

**L2 — `resolveEnv` prod-guard is triplicated and matches the literal string `"prod"`.** Near-identical blocks in db/k8s/logs `index.ts`; a prod env not literally named `prod` is unguarded. _Change:_ extract one `src/config/resolve-env.ts` helper driven by a config `prodEnvironments: string[]`. _Effort:_ M. _Type:_ fix. _Low priority — see §6, this guard isn't actually firing in real usage._

## 4. Proposed new features

**F1 — Non-blocking / detached CI watch** _(the headline fix; pairs with H1)_

```
gh pr checks --pr N            # cheap one-shot snapshot (already exists); make this the recommended loop
gh pr checks --pr N --watch    # capped at ~120s, returns {status, pending:[...], passed, failed, reInvoke:"..."} not a fail
gh pr watch start --pr N       # writes a state file (pr, run-id, started-at) under scratch, returns a watch-id immediately
gh pr watch poll --id <x>      # ONE non-blocking fetchCheckResults() → done|pending|failed + elapsed
```

Lands in `pr/core.ts` (reuse `fetchCheckResults`) + `pr/commands.ts`. Lets the agent interleave other work instead of holding a 27-min subprocess.

**F2 — `pr ready?` single verdict** — `review-triage` (1,038 calls) already composites view+threads+checks and fetches `mergeable` (`pr/core.ts:288`) but returns raw pieces, so agents re-stitch and re-fetch. Extend `classifyReviewTriage()` to emit `ready:{mergeable:bool, reasons:[...]}` (no conflict + zero unresolved threads + zero failing checks + approved). Reuses existing data, no new GraphQL. _Effort:_ S.

**F3 — `pr wait-mergeable --pr N --timeout`** — CI-green ≠ mergeable (GitHub recomputes async). Agents poll `pr view` (850×) / `pr status` (94×) by hand. Add a poller on `viewPR().mergeable` until MERGEABLE/CONFLICTING/timeout. _Effort:_ S.

**F4 — `--prs` batch on `pr checks`/`pr view`** — `review-triage-batch` exists but used **19× vs 1,038 single**; undiscovered. Mirror it on the hot single commands (Effect.all over `parsePrNumbers`, bounded concurrency) + a one-line "for multiple PRs use --prs" note in their descriptions. _Effort:_ M.

**F5 — `<tool> schema` JSON dump** — 481 gh `--help` + 80 obs + 54 db probes are interactive discovery, each a round-trip + help dump in context. effect-cli holds the full command tree; one `shared/schema-dump.ts` can serialize name/flags/types/defaults so agents fetch once and invoke first-try. _Effort:_ L. _Lower urgency than the example-line fix below._

## 5. Quick wins (shippable in <1h)

- **H2** — print `nextCommand` in `error-renderer.ts:27` (one line). Biggest ROI in the report.
- **H4** — record `ShowHelp` (empty `errors[]`) as `success=1` in `audit.ts:299`.
- **H1(a)** — call `fetchCheckResults(pr)` in the watch `orElse` and return partial state instead of failing (~5 lines, `pr/core.ts:813`); plus reverse the two "prefer --watch" hints (`:257`, `:832`).
- **M1** — wrap `workflow.ts:215` `runGh` in `timeoutOrElse → viewRun`.
- **M5 / L1** — string edit on `issueViewCommand` description; drop the `"test"` base default.
- **M3** — add the `envs` subcommand (zero network, `Object.keys` of config).

## 6. Skeptical notes — what is NOT an ergonomics problem

- **The "logs 50% fail" / 99× "Implicit prod access blocked" is probe noise, not agent pain.** All 99 fires (33 each on db/k8s/logs) originate from a single synthetic temp dir `/private/var/folders/jv/…`, not from any real project path. The live `agent-tools.json5:3` is `defaultEnvironment:"local"`, so the prod-guard _cannot_ fire for real agents in this repo. **Do not "flip defaultEnvironment to staging"** (as one analyst proposed) — it's already `local`; that recommendation is based on a config that doesn't exist in real usage. The fix is to tag/exclude probe runs from the audit signal (`shared/audit.ts` + the weekly query: `project NOT LIKE '%/agent-tools-prod-default-%'`).
- **The 101 i/o-timeout / 13 401 / 3 502 are infra flakiness** (GitHub API reachability, expired token) — _not_ tool bugs. The _ergonomics_ defect (H5) is purely in how the tool surfaces them: raw passthrough, no `retryable` flag honored, wrong/no recovery command.

**Files referenced:** `src/gh-tool/pr/core.ts` (fetchChecks ~803-825, hints :257/:832), `src/gh-tool/pr/commands.ts` (prCreate base :144; new prListCommand), `src/gh-tool/index.ts` (pr subcommand registration), `src/gh-tool/service.ts` (runGh :137-173), `src/gh-tool/workflow.ts` (watchRun :215-250), `src/gh-tool/issue/commands.ts` (:76), `src/shared/error-renderer.ts` (:27), `src/shared/audit.ts` (:299-311), `src/db-tool/service.ts` (:688), `/Users/gabrielecegi/bp/nexus/agent-tools.json5` (:3).
