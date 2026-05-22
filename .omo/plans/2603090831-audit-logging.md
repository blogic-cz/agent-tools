# Audit Logging — SQLite via bun:sqlite

## TL;DR

> **Quick Summary**: Add operation audit logging to all 6 CLI tools using `bun:sqlite` (zero new dependencies). Every tool invocation is recorded with timestamp, tool name, args, duration, success/failure. Audit is fire-and-forget — failures never affect tool operation.
>
> **Deliverables**:
>
> - `src/shared/audit.ts` — AuditService + AuditServiceLayer + `withAudit()` helper
> - All 6 tool `index.ts` files wired with audit
> - Unit tests for AuditService
> - Integration test verifying end-to-end audit recording
>
> **Estimated Effort**: Short
> **Parallel Execution**: YES — 2 waves
> **Critical Path**: Task 1 → Tasks 2-7 (parallel) → Task 8

---

## Context

### Original Request

User asked whether to use Pino logger or SQLite with Bun for adding operation audit logging. After analysis, SQLite via `bun:sqlite` was chosen for: zero dependencies, SQL querying, structured data, and KISS alignment.

### Interview Summary

**Key Discussions**:

- Pino vs SQLite: SQLite wins on zero-dep, queryability, and CLI-native fit
- Phase 1 scope: audit recording only, no query CLI, no config UI

**Research Findings**:

- No existing logging infrastructure in the project
- Each tool has its own service with independent command execution (no shared bottleneck)
- `runCommand`/`execEffect` in `shared/` are **exported but unused** by any tool — interception there would be a no-op

### Metis Review

**Identified Gaps** (addressed):

- **CRITICAL**: Original interception strategy (wrapping `runCommand`/`execEffect`) was invalid — no tool uses them. Fixed: wrap at CLI program level with `withAudit()` helper
- `env`/`profile` dropped from schema — not consistently available across tools. `process.argv` captures everything
- `gh-tool` and `session-tool` don't use ConfigService — AuditService must be self-contained (no ConfigService dependency)
- `--help` and zero-arg invocations short-circuit before commands run — must still not break
- Audit failures must be completely invisible (fire-and-forget)

---

## Work Objectives

### Core Objective

Record every CLI tool invocation to `~/.agent-tools/audit.sqlite` with zero new dependencies, zero impact on tool behavior, and zero user-visible output from audit.

### Concrete Deliverables

- `src/shared/audit.ts` — AuditService, AuditServiceLayer, `withAudit()` wrapper
- Modified `src/gh-tool/index.ts` — audit wired
- Modified `src/k8s-tool/index.ts` — audit wired
- Modified `src/db-tool/index.ts` — audit wired
- Modified `src/az-tool/index.ts` — audit wired
- Modified `src/logs-tool/index.ts` — audit wired
- Modified `src/session-tool/index.ts` — audit wired
- `tests/audit.test.ts` — unit tests
- Updated `src/shared/index.ts` — exports

### Definition of Done

- [ ] `bun run check` passes (format + lint + typecheck + effect diagnostics + test)
- [ ] All 6 tools run with `--help` without errors
- [ ] Running any tool command creates/updates `~/.agent-tools/audit.sqlite`
- [ ] Audit entries contain: id, ts, tool, args, duration, success, error, exit_code
- [ ] Deleting/corrupting audit DB does not break any tool

### Must Have

- Zero new npm dependencies (`bun:sqlite` is built-in)
- Fire-and-forget: audit errors never propagate to tool output
- All 6 tools wired
- `~/.agent-tools/` directory auto-created on first use
- WAL mode + busy_timeout for concurrent access safety
- Purge of entries older than 90 days on every DB open
- Unit tests for AuditService

### Must NOT Have (Guardrails)

- **No `agent-tools audit` CLI subcommand** — that is a separate future task
- **No audit config in `agent-tools.json5`** — use hardcoded defaults only (path, retention). Config extension is phase 2
- **No refactoring of existing tool services** — wrap at CLI level only, don't touch service interfaces
- **No per-tool audit tables** — one flat `audit_log` table for all tools
- **No analytics, aggregation, or reporting features**
- **No `Effect.promise` for bun:sqlite calls** — they are synchronous, use `Effect.try`/`Effect.sync`
- **No `Context.Tag` pattern** — use `ServiceMap.Service` matching existing codebase
- **No structured retention scheduling** — simple purge on DB open is sufficient

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES (vitest, `tests/*.test.ts`)
- **Automated tests**: YES (tests-after)
- **Framework**: vitest

### QA Policy

Every task includes agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **CLI tools**: Use Bash — run tool commands, check exit codes, query SQLite
- **Module**: Use Bash (bun REPL / vitest) — import, call functions, compare output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — foundation):
└── Task 1: AuditService + AuditServiceLayer + withAudit() + unit tests [deep]

Wave 2 (After Wave 1 — all 6 tools in parallel):
├── Task 2: Wire audit into gh-tool [quick]
├── Task 3: Wire audit into k8s-tool [quick]
├── Task 4: Wire audit into db-tool [quick]
├── Task 5: Wire audit into az-tool [quick]
├── Task 6: Wire audit into logs-tool [quick]
└── Task 7: Wire audit into session-tool [quick]

Wave 3 (After Wave 2 — verification):
└── Task 8: Integration test + shared exports [quick]

Wave FINAL (After ALL tasks — independent review, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Tasks 2-7 → Task 8 → F1-F4
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 6 (Wave 2)
```

### Dependency Matrix

| Task  | Depends On       | Blocks           |
| ----- | ---------------- | ---------------- |
| 1     | —                | 2, 3, 4, 5, 6, 7 |
| 2     | 1                | 8                |
| 3     | 1                | 8                |
| 4     | 1                | 8                |
| 5     | 1                | 8                |
| 6     | 1                | 8                |
| 7     | 1                | 8                |
| 8     | 2, 3, 4, 5, 6, 7 | F1-F4            |
| F1-F4 | 8                | —                |

### Agent Dispatch Summary

- **Wave 1**: **1 task** — T1 → `deep` + `effect-ts`
- **Wave 2**: **6 tasks** — T2-T7 → `quick` + `effect-ts`
- **Wave 3**: **1 task** — T8 → `quick` + `effect-ts`, `testing-patterns`
- **FINAL**: **4 tasks** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [ ] 1. AuditService core — `src/shared/audit.ts` + unit tests

  **What to do**:
  - Create `src/shared/audit.ts` with:
    - SQLite schema: `audit_log` table (id, ts, tool, args, duration, success, error, exit_code) with `STRICT` mode
    - `AuditService` using `ServiceMap.Service` pattern (NOT `Context.Tag`) — follow `K8sService` at `src/k8s-tool/service.ts:16-34`
    - `AuditServiceLayer` using `Layer.scoped` + `Effect.acquireRelease` for DB lifecycle (open on acquire, close on release)
    - DB open with: `{ strict: true, create: true }`, PRAGMAs: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`
    - Auto-create `~/.agent-tools/` directory using `mkdirSync` with `{ recursive: true }` in acquire step
    - `purgeOldEntries()` that runs on every DB open — deletes rows where `ts < datetime('now', '-90 days')`
    - `withAudit(toolName: string, program: Effect<A, E, R>): Effect<A, E, R | AuditService>` helper that:
      - Captures `process.argv.slice(2).join(' ')` as args
      - Measures duration via `Effect.timed` or manual `Date.now()` delta
      - On success: inserts audit entry with `success=1`
      - On failure: inserts audit entry with `success=0`, error message, exit code if available
      - ALL audit operations wrapped with `Effect.catchAll(() => Effect.void)` — fire-and-forget
    - Tool name extraction: derive from `process.argv[1]` (e.g. `agent-tools-gh` → `gh`)
  - All `bun:sqlite` calls MUST use `Effect.try` or `Effect.sync` — they are synchronous
  - Create `tests/audit.test.ts` with vitest:
    - Test AuditService with in-memory SQLite (`:memory:`) — verify schema creation
    - Test insert + query roundtrip
    - Test purge deletes old entries (insert with old timestamp, purge, verify gone)
    - Test fire-and-forget: verify audit layer failure doesn't propagate to wrapped program
    - Follow test patterns from `tests/config-loader.test.ts`

  **Must NOT do**:
  - Do NOT use `Context.Tag` — use `ServiceMap.Service` pattern
  - Do NOT use `Effect.promise` for sqlite calls
  - Do NOT add any npm dependencies
  - Do NOT add config to `agent-tools.json5`
  - Do NOT build query/analytics features
  - Do NOT create `AuditEntry` type beyond what SQLite schema needs — keep it inline/minimal

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Core service with Effect patterns, SQLite integration, acquireRelease lifecycle, and comprehensive tests
  - **Skills**: `["effect-ts", "testing-patterns"]`
    - `effect-ts`: ServiceMap.Service, Layer.scoped, Effect.acquireRelease, Effect.try patterns
    - `testing-patterns`: Vitest patterns, Effect service testing
  - **Skills Evaluated but Omitted**:
    - `drizzle-database`: Not relevant — raw bun:sqlite, not Drizzle ORM

  **Parallelization**:
  - **Can Run In Parallel**: NO — foundation task
  - **Parallel Group**: Wave 1 (solo)
  - **Blocks**: Tasks 2, 3, 4, 5, 6, 7
  - **Blocked By**: None (can start immediately)

  **References**:

  **Pattern References** (existing code to follow):
  - `src/k8s-tool/service.ts:16-34` — `ServiceMap.Service` pattern: how to define service interface and tag
  - `src/k8s-tool/service.ts:35-38` — `Layer.effect` + `Effect.scoped` + `Effect.gen` pattern for service layer creation
  - `src/config/loader.ts:118-121` — Alternative simpler `ServiceMap.Service` definition (config is just a value, not methods)
  - `src/config/loader.ts:127-133` — `Layer.effect` pattern with `Effect.tryPromise` (but we use `Effect.try` since sqlite is sync)
  - `src/shared/exec.ts:6-11` — `Schema.TaggedErrorClass` pattern for error classes (if needed for AuditError)
  - `src/k8s-tool/index.ts:401-410` — `MainLayer` composition via `Layer.provideMerge` + `BunRuntime.runMain` — this is the pattern each tool uses

  **Test References**:
  - `tests/config-loader.test.ts:1-34` — Test structure: vitest imports, describe/it pattern, config type imports

  **External References**:
  - Bun SQLite docs: https://bun.sh/docs/api/sqlite — `Database` constructor, `.query()`, `.run()`, `.all()`, pragmas, `:memory:`
  - Effect ServiceMap.Service: follow codebase patterns (Effect 4.0-beta.25), NOT older Effect 3.x docs

  **WHY Each Reference Matters**:
  - `K8sService` is the canonical service pattern — copy its shape exactly for AuditService
  - `ConfigServiceLayer` shows Layer composition that all 6 tools already use — AuditServiceLayer will be merged the same way
  - `exec.ts` error class pattern ensures type-safe errors if we need an `AuditError` (though errors should be swallowed)
  - Test patterns ensure consistent test style

  **Acceptance Criteria**:
  - [ ] `src/shared/audit.ts` exists with AuditService, AuditServiceLayer, withAudit()
  - [ ] `tests/audit.test.ts` exists and passes: `bun run vitest run tests/audit.test.ts`
  - [ ] Uses `ServiceMap.Service` (not `Context.Tag`)
  - [ ] Uses `Effect.try`/`Effect.sync` for sqlite (not `Effect.promise`)
  - [ ] Zero new entries in `package.json` dependencies

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Unit tests pass
    Tool: Bash
    Preconditions: Task 1 implementation complete
    Steps:
      1. Run: bun run vitest run tests/audit.test.ts
      2. Assert exit code 0
      3. Assert output contains "Tests" and no failures
    Expected Result: All tests pass, zero failures
    Failure Indicators: Non-zero exit code, "FAIL" in output
    Evidence: .sisyphus/evidence/task-1-unit-tests.txt

  Scenario: No new dependencies added
    Tool: Bash
    Preconditions: Task 1 implementation complete
    Steps:
      1. Run: git diff package.json
      2. Assert no changes to dependencies or devDependencies sections
    Expected Result: package.json unchanged in dependency sections
    Failure Indicators: New entries in dependencies/devDependencies
    Evidence: .sisyphus/evidence/task-1-no-new-deps.txt

  Scenario: Correct Effect patterns used
    Tool: Bash (grep)
    Preconditions: Task 1 implementation complete
    Steps:
      1. Run: grep -c 'ServiceMap.Service' src/shared/audit.ts — assert >= 1
      2. Run: grep -c 'Context.Tag' src/shared/audit.ts — assert 0
      3. Run: grep -c 'Effect.promise' src/shared/audit.ts — assert 0
    Expected Result: ServiceMap.Service used, Context.Tag and Effect.promise absent
    Failure Indicators: Wrong pattern counts
    Evidence: .sisyphus/evidence/task-1-effect-patterns.txt
  ```

  **Commit**: YES (group with all tasks)
  - Message: `feat(audit): add SQLite operation audit logging to all CLI tools`
  - Files: `src/shared/audit.ts`, `tests/audit.test.ts`

- [ ] 2. Wire audit into gh-tool

  **What to do**:
  - Modify `src/gh-tool/index.ts`:
    - Import `AuditServiceLayer` and `withAudit` from `#shared/audit`
    - Wrap the `cli` program with `withAudit("gh", cli)`
    - Add `AuditServiceLayer` to `MainLayer` via `Layer.provideMerge`
  - This should be ~5 lines of change total

  **Must NOT do**:
  - Do NOT modify `GitHubService` or any other gh-tool files
  - Do NOT change command handlers or output format

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Minimal change — 3 import lines + 2 wiring lines
  - **Skills**: `["effect-ts"]`
    - `effect-ts`: Layer.provideMerge composition pattern

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4, 5, 6, 7)
  - **Blocks**: Task 8
  - **Blocked By**: Task 1

  **References**:
  - `src/gh-tool/index.ts:165` — Current `MainLayer`: `GitHubService.layer.pipe(Layer.provideMerge(BunServices.layer))` — add `AuditServiceLayer` here
  - `src/gh-tool/index.ts:167` — Current program: `cli.pipe(Effect.provide(MainLayer), ...)` — wrap `cli` with `withAudit("gh", cli)` before `.pipe`
  - `src/k8s-tool/index.ts:401-406` — Reference for multi-layer `MainLayer` composition (shows `Layer.provideMerge` chaining)
  - `src/shared/audit.ts` (from Task 1) — `AuditServiceLayer` and `withAudit` exports

  **Acceptance Criteria**:
  - [ ] `src/gh-tool/index.ts` imports AuditServiceLayer and withAudit
  - [ ] MainLayer includes AuditServiceLayer
  - [ ] cli is wrapped with withAudit
  - [ ] `bun agent-tools-gh --help` exits 0 with no audit errors on stderr

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: gh-tool --help still works
    Tool: Bash
    Steps:
      1. Run: bun agent-tools-gh --help
      2. Assert exit code 0
      3. Assert stderr is empty or contains only expected output
    Expected Result: Help text printed, exit 0
    Failure Indicators: Non-zero exit, audit errors in stderr
    Evidence: .sisyphus/evidence/task-2-gh-help.txt
  ```

  **Commit**: YES (group with all tasks)
  - Files: `src/gh-tool/index.ts`

---

- [ ] 3. Wire audit into k8s-tool

  **What to do**:
  - Modify `src/k8s-tool/index.ts`:
    - Import `AuditServiceLayer` and `withAudit` from `#shared/audit`
    - Wrap the `cli` program with `withAudit("k8s", cli)`
    - Add `AuditServiceLayer` to `MainLayer` via `Layer.provideMerge`

  **Must NOT do**:
  - Do NOT modify `K8sService` or any other k8s-tool files

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Minimal change
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 4, 5, 6, 7)
  - **Blocks**: Task 8
  - **Blocked By**: Task 1

  **References**:
  - `src/k8s-tool/index.ts:401-404` — Current `MainLayer` with 3 `Layer.provideMerge` calls — add `AuditServiceLayer` as 4th
  - `src/k8s-tool/index.ts:406` — Current program wrapping

  **Acceptance Criteria**:
  - [ ] k8s-tool wired with audit
  - [ ] `bun agent-tools-k8s --help` exits 0

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: k8s-tool --help still works
    Tool: Bash
    Steps:
      1. Run: bun agent-tools-k8s --help
      2. Assert exit code 0
    Expected Result: Help text printed, exit 0
    Failure Indicators: Non-zero exit, audit errors in stderr
    Evidence: .sisyphus/evidence/task-3-k8s-help.txt
  ```

  **Commit**: YES (group with all tasks)
  - Files: `src/k8s-tool/index.ts`

---

- [ ] 4. Wire audit into db-tool

  **What to do**:
  - Modify `src/db-tool/index.ts`:
    - Import `AuditServiceLayer` and `withAudit` from `#shared/audit`
    - Wrap the `cli` program with `withAudit("db", cli)`
    - Add `AuditServiceLayer` to `MainLayer` via `Layer.provideMerge`

  **Must NOT do**:
  - Do NOT modify `DbService` or any other db-tool files

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 8
  - **Blocked By**: Task 1

  **References**:
  - `src/db-tool/index.ts:120-126` — Current `MainLayer` with DbService + Config + BunServices layers
  - `src/db-tool/index.ts:126` — Current program wrapping

  **Acceptance Criteria**:
  - [ ] db-tool wired with audit
  - [ ] `bun agent-tools-db --help` exits 0

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: db-tool --help still works
    Tool: Bash
    Steps:
      1. Run: bun agent-tools-db --help
      2. Assert exit code 0
    Expected Result: Help text printed, exit 0
    Evidence: .sisyphus/evidence/task-4-db-help.txt
  ```

  **Commit**: YES (group with all tasks)
  - Files: `src/db-tool/index.ts`

---

- [ ] 5. Wire audit into az-tool

  **What to do**:
  - Modify `src/az-tool/index.ts`:
    - Import `AuditServiceLayer` and `withAudit` from `#shared/audit`
    - Wrap the `cli` program with `withAudit("az", cli)`
    - Add `AuditServiceLayer` to `MainLayer` via `Layer.provideMerge`

  **Must NOT do**:
  - Do NOT modify `AzService` or any other az-tool files

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 8
  - **Blocked By**: Task 1

  **References**:
  - `src/az-tool/index.ts:196-201` — Current `MainLayer` (AzService + Config + BunServices)
  - `src/az-tool/index.ts:201` — Current program wrapping

  **Acceptance Criteria**:
  - [ ] az-tool wired with audit
  - [ ] `bun agent-tools-az --help` exits 0

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: az-tool --help still works
    Tool: Bash
    Steps:
      1. Run: bun agent-tools-az --help
      2. Assert exit code 0
    Expected Result: Help text printed, exit 0
    Evidence: .sisyphus/evidence/task-5-az-help.txt
  ```

  **Commit**: YES (group with all tasks)
  - Files: `src/az-tool/index.ts`

---

- [ ] 6. Wire audit into logs-tool

  **What to do**:
  - Modify `src/logs-tool/index.ts`:
    - Import `AuditServiceLayer` and `withAudit` from `#shared/audit`
    - Wrap the `cli` program with `withAudit("logs", cli)`
    - Add `AuditServiceLayer` to `MainLayer` via `Layer.provideMerge`

  **Must NOT do**:
  - Do NOT modify `LogsService` or any other logs-tool files

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 8
  - **Blocked By**: Task 1

  **References**:
  - `src/logs-tool/index.ts:229-234` — Current `MainLayer` (LogsService + Config + BunServices)
  - `src/logs-tool/index.ts:234` — Current program wrapping

  **Acceptance Criteria**:
  - [ ] logs-tool wired with audit
  - [ ] `bun agent-tools-logs --help` exits 0

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: logs-tool --help still works
    Tool: Bash
    Steps:
      1. Run: bun agent-tools-logs --help
      2. Assert exit code 0
    Expected Result: Help text printed, exit 0
    Evidence: .sisyphus/evidence/task-6-logs-help.txt
  ```

  **Commit**: YES (group with all tasks)
  - Files: `src/logs-tool/index.ts`

---

- [ ] 7. Wire audit into session-tool

  **What to do**:
  - Modify `src/session-tool/index.ts`:
    - Import `AuditServiceLayer` and `withAudit` from `#shared/audit`
    - Wrap the `cli` program with `withAudit("session", cli)`
    - Add `AuditServiceLayer` to `MainLayer` (currently `AppLayer.pipe(Layer.provideMerge(BunServices.layer))`)
  - **NOTE**: session-tool does NOT use `ConfigService` — AuditServiceLayer must be self-contained (no ConfigService dependency). This is already handled by Task 1 design.

  **Must NOT do**:
  - Do NOT modify `SessionService` or any other session-tool files
  - Do NOT add ConfigService to session-tool

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 8
  - **Blocked By**: Task 1

  **References**:
  - `src/session-tool/index.ts:264` — Current `MainLayer`: `AppLayer.pipe(Layer.provideMerge(BunServices.layer))` — add `AuditServiceLayer` merge
  - `src/session-tool/index.ts:266` — Current program: `cli.pipe(Effect.provide(MainLayer))` — note: no `tapCause(renderCauseToStderr)` here, keep it as-is

  **Acceptance Criteria**:
  - [ ] session-tool wired with audit
  - [ ] `bun agent-tools-session --help` exits 0

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: session-tool --help still works
    Tool: Bash
    Steps:
      1. Run: bun agent-tools-session --help
      2. Assert exit code 0
    Expected Result: Help text printed, exit 0
    Evidence: .sisyphus/evidence/task-7-session-help.txt
  ```

  **Commit**: YES (group with all tasks)
  - Files: `src/session-tool/index.ts`

- [ ] 8. Integration test + shared exports update

  **What to do**:
  - Update `src/shared/index.ts` to export AuditService, AuditServiceLayer, and withAudit from `./audit`
  - Create integration test in `tests/audit.test.ts` (append to existing file from Task 1) or `tests/integration.test.ts` (append):
    - Run `bun agent-tools-gh --help` via `Bun.spawn` — assert exit 0, no crash
    - Run `bun agent-tools-k8s --help` via `Bun.spawn` — assert exit 0
    - Verify `~/.agent-tools/audit.sqlite` exists (it may not from --help since --help short-circuits, but DB file should be created by Layer acquire)
    - If DB exists, query it and verify schema: `audit_log` table with correct columns
  - Run `bun run check` to verify everything passes end-to-end

  **Must NOT do**:
  - Do NOT add new features beyond exports and integration tests

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small file additions + test runs
  - **Skills**: `["effect-ts", "testing-patterns"]`
    - `effect-ts`: Verify Effect patterns in integration
    - `testing-patterns`: Integration test patterns

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (solo)
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 2, 3, 4, 5, 6, 7

  **References**:
  - `src/shared/index.ts:1-17` — Current exports barrel file — add audit exports here
  - `tests/integration.test.ts` — May contain existing integration tests; append to this file if it exists
  - `tests/config-loader.test.ts` — Test import and assertion patterns

  **Acceptance Criteria**:
  - [ ] `src/shared/index.ts` exports audit symbols
  - [ ] `bun run check` passes (all checks: format, lint, typecheck, effect diagnostics, test)
  - [ ] All 6 tools exit 0 on `--help`

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Full check suite passes
    Tool: Bash
    Steps:
      1. Run: bun run check
      2. Assert exit code 0
    Expected Result: All checks pass
    Failure Indicators: Non-zero exit, any FAIL/ERROR in output
    Evidence: .sisyphus/evidence/task-8-check.txt

  Scenario: All tools functional
    Tool: Bash
    Steps:
      1. Run: bun agent-tools-gh --help && echo OK
      2. Run: bun agent-tools-k8s --help && echo OK
      3. Run: bun agent-tools-db --help && echo OK
      4. Run: bun agent-tools-az --help && echo OK
      5. Run: bun agent-tools-logs --help && echo OK
      6. Run: bun agent-tools-session --help && echo OK
      7. Assert all printed OK
    Expected Result: All 6 tools exit 0
    Evidence: .sisyphus/evidence/task-8-all-tools.txt

  Scenario: Audit DB resilience
    Tool: Bash
    Steps:
      1. Remove audit DB if exists: rm -f ~/.agent-tools/audit.sqlite
      2. Run: bun agent-tools-gh --help
      3. Assert exit code 0 (tool works even when DB doesn't exist yet / is recreated)
    Expected Result: Tool runs successfully, DB may be created by layer acquire
    Evidence: .sisyphus/evidence/task-8-resilience.txt
  ```

  **Commit**: YES (group with all tasks)
  - Message: `feat(audit): add SQLite operation audit logging to all CLI tools`
  - Files: `src/shared/index.ts`, `tests/audit.test.ts` or `tests/integration.test.ts`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
      Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
      Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`, skills: `["effect-ts"]`
      Run `bun run check`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify `ServiceMap.Service` pattern used (not `Context.Tag`). Verify `Effect.try`/`Effect.sync` used for bun:sqlite (not `Effect.promise`).
      Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
      Start from clean state. Run each of the 6 tools with `--help` and one real command. Verify `~/.agent-tools/audit.sqlite` exists and contains entries. Test edge cases: delete DB and run tool (should recreate), corrupt DB (should not crash tool), run two tools simultaneously.
      Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
      For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Flag unaccounted changes.
      Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| #   | Contents                                                        | Message                                                            |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | All implementation (audit service + all 6 tool wirings + tests) | `feat(audit): add SQLite operation audit logging to all CLI tools` |

Pre-commit: `bun run check`

---

## Success Criteria

### Verification Commands

```bash
bun run check                    # Expected: all pass
bun agent-tools-gh --help        # Expected: exit 0, no audit errors
bun agent-tools-k8s --help       # Expected: exit 0, no audit errors
bun -e "import { Database } from 'bun:sqlite'; import { homedir } from 'os'; const db = new Database(homedir() + '/.agent-tools/audit.sqlite', { readonly: true }); console.log(JSON.stringify(db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 5').all(), null, 2))"
# Expected: JSON array with audit entries
```

### Final Checklist

- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] All 6 tools audited
- [ ] Fire-and-forget verified (DB deletion doesn't crash tools)
