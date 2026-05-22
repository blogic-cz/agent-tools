# Agent Tools API Ergonomics Overhaul

## TL;DR

> **Quick Summary**: Implement all 6 research-backed ergonomic improvements to agent-tools CLI — from config defaults and actionable error recovery to structured subcommands, composite PR workflows, and a fixture-based eval harness that measures whether agents can actually use these tools effectively.
>
> **Deliverables**:
>
> - Config-level `defaultEnvironment` eliminating redundant `--env` on every call
> - Recovery hints (`nextCommand`, `retryable`, `hint`) in all error payloads
> - 5 structured k8s subcommands replacing raw `--cmd` for common operations
> - Restructured az-tool build subcommands as proper Effect CLI commands
> - 2 PR composite commands for common review workflows
> - Eval harness with 20-30 tasks, fixture runner, and baseline scores
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 7 waves
> **Critical Path**: Task 1→5→10 (config schema → per-tool wiring → structured commands)

---

## Context

### Original Request

User asked: "Je naše API ergonomické pre LLM agentov? Ako to otestovať? Zistiť?" — then after comprehensive analysis (5 background agents: 3 explore, 2 librarian, 1 Oracle), user said "vypracuj plan a sprav vsetko co navrhujses — chceme vsetko."

### Interview Summary

**Key Research Findings**:

- Queen's University 2026 study: 97.1% of MCP tools have at least one description "smell". Our tools are above average but improvable.
- ToolScan taxonomy: IAV (Incorrect Argument Value) is the #1 failure mode — caused by unnecessary required params without good defaults.
- Anthropic engineering blog: "consolidation over proliferation" + "new hire mental model" + actionable error recovery.
- Oracle assessment: "API is already close to LLM-friendly. Needs defaulting + task-level shortcuts + recovery hints layer."

**Technical Decisions**:

- Uses `effect/unstable/cli` with `Flag` API (not stable `@effect/cli` with `Options`) — all new code MUST use `Flag.*`
- TOON output format already default ✅ — no change needed
- `--cmd` kept as escape hatch for k8s/az, not removed
- Config schema extended via `Schema.optionalKey()` for backward compatibility

### Metis Review

**Identified Gaps** (addressed):

- `Flag.optional()` + config resolution in handler is the correct mechanism for defaultEnvironment — no custom machinery needed
- Truncation with steering (Anthropic pattern) should apply to success responses too, not just errors
- Eval harness should use Data→Task→Scores pattern (Braintrust-style)
- All new commands must match existing `Flag.*` patterns from `effect/unstable/cli`

---

## Work Objectives

### Core Objective

Reduce agent cognitive load, improve first-try success rate, and establish measurable ergonomics evaluation — backed by research from Queen's University, Anthropic, and ToolScan benchmarks.

### Concrete Deliverables

- Extended `AgentToolsConfig` type with `defaultEnvironment` field
- Updated JSON schema (`schemas/agent-tools.schema.json`) with new config option
- Extended `BaseResult` type with recovery hint fields
- Recovery hints implemented for all tagged error types across all 6 tools
- 5 structured k8s subcommands: `pods`, `logs`, `describe`, `exec`, `top`
- az-tool build commands restructured as proper Effect CLI subcommands
- 2 PR composite commands: `review-triage`, `reply-and-resolve`
- Eval harness: task definitions, fixture runner, baseline scores
- Updated SKILL.md, README.md, examples/agent-tools.json5

### Definition of Done

- [x] `bun run check` passes (format + lint + typecheck + effect diagnostics + test)
- [x] All existing tests still pass (zero regressions)
- [x] New features have corresponding tests
- [x] Eval harness runs and produces scored results
- [x] SKILL.md reflects all new commands and patterns

### Must Have

- Breaking changes ARE ALLOWED — existing commands, flags, config files, and output shapes may change (package has no users yet)
- `--cmd` escape hatch preserved for k8s-tool and az-tool
- All existing granular PR commands preserved alongside new composites
- Config without `defaultEnvironment` must work (field is optional)
- TOON and JSON output formats both supported for all new commands
- Eval tasks cover all 6 tools, not just gh-tool

### Must NOT Have (Guardrails)

- DO NOT make `--env` implicit for prod environment — prod must always be explicit for safety
- DO NOT consolidate the 6 binaries into one — domain separation is a strength
- DO NOT over-abstract — no generic "tool framework" or "plugin system"
- DO NOT add dependencies — use only existing deps (Effect, @toon-format/toon)
- DO NOT create MCP server wrappers — these are CLI tools, not MCP
- DO NOT touch credential-guard logic — it works, don't break it
- Breaking changes to existing flag names, command names, or output shapes ARE ALLOWED (package has no users yet)

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES
- **Automated tests**: YES (Tests-after — matching existing codebase pattern)
- **Framework**: vitest + @effect/vitest (already configured)

### QA Policy

Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **CLI tools**: Use Bash — run commands, assert exit codes + output structure
- **Config**: Use Bash — test with/without config fields, verify resolution
- **Eval harness**: Use Bash — run eval, verify scores output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — shared foundation, all parallel):
├── Task 1: Extend config types + JSON schema with defaultEnvironment [quick]
├── Task 2: Extend BaseResult with recovery hint fields [quick]
├── Task 3: Add getDefaultEnvironment() config resolver helper [quick]
└── Task 4: Eval harness scaffolding — types + directory structure [quick]

Wave 2 (After Wave 1 — per-tool defaultEnvironment + error hints, all parallel):
├── Task 5: db-tool: optional --env with config fallback + error recovery hints [unspecified-high]
├── Task 6: k8s-tool: optional --env with config fallback + error recovery hints [unspecified-high]
├── Task 7: logs-tool: optional --env with config fallback + error recovery hints [unspecified-high]
├── Task 8: gh-tool: error recovery hints for all error types [unspecified-high]
└── Task 9: az-tool: error recovery hints for all error types [unspecified-high]

Wave 3 (After Wave 2 — new commands, all parallel):
├── Task 10: k8s structured subcommands: pods, logs, describe, exec, top [deep]
├── Task 11: az build subcommands restructured as proper Effect CLI commands [unspecified-high]
└── Task 12: PR composite commands: review-triage, reply-and-resolve [unspecified-high]

Wave 4 (After Wave 3 — tests for new features, all parallel):
├── Task 13: Tests for k8s structured subcommands [unspecified-high]
├── Task 14: Tests for az build subcommands [unspecified-high]
├── Task 15: Tests for PR composite commands [unspecified-high]
├── Task 16: Tests for defaultEnvironment (config + per-tool resolution) [quick]
└── Task 17: Tests for error recovery hints (cross-tool) [quick]

Wave 5 (After Wave 4 — eval harness implementation):
├── Task 18: Eval task definitions — 20-30 realistic agent tasks [deep]
├── Task 19: Eval runner — fixture-based execution with scoring [deep]
└── Task 20: Run baseline eval + record scores [unspecified-high]

Wave 6 (After Wave 5 — documentation + polish):
├── Task 21: Update SKILL.md with new commands and patterns [writing]
├── Task 22: Update README.md + examples/agent-tools.json5 [writing]
└── Task 23: Run bun run check — full verification + fix any issues [quick]

Wave FINAL (After ALL tasks — independent review, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 5 → Task 10 → Task 13 → Task 18 → Task 23 → F1-F4
Parallel Speedup: ~65% faster than sequential
Max Concurrent: 5 (Waves 2 & 4)
```

### Dependency Matrix

| Task | Depends On | Blocks        | Wave |
| ---- | ---------- | ------------- | ---- |
| 1    | —          | 3, 5, 6, 7    | 1    |
| 2    | —          | 5, 6, 7, 8, 9 | 1    |
| 3    | 1          | 5, 6, 7       | 1    |
| 4    | —          | 18, 19        | 1    |
| 5    | 1, 2, 3    | 10, 16        | 2    |
| 6    | 1, 2, 3    | 10, 16        | 2    |
| 7    | 1, 2, 3    | 16            | 2    |
| 8    | 2          | 12, 17        | 2    |
| 9    | 2          | 11, 17        | 2    |
| 10   | 6          | 13            | 3    |
| 11   | 9          | 14            | 3    |
| 12   | 8          | 15            | 3    |
| 13   | 10         | 18            | 4    |
| 14   | 11         | 18            | 4    |
| 15   | 12         | 18            | 4    |
| 16   | 5, 6, 7    | 18            | 4    |
| 17   | 8, 9       | 18            | 4    |
| 18   | 13-17      | 19            | 5    |
| 19   | 4, 18      | 20            | 5    |
| 20   | 19         | 23            | 5    |
| 21   | 10-12      | 23            | 6    |
| 22   | 1, 10-12   | 23            | 6    |
| 23   | 20, 21, 22 | F1-F4         | 6    |

### Agent Dispatch Summary

- **Wave 1**: **4 tasks** — T1-T4 → `quick`
- **Wave 2**: **5 tasks** — T5-T9 → `unspecified-high`
- **Wave 3**: **3 tasks** — T10 → `deep`, T11-T12 → `unspecified-high`
- **Wave 4**: **5 tasks** — T13-T15 → `unspecified-high`, T16-T17 → `quick`
- **Wave 5**: **3 tasks** — T18-T19 → `deep`, T20 → `unspecified-high`
- **Wave 6**: **3 tasks** — T21-T22 → `writing`, T23 → `quick`
- **FINAL**: **4 tasks** — F1 → `oracle`, F2-F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.
> **A task WITHOUT QA Scenarios is INCOMPLETE. No exceptions.**
> **Version control: Use `but` (GitButler CLI) for all commits/pushes — NOT raw git.**

- [x] 1. Extend config types + JSON schema with `defaultEnvironment`

  **What to do**:

- In `src/config/types.ts`, add `defaultEnvironment?: string` to `AgentToolsConfig` (after line 81, before closing `}` at line 82).
- In `src/config/loader.ts`, add `defaultEnvironment: Schema.optionalKey(Schema.String)` to `AgentToolsConfigSchema` (around line 56-68, alongside existing `Schema.optionalKey` fields).
- In `schemas/agent-tools.schema.json`, add a top-level property `"defaultEnvironment"` in the `properties` block (after line 52), with `{ "type": "string", "description": "Optional default environment name used by tools when no --env flag is provided." }`.
  - In `examples/agent-tools.json5`, add `defaultEnvironment: "test"` with a comment explaining it (after line 3, before the azure section).

  **Must NOT do**:
  - Do NOT make `defaultEnvironment` influence prod — prod must always be explicit
  - Do NOT change existing config loading behavior for configs without this field

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4)
  - **Blocks**: Tasks 3, 5, 6, 7
  - **Blocked By**: None (can start immediately)

  **References**:
  - `src/config/types.ts:66-82` — `AgentToolsConfig` type, add new field here
  - `src/config/loader.ts:56-68` — `AgentToolsConfigSchema`, add Schema validation here
  - `src/shared/types.ts:2` — `Environment` type definition
  - `schemas/agent-tools.schema.json:8-53` — JSON Schema properties block
  - `examples/agent-tools.json5:1-4` — Example config, add defaultEnvironment

  **Acceptance Criteria**:

- [x] `AgentToolsConfig` type includes `defaultEnvironment?: string`
  - [ ] `AgentToolsConfigSchema` validates the new field
- [x] JSON Schema includes `defaultEnvironment` as optional string (no enum restriction)
  - [ ] Example config shows `defaultEnvironment: "test"`
  - [ ] Configs without `defaultEnvironment` still parse correctly

  **QA Scenarios:**

  ```
  Scenario: Config with defaultEnvironment parses correctly
    Tool: Bash
    Steps:
      1. Create temp config: `{ defaultEnvironment: "test", kubernetes: { default: { clusterId: "x", namespaces: { test: "ns" } } } }`
      2. Run: `bun run src/k8s-tool/index.ts --help` (just verifying no parse crash)
    Expected Result: Help output displayed, exit code 0
    Evidence: .sisyphus/evidence/task-1-config-parse.txt

  Scenario: Config without defaultEnvironment still works
    Tool: Bash
    Steps:
      1. Use existing example config without defaultEnvironment field
      2. Run: `bun run src/k8s-tool/index.ts --help`
    Expected Result: Help output, exit code 0 (backward compat)
    Evidence: .sisyphus/evidence/task-1-config-compat.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [x] 2. Extend `BaseResult` with recovery hint fields

  **What to do**:
  - In `src/shared/types.ts`, add three optional fields to `BaseResult` (after line 7):
    - `nextCommand?: string` — suggested next CLI command to run
    - `retryable?: boolean` — whether the operation can be retried
    - `hint?: string` — human/agent-readable recovery guidance
  - In `src/shared/format.ts`, ensure `formatOutput()` includes these fields in TOON output when present (verify it uses spread or explicit mapping).
  - In `src/shared/error-renderer.ts`, update `formatError()` (line 5) to include recovery hint fields when they exist on the error object. After the tag+message line, append hint if present.

  **Must NOT do**:
  - Do NOT make hint fields required — they must be optional
  - Do NOT change the existing error rendering for errors without hints

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3, 4)
  - **Blocks**: Tasks 5, 6, 7, 8, 9
  - **Blocked By**: None (can start immediately)

  **References**:
  - `src/shared/types.ts:4-8` — `BaseResult` type, add recovery fields here
  - `src/shared/format.ts` — `formatOutput()` and `formatAny()`, verify hint fields flow through
  - `src/shared/error-renderer.ts:5-23` — `formatError()`, include hints in stderr output
  - `src/shared/error-renderer.ts:42-43` — `renderCauseToStderr`, verify it uses formatError

  **Acceptance Criteria**:
  - [ ] `BaseResult` has `nextCommand?: string`, `retryable?: boolean`, `hint?: string`
  - [ ] Hints appear in TOON output when present
  - [ ] Hints appear in JSON output when present
  - [ ] Error rendering includes hint when available
  - [ ] Existing output unchanged when hints are absent

  **QA Scenarios:**

  ```
  Scenario: BaseResult with hints renders in TOON
    Tool: Bash
    Steps:
      1. Write a small test script that imports formatOutput and calls it with { success: false, error: "test", hint: "try X", nextCommand: "do Y", retryable: true, executionTimeMs: 0 }
      2. Run script and capture output
    Expected Result: TOON output contains hint, nextCommand, retryable fields
    Evidence: .sisyphus/evidence/task-2-hint-toon.txt

  Scenario: BaseResult without hints renders normally
    Tool: Bash
    Steps:
      1. Same script but with { success: true, executionTimeMs: 0 } (no hint fields)
    Expected Result: Output unchanged, no hint/nextCommand/retryable in output
    Evidence: .sisyphus/evidence/task-2-no-hint.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [x] 3. Add `getDefaultEnvironment()` config resolver helper

  **What to do**:
  - In `src/config/loader.ts`, add a new exported function after `getToolConfig()` (after line 170):
    ```typescript
    export function getDefaultEnvironment(
      config: AgentToolsConfig | undefined,
    ): Environment | undefined {
      return config?.defaultEnvironment;
    }
    ```
  - Export it from `src/config/index.ts`.
  - This is a simple accessor — tools will use it in their handlers to resolve `--env` when not provided.

  **Must NOT do**:
  - Do NOT return `"prod"` as a default — if not configured, return `undefined`

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 4)
  - **Blocks**: Tasks 5, 6, 7
  - **Blocked By**: Task 1 (needs `defaultEnvironment` field in config type)

  **References**:
  - `src/config/loader.ts:132-170` — `getToolConfig()` pattern to follow
  - `src/config/loader.ts:113-116` — `ConfigService` definition
  - `src/config/index.ts` — barrel exports, add `getDefaultEnvironment` here
  - `src/shared/types.ts:2` — `Environment` type

  **Acceptance Criteria**:
  - [ ] `getDefaultEnvironment()` exported from `src/config/index.ts`
  - [ ] Returns `undefined` when config is `undefined`
  - [ ] Returns `undefined` when `defaultEnvironment` not set in config
  - [ ] Returns the environment value when set
  - [ ] Never returns `"prod"` implicitly

  **QA Scenarios:**

  ```
  Scenario: getDefaultEnvironment returns configured value
    Tool: Bash
    Steps:
      1. Write test script: import { getDefaultEnvironment } from config, call with { defaultEnvironment: "test" }
    Expected Result: Returns "test"
    Evidence: .sisyphus/evidence/task-3-default-env.txt

  Scenario: getDefaultEnvironment returns undefined for missing config
    Tool: Bash
    Steps:
      1. Call getDefaultEnvironment(undefined)
    Expected Result: Returns undefined
    Evidence: .sisyphus/evidence/task-3-undefined.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [x] 4. Eval harness scaffolding — types + directory structure

  **What to do**:
  - Create `tests/eval/` directory with:
    - `types.ts` — Define `EvalTask` (id, tool, description, input, expectedPattern), `EvalScore` (taskId, passed, score 0-1, details), `EvalReport` (tasks, scores, summary)
    - `tasks.ts` — Empty array export `export const evalTasks: EvalTask[] = []` (filled in Task 18)
    - `runner.ts` — Stub: `export function runEval(tasks: EvalTask[]): EvalReport { ... }` (implemented in Task 19)
    - `run.ts` — Entry: imports tasks and runner, calls `runEval`, prints report
    - `fixtures/` — Empty directory with `.gitkeep`
    - `baseline.json` — Empty object `{}` (populated in Task 20)
  - This is pure scaffolding — no implementation logic yet, just types and directory structure.

  **Must NOT do**:
  - Do NOT implement eval logic — that's Task 18-19
  - Do NOT add external dependencies

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2, 3)
  - **Blocks**: Tasks 18, 19
  - **Blocked By**: None (can start immediately)

  **References**:
  - `tests/` — Existing test directory structure
  - `src/shared/types.ts` — Type definition patterns to follow

  **Acceptance Criteria**:
  - [ ] `tests/eval/types.ts` has `EvalTask`, `EvalScore`, `EvalReport` types
  - [ ] `tests/eval/tasks.ts` exports empty array
  - [ ] `tests/eval/runner.ts` has stub function
  - [ ] `tests/eval/run.ts` can be executed without errors (prints empty report)
  - [ ] `tests/eval/fixtures/` directory exists
  - [ ] `tests/eval/baseline.json` exists with `{}`

  **QA Scenarios:**

  ```
  Scenario: Eval harness scaffold runs without error
    Tool: Bash
    Steps:
      1. Run: `bun run tests/eval/run.ts`
    Expected Result: Exit code 0, prints empty or stub report
    Evidence: .sisyphus/evidence/task-4-eval-scaffold.txt

  Scenario: Types compile correctly
    Tool: Bash
    Steps:
      1. Run: `bunx tsc --noEmit tests/eval/types.ts`
    Expected Result: No type errors
    Evidence: .sisyphus/evidence/task-4-types-check.txt
  ```

  **Commit**: YES
  - Message: `feat(config,shared,eval): add defaultEnvironment, recovery hints, eval scaffold`
  - Files: `src/config/types.ts`, `src/config/loader.ts`, `src/config/index.ts`, `src/shared/types.ts`, `src/shared/format.ts`, `src/shared/error-renderer.ts`, `schemas/agent-tools.schema.json`, `examples/agent-tools.json5`, `tests/eval/`
  - Pre-commit: `bun run check`

- [x] 5. db-tool: optional `--env` with config fallback + error recovery hints

  **What to do**:
  - In `src/db-tool/index.ts`, change `--env` from required `Flag.string("env")` (lines 21, 41) to optional: `Flag.optional(Flag.choice("env", ["local", "test", "prod"]))`. In the handler, resolve: `const envValue = Option.getOrUndefined(env) ?? getDefaultEnvironment(config)`. If still undefined, return error with hint.
  - In `src/db-tool/errors.ts`, add recovery hint fields to each error class:
    - `DbConnectionError` (line 3): add `hint: Schema.optionalKey(Schema.String)`, `nextCommand: Schema.optionalKey(Schema.String)`, `retryable: Schema.optionalKey(Schema.Boolean)`
    - Same for `DbQueryError` (line 11), `DbTunnelError` (line 17), `DbParseError` (line 22), `DbMutationBlockedError` (line 27)
  - In the error handlers in `index.ts`, populate hints. E.g. `DbConnectionError` → `hint: "Check if the database is running and accessible"`, `nextCommand: "agent-tools-db sql --env test --sql \"SELECT 1\""`.

  **Must NOT do**:
  - Do NOT default to prod when `--env` is omitted and no `defaultEnvironment` is set — fail with clear error and hint

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 6, 7, 8, 9)
  - **Blocks**: Tasks 10, 16
  - **Blocked By**: Tasks 1, 2, 3

  **References**:
  - `src/db-tool/index.ts:21` — `sql` command `--env` flag (currently `Flag.string("env")`)
  - `src/db-tool/index.ts:41` — `schema` command `--env` flag (same pattern)
  - `src/db-tool/errors.ts:3-33` — All 5 error classes to extend with hints
  - `src/config/loader.ts:132-170` — `getToolConfig()` for config access in handler
  - `src/k8s-tool/index.ts:16-18` — Pattern for `Flag.choice("env", [...])` with `Flag.withDescription`

  **Acceptance Criteria**:
  - [ ] `--env` is optional on both `sql` and `schema` commands
  - [ ] When `--env` omitted, uses `defaultEnvironment` from config
  - [ ] When neither provided, returns error with `hint` explaining what to do
  - [ ] All 5 error classes have `hint`, `nextCommand`, `retryable` optional fields
  - [ ] Error responses include populated hints

  **QA Scenarios:**

  ```
  Scenario: db-tool sql without --env uses defaultEnvironment
    Tool: Bash
    Steps:
      1. Create config with `defaultEnvironment: "test"` and a test db environment
      2. Run: `bun run src/db-tool/index.ts sql --sql "SELECT 1"` (no --env)
    Expected Result: Uses test environment (may fail connecting but should NOT error about missing --env)
    Evidence: .sisyphus/evidence/task-5-db-default-env.txt

  Scenario: db-tool fails gracefully when no env available
    Tool: Bash
    Steps:
      1. Use config WITHOUT defaultEnvironment
      2. Run: `bun run src/db-tool/index.ts sql --sql "SELECT 1"` (no --env)
    Expected Result: Error with hint field explaining how to set --env or defaultEnvironment
    Evidence: .sisyphus/evidence/task-5-db-no-env-error.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [x] 6. k8s-tool: optional `--env` with config fallback + error recovery hints

  **What to do**:
  - In `src/k8s-tool/index.ts`, change `--env` from required `Flag.choice("env", ["test", "prod"])` (line 16) to optional: `Flag.optional(Flag.choice("env", ["test", "prod"]))`. In handler, resolve via `getDefaultEnvironment(config)` fallback. If env is `"prod"`, ALWAYS require explicit `--env prod` (never implicit).
  - In `src/k8s-tool/errors.ts`, add `hint`, `nextCommand`, `retryable` optional fields to all 3 error classes:
    - `K8sContextError` (line 3) → `hint: "Verify cluster ID in config matches your kubectl config"`
    - `K8sCommandError` (line 8) → `hint: "Check command syntax with kubectl --help"`
    - `K8sTimeoutError` (line 15) → `hint: "Increase timeoutMs in config or simplify command"`, `retryable: true`
  - Note: Currently `--env` is used in the description but NOT consumed in the handler (line 32 destructures `{ cmd, dryRun, format, profile }` only). Fix this: env should resolve the namespace from `k8sConfig.namespaces[env]`.

  **Must NOT do**:
  - Do NOT allow implicit prod access — if `defaultEnvironment` is `"prod"`, still require explicit `--env prod`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 7, 8, 9)
  - **Blocks**: Tasks 10, 16
  - **Blocked By**: Tasks 1, 2, 3

  **References**:
  - `src/k8s-tool/index.ts:16-18` — `--env` flag definition
  - `src/k8s-tool/index.ts:32` — Handler destructuring (env NOT consumed currently)
  - `src/k8s-tool/errors.ts:3-21` — All 3 error classes
  - `src/k8s-tool/service.ts:10-22` — `K8sService` interface
  - `src/k8s-tool/service.ts:165-181` — `runCommand` (takes env param but unused)

  **Acceptance Criteria**:
  - [ ] `--env` is optional on `kubectl` command
  - [ ] Config fallback works for non-prod environments
  - [ ] Prod requires explicit `--env prod` even with `defaultEnvironment: "prod"`
  - [ ] All 3 error classes have hint fields
  - [ ] Error responses include populated hints

  **QA Scenarios:**

  ```
  Scenario: k8s-tool without --env uses defaultEnvironment
    Tool: Bash
    Steps:
      1. Run: `bun run src/k8s-tool/index.ts kubectl --cmd "get pods -n test-ns"` (no --env)
    Expected Result: Uses defaultEnvironment from config (or error with hint if not configured)
    Evidence: .sisyphus/evidence/task-6-k8s-default-env.txt

  Scenario: k8s-tool error includes recovery hints
    Tool: Bash
    Steps:
      1. Run with invalid cluster config to trigger K8sContextError
    Expected Result: Error output includes hint field with guidance
    Evidence: .sisyphus/evidence/task-6-k8s-error-hints.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [x] 7. logs-tool: optional `--env` with config fallback + error recovery hints

  **What to do**:
  - In `src/logs-tool/index.ts`, change `--env` from required `Flag.choice("env", ["local", "test", "prod"])` (lines 59, 98) to optional: `Flag.optional(Flag.choice("env", ["local", "test", "prod"]))`. In handlers, resolve via `getDefaultEnvironment(config)` fallback.
  - The logs-tool currently doesn't load config via `ConfigService`. Add `ConfigServiceLayer` to `MainLayer` (line 170) and inject `ConfigService` in handlers.
  - In `src/logs-tool/errors.ts`, add `hint`, `nextCommand`, `retryable` optional fields to all 4 error classes:
    - `LogsNotFoundError` (line 3) → `hint: "Check if log directory exists"`
    - `LogsReadError` (line 11) → `hint: "Verify file permissions"`
    - `LogsConfigError` (line 16) → `hint: "Add logs section to agent-tools.json5"`
    - `LogsTimeoutError` (line 20) → `retryable: true`

  **Must NOT do**:
  - Do NOT break existing log reading logic

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6, 8, 9)
  - **Blocks**: Task 16
  - **Blocked By**: Tasks 1, 2, 3

  **References**:
  - `src/logs-tool/index.ts:59` — `list` command `--env` flag
  - `src/logs-tool/index.ts:98` — `read` command `--env` flag
  - `src/logs-tool/index.ts:170` — `MainLayer` (needs `ConfigServiceLayer`)
  - `src/logs-tool/errors.ts:3-29` — All 4 error classes

  **Acceptance Criteria**:
  - [ ] `--env` is optional on both `list` and `read` commands
  - [ ] Config fallback works correctly
  - [ ] All 4 error classes have hint fields

  **QA Scenarios:**

  ```
  Scenario: logs-tool list without --env uses config fallback
    Tool: Bash
    Steps:
      1. Run: `bun run src/logs-tool/index.ts list` (no --env)
    Expected Result: Uses defaultEnvironment from config (or helpful error if not configured)
    Evidence: .sisyphus/evidence/task-7-logs-default-env.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [x] 8. gh-tool: error recovery hints for all error types

  **What to do**:
  - In `src/gh-tool/errors.ts`, add `hint`, `nextCommand`, `retryable` optional fields to all 5 error classes:
    - `GitHubCommandError` (line 3) → generic command failure hints
    - `GitHubNotFoundError` (line 13) → `hint: "Verify the PR/issue number exists"`, `nextCommand: "agent-tools-gh pr list"`
    - `GitHubAuthError` (line 22) → `hint: "Run 'gh auth login' or set GITHUB_TOKEN"`, `retryable: false`
    - `GitHubMergeError` (line 26) → reason-specific hints (conflicts → "Resolve merge conflicts first", checks_failing → "Wait for CI to pass")
    - `GitHubTimeoutError` (line 34) → `retryable: true`
  - Update error construction sites in `src/gh-tool/pr/core.ts` and `src/gh-tool/pr/review.ts` to populate hints.

  **Must NOT do**:
  - Do NOT change existing error flow or error types

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6, 7, 9)
  - **Blocks**: Tasks 12, 17
  - **Blocked By**: Task 2

  **References**:
  - `src/gh-tool/errors.ts:3-47` — All 5 error classes
  - `src/gh-tool/pr/core.ts` — Where errors are constructed (viewPR, mergePR, etc.)
  - `src/gh-tool/pr/review.ts:412,509` — `replyToComment`, `resolveThread` error sites
  - `src/gh-tool/service.ts` — GitHubService where low-level errors originate

  **Acceptance Criteria**:
  - [ ] All 5 error classes have optional hint, nextCommand, retryable fields
  - [ ] GitHubMergeError has reason-specific hints
  - [ ] GitHubAuthError hints include `gh auth login` guidance

  **QA Scenarios:**

  ```
  Scenario: gh-tool auth error includes recovery hint
    Tool: Bash
    Steps:
      1. Temporarily unset GITHUB_TOKEN and trigger a gh command
    Expected Result: Error output includes hint about authentication
    Evidence: .sisyphus/evidence/task-8-gh-auth-hint.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [x] 9. az-tool: error recovery hints for all error types

  **What to do**:
  - In `src/az-tool/errors.ts`, add `hint`, `nextCommand`, `retryable` optional fields to all 4 error classes:
    - `AzSecurityError` (line 3) → `hint: "This command is blocked for security"`
    - `AzCommandError` (line 8) → `hint` based on context
    - `AzTimeoutError` (line 15) → `retryable: true`
    - `AzParseError` (line 21) → `hint: "API response format may have changed"`
  - Update error construction in `src/az-tool/index.ts` (`invalidBuildCommand` at line 153) and `src/az-tool/build.ts` to include hints.

  **Must NOT do**:
  - Do NOT change the az command execution flow

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6, 7, 8)
  - **Blocks**: Tasks 11, 17
  - **Blocked By**: Task 2

  **References**:
  - `src/az-tool/errors.ts:3-26` — All 4 error classes
  - `src/az-tool/index.ts:153-162` — `invalidBuildCommand()` error factory
  - `src/az-tool/build.ts:11,82,120,164,201` — Build functions where errors originate

  **Acceptance Criteria**:
  - [ ] All 4 error classes have optional hint, nextCommand, retryable fields
  - [ ] Build command errors include helpful hints

  **QA Scenarios:**

  ```
  Scenario: az-tool invalid command shows recovery hint
    Tool: Bash
    Steps:
      1. Run: `bun run src/az-tool/index.ts --cmd "build invalid-action --build-id 123"`
    Expected Result: Error with hint listing valid build actions
    Evidence: .sisyphus/evidence/task-9-az-hint.txt
  ```

  **Commit**: YES
  - Message: `feat(tools): wire defaultEnvironment + error recovery hints across all tools`
  - Files: `src/db-tool/`, `src/k8s-tool/`, `src/logs-tool/`, `src/gh-tool/`, `src/az-tool/`
  - Pre-commit: `bun run check`

- [x] 10. k8s structured subcommands: `pods`, `logs`, `describe`, `exec`, `top`

  **What to do**:
  - Create 5 new Effect CLI subcommands in `src/k8s-tool/` that replace common `--cmd` patterns with typed, discoverable commands:
    - `pods` — `kubectl get pods -n <namespace>` with optional `--label`, `--wide` flags
    - `logs` — `kubectl logs <pod> -n <namespace>` with `--tail`, `--follow`, `--container` flags
    - `describe` — `kubectl describe <resource> <name> -n <namespace>`
    - `exec` — `kubectl exec <pod> -n <namespace> -- <command>` with `--container` flag
    - `top` — `kubectl top pod -n <namespace>` with optional `--sort-by`
  - Each subcommand reuses `K8sService.runCommand()` (service.ts:165) or `K8sService.runKubectl()` (service.ts:183) to execute.
  - Each subcommand takes `--env` (optional, with config fallback from Task 6) and `--namespace` (optional, resolved from `k8sConfig.namespaces[env]`).
  - Register all 5 as subcommands alongside existing `kubectl` in `index.ts` (line 133-136).
  - Keep `kubectl` subcommand as escape hatch for arbitrary commands.

  **Must NOT do**:
  - Do NOT remove the existing `kubectl` subcommand — it stays as escape hatch
  - Do NOT add new dependencies

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 11, 12)
  - **Blocks**: Task 13
  - **Blocked By**: Task 6

  **References**:
  - `src/k8s-tool/index.ts:13-131` — Existing `kubectlCommand` pattern to follow for flags + handler
  - `src/k8s-tool/index.ts:133-136` — Main command + subcommand registration
  - `src/k8s-tool/service.ts:183-217` — `runKubectl()` — reuse for executing commands
  - `src/k8s-tool/service.ts:141-163` — `executeCommand()` — lower-level kubectl execution
  - `src/gh-tool/pr/commands.ts:40-55` — Example of clean `Command.make()` + `Flag.*` pattern

  **Acceptance Criteria**:
  - [ ] 5 new subcommands registered: `pods`, `logs`, `describe`, `exec`, `top`
  - [ ] Each has typed flags (not string parsing)
  - [ ] Each uses `--env` with config fallback
  - [ ] `kubectl` escape hatch still works
  - [ ] `--help` shows all 6 subcommands

  **QA Scenarios:**

  ```
  Scenario: k8s-tool --help lists all subcommands
    Tool: Bash
    Steps:
      1. Run: `bun run src/k8s-tool/index.ts --help`
    Expected Result: Help output lists pods, logs, describe, exec, top, kubectl
    Evidence: .sisyphus/evidence/task-10-k8s-help.txt

  Scenario: k8s-tool pods has typed flags
    Tool: Bash
    Steps:
      1. Run: `bun run src/k8s-tool/index.ts pods --help`
    Expected Result: Shows --env, --namespace, --label, --wide flags
    Evidence: .sisyphus/evidence/task-10-k8s-pods-help.txt
  ```

  **Commit**: NO (groups with Wave 3)

- [x] 11. az-tool: restructure build commands as proper Effect CLI subcommands

  **What to do**:
  - Replace the string-based dispatch in `runBuildHelperCommand()` (index.ts:98-151) with proper Effect CLI subcommands:
    - Create `src/az-tool/build-commands.ts` with typed subcommands:
      - `build timeline --build-id <N>` → calls `getBuildTimeline()` (build.ts:11)
      - `build failed-jobs --build-id <N>` → calls `findFailedJobs()` (build.ts:201)
      - `build logs --build-id <N>` → calls `getBuildLogs()` (build.ts:82)
      - `build log-content --build-id <N> --log-id <N>` → calls `getBuildLogContent()` (build.ts:120)
      - `build summary --build-id <N>` → calls `getBuildJobSummary()` (build.ts:164)
    - Each uses `Flag.integer("build-id")` and `Flag.integer("log-id")` instead of string parsing.
  - Create a `build` parent command that groups these 5 subcommands.
  - Update `src/az-tool/index.ts` to register the `build` command as a subcommand alongside the raw `--cmd` handler.
  - Remove `runBuildHelperCommand()`, `invalidBuildCommand()`, and `parseRequiredIntOption()` from index.ts.

  **Must NOT do**:
  - Do NOT remove the raw `--cmd` escape hatch for non-build az commands
  - Do NOT change the build function signatures in `build.ts`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10, 12)
  - **Blocks**: Task 14
  - **Blocked By**: Task 9

  **References**:
  - `src/az-tool/index.ts:98-151` — `runBuildHelperCommand()` to replace
  - `src/az-tool/index.ts:153-181` — `invalidBuildCommand()`, `parseRequiredIntOption()` to remove
  - `src/az-tool/build.ts:11,82,120,164,201` — 5 build functions to wire as subcommands
  - `src/k8s-tool/index.ts:133-136` — Pattern for subcommand registration

  **Acceptance Criteria**:
  - [ ] 5 build subcommands available: `timeline`, `failed-jobs`, `logs`, `log-content`, `summary`
  - [ ] All use typed `Flag.integer()` for `--build-id` and `--log-id`
  - [ ] `runBuildHelperCommand()` removed from index.ts
  - [ ] Raw `--cmd` still works for non-build az commands
  - [ ] `--help` shows build subcommands

  **QA Scenarios:**

  ```
  Scenario: az-tool build --help lists subcommands
    Tool: Bash
    Steps:
      1. Run: `bun run src/az-tool/index.ts build --help`
    Expected Result: Lists timeline, failed-jobs, logs, log-content, summary
    Evidence: .sisyphus/evidence/task-11-az-build-help.txt

  Scenario: az-tool build timeline has typed --build-id flag
    Tool: Bash
    Steps:
      1. Run: `bun run src/az-tool/index.ts build timeline --help`
    Expected Result: Shows --build-id flag with integer type
    Evidence: .sisyphus/evidence/task-11-az-timeline-help.txt
  ```

  **Commit**: NO (groups with Wave 3)

- [x] 12. PR composite commands: `review-triage` and `reply-and-resolve`

  **What to do**:
  - Create 2 new composite commands in `src/gh-tool/pr/commands.ts` that compose existing review functions:
    - `review-triage` — Single command that returns: PR info (via `viewPR`), unresolved threads (via `fetchThreads`), discussion summary (via `fetchDiscussionSummary`), and CI status (via `fetchChecks`). One call instead of 4.
    - `reply-and-resolve` — Replies to a comment AND resolves its thread in one call. Takes `--pr`, `--comment-id`, `--thread-id`, `--body`. Calls `replyToComment()` then `resolveThread()`.
  - Register both in `src/gh-tool/index.ts` alongside existing PR subcommands (line 49-67).
  - Follow the exact same `Command.make()` + `Flag.*` + `Effect.gen` pattern used by existing commands.

  **Must NOT do**:
  - Do NOT remove or modify existing granular commands — composites are additive

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["effect-ts"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10, 11)
  - **Blocks**: Task 15
  - **Blocked By**: Task 8

  **References**:
  - `src/gh-tool/pr/commands.ts:40-55` — `prViewCommand` pattern to follow
  - `src/gh-tool/pr/commands.ts:219-238` — `prThreadsCommand` pattern
  - `src/gh-tool/pr/commands.ts:346-363` — `prDiscussionSummaryCommand` pattern
  - `src/gh-tool/pr/review.ts:175` — `fetchThreads()` to compose
  - `src/gh-tool/pr/review.ts:369` — `fetchDiscussionSummary()` to compose
  - `src/gh-tool/pr/review.ts:412` — `replyToComment()` to compose
  - `src/gh-tool/pr/review.ts:509` — `resolveThread()` to compose
  - `src/gh-tool/pr/core.ts` — `viewPR()`, `fetchChecks()` to compose
  - `src/gh-tool/index.ts:47-68` — PR subcommand registration

  **Acceptance Criteria**:
  - [ ] `review-triage` command registered under `pr` subgroup
  - [ ] `reply-and-resolve` command registered under `pr` subgroup
  - [ ] `review-triage` returns combined PR info + threads + summary + checks
  - [ ] `reply-and-resolve` replies then resolves in sequence
  - [ ] All existing PR commands still work

  **QA Scenarios:**

  ```
  Scenario: review-triage appears in pr --help
    Tool: Bash
    Steps:
      1. Run: `bun run src/gh-tool/index.ts pr --help`
    Expected Result: Lists review-triage and reply-and-resolve alongside existing commands
    Evidence: .sisyphus/evidence/task-12-pr-help.txt

  Scenario: review-triage --help shows correct flags
    Tool: Bash
    Steps:
      1. Run: `bun run src/gh-tool/index.ts pr review-triage --help`
    Expected Result: Shows --pr (optional), --format flags
    Evidence: .sisyphus/evidence/task-12-review-triage-help.txt
  ```

  **Commit**: YES
  - Message: `feat(k8s,az,gh): add structured subcommands and PR composites`
  - Files: `src/k8s-tool/`, `src/az-tool/`, `src/gh-tool/pr/`
  - Pre-commit: `bun run check`

- [x] 13. Tests for k8s structured subcommands

  **What to do**:
  - In `tests/k8s-tool.test.ts`, add tests for the 5 new subcommands: `pods`, `logs`, `describe`, `exec`, `top`.
  - Follow existing test patterns: mock `K8sService` via Effect Layer, verify command construction and output formatting.
  - Test both TOON and JSON output formats.
  - Test `--env` optional resolution with and without `defaultEnvironment`.
  - Test error cases with recovery hints.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["effect-ts", "testing-patterns"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 14, 15, 16, 17)
  - **Blocks**: Task 18
  - **Blocked By**: Task 10

  **References**:
  - `tests/k8s-tool.test.ts` — Existing k8s tests, follow same mock pattern
  - `tests/gh-tool.test.ts` — Most comprehensive test file, reference for complex mocking

  **Acceptance Criteria**:
  - [ ] Tests for all 5 subcommands (pods, logs, describe, exec, top)
  - [ ] Tests for --env optional resolution
  - [ ] Tests for error hint fields
  - [ ] `bun test tests/k8s-tool.test.ts` passes

  **QA Scenarios:**

  ```
  Scenario: k8s tests pass
    Tool: Bash
    Steps:
      1. Run: `bun test tests/k8s-tool.test.ts`
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-13-k8s-tests.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [x] 14. Tests for az build subcommands

  **What to do**:
  - In `tests/az-build.test.ts`, add tests for the 5 new typed build subcommands.
  - Verify `Flag.integer("build-id")` works correctly (validates integer input).
  - Test the `build` parent command routes to correct subcommands.
  - Verify removal of `runBuildHelperCommand()` — old string-based dispatch is gone.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["effect-ts", "testing-patterns"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 13, 15, 16, 17)
  - **Blocks**: Task 18
  - **Blocked By**: Task 11

  **References**:
  - `tests/az-build.test.ts` — Existing az build tests

  **Acceptance Criteria**:
  - [ ] Tests for all 5 build subcommands
  - [ ] Tests verify typed flag parsing
  - [ ] `bun test tests/az-build.test.ts` passes

  **QA Scenarios:**

  ```
  Scenario: az-build tests pass
    Tool: Bash
    Steps:
      1. Run: `bun test tests/az-build.test.ts`
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-14-az-tests.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [x] 15. Tests for PR composite commands

  **What to do**:
  - In `tests/gh-tool.test.ts`, add tests for `review-triage` and `reply-and-resolve`.
  - Mock `GitHubService` to verify both commands compose underlying functions correctly.
  - Test that `review-triage` returns combined data from viewPR + fetchThreads + fetchDiscussionSummary + fetchChecks.
  - Test that `reply-and-resolve` calls replyToComment then resolveThread in sequence.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["effect-ts", "testing-patterns"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 13, 14, 16, 17)
  - **Blocks**: Task 18
  - **Blocked By**: Task 12

  **References**:
  - `tests/gh-tool.test.ts` — Existing PR tests with GitHubService mocking

  **Acceptance Criteria**:
  - [ ] Tests for `review-triage` command
  - [ ] Tests for `reply-and-resolve` command
  - [ ] `bun test tests/gh-tool.test.ts` passes

  **QA Scenarios:**

  ```
  Scenario: gh-tool tests pass
    Tool: Bash
    Steps:
      1. Run: `bun test tests/gh-tool.test.ts`
    Expected Result: All tests pass (including new composite command tests)
    Evidence: .sisyphus/evidence/task-15-gh-tests.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [x] 16. Tests for defaultEnvironment (config + per-tool resolution)

  **What to do**:
  - In `tests/config-loader.test.ts`, add tests:
    - Config with `defaultEnvironment` parses correctly
    - Config without `defaultEnvironment` parses correctly (backward compat)
    - `getDefaultEnvironment()` returns correct value
    - `getDefaultEnvironment()` returns `undefined` when not set
  - In `tests/db-tool.test.ts`, `tests/k8s-tool.test.ts`, `tests/logs-tool.test.ts` — add one test each verifying `--env` is now optional and falls back to config.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `["effect-ts", "testing-patterns"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 13, 14, 15, 17)
  - **Blocks**: Task 18
  - **Blocked By**: Tasks 5, 6, 7

  **References**:
  - `tests/config-loader.test.ts` — Existing config tests
  - `tests/db-tool.test.ts` — DB tool tests (add env resolution test)
  - `tests/k8s-tool.test.ts` — K8s tool tests (add env resolution test)
  - `tests/logs-tool.test.ts` — Logs tool tests (add env resolution test)

  **Acceptance Criteria**:
  - [ ] Config tests verify `defaultEnvironment` parsing
  - [ ] Per-tool tests verify optional `--env` resolution
  - [ ] `bun test tests/config-loader.test.ts` passes

  **QA Scenarios:**

  ```
  Scenario: config and env resolution tests pass
    Tool: Bash
    Steps:
      1. Run: `bun test tests/config-loader.test.ts tests/db-tool.test.ts tests/k8s-tool.test.ts tests/logs-tool.test.ts`
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-16-config-tests.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [x] 17. Tests for error recovery hints (cross-tool)

  **What to do**:
  - Add tests across tool test files verifying that error responses include hint fields:
    - DB: `DbConnectionError` includes hint, nextCommand, retryable
    - K8s: `K8sContextError` includes hint with cluster verification guidance
    - Logs: `LogsConfigError` includes hint about config setup
    - GH: `GitHubAuthError` includes hint about `gh auth login`
    - Az: `AzCommandError` includes contextual hint
  - Verify TOON and JSON output formats include hint fields when present.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `["effect-ts", "testing-patterns"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Tasks 13, 14, 15, 16)
  - **Blocks**: Task 18
  - **Blocked By**: Tasks 8, 9

  **References**:
  - All `errors.ts` files across tools
  - `src/shared/types.ts` — `BaseResult` with hint fields

  **Acceptance Criteria**:
  - [ ] Each tool has at least 1 test verifying hint fields
  - [ ] TOON/JSON output includes hints when present
  - [ ] `bun test` all relevant test files pass

  **QA Scenarios:**

  ```
  Scenario: hint tests pass across all tools
    Tool: Bash
    Steps:
      1. Run: `bun test`
    Expected Result: All tests pass including hint verification
    Evidence: .sisyphus/evidence/task-17-hint-tests.txt
  ```

  **Commit**: YES
  - Message: `test: add tests for new subcommands, defaultEnv, and recovery hints`
  - Files: `tests/`
  - Pre-commit: `bun run check`

- [x] 18. Eval task definitions — 20-30 realistic agent tasks

  **What to do**:
  - In `tests/eval/tasks.ts`, define 20-30 `EvalTask` entries covering all 6 tools:
    - **gh-tool** (6-8 tasks): PR view, create, merge workflow, review-triage, reply-and-resolve, checks monitoring, issue management
    - **db-tool** (3-4 tasks): SQL query, schema introspection, environment resolution, error recovery
    - **k8s-tool** (4-5 tasks): pods listing, logs reading, describe resource, exec command, structured vs raw --cmd
    - **az-tool** (3-4 tasks): build timeline, failed-jobs, typed subcommand vs raw --cmd
    - **logs-tool** (2-3 tasks): list logs, read with grep/tail, environment resolution
    - **session-tool** (1-2 tasks): list/read sessions
  - Each task has: id, tool name, natural language description (what an agent would say), expected command/flags, fixture file path.
  - Tasks should represent realistic agent scenarios, not synthetic tests.

  **Must NOT do**:
  - Do NOT implement the runner — that's Task 19
  - Do NOT add external dependencies

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with Tasks 19)
  - **Blocks**: Task 19
  - **Blocked By**: Tasks 13, 14, 15, 16, 17

  **References**:
  - `tests/eval/types.ts` — `EvalTask` type (from Task 4)
  - `src/gh-tool/index.ts:103-128` — gh-tool workflow documentation (realistic scenarios)
  - `src/k8s-tool/index.ts:84-121` — k8s-tool examples
  - `skill/agent-tools/SKILL.md` — How agents actually use the tools

  **Acceptance Criteria**:
  - [ ] 20-30 eval tasks defined covering all 6 tools
  - [ ] Each task has realistic agent scenario description
  - [ ] Tasks importable: `import { evalTasks } from './tasks'`

  **QA Scenarios:**

  ```
  Scenario: eval tasks import without error
    Tool: Bash
    Steps:
      1. Run: `bun -e "import { evalTasks } from './tests/eval/tasks'; console.log(evalTasks.length)"`
    Expected Result: Prints number between 20 and 30
    Evidence: .sisyphus/evidence/task-18-eval-tasks.txt
  ```

  **Commit**: NO (groups with Wave 5)

- [x] 19. Eval runner — fixture-based execution with scoring

  **What to do**:
  - In `tests/eval/runner.ts`, implement the eval runner:
    - For each `EvalTask`, load its fixture file from `tests/eval/fixtures/`
    - Parse the fixture as expected command output
    - Score each task: does the expected command match? Are flags correct? Is the tool right?
    - Scoring: 1.0 = perfect match, 0.5 = right tool wrong flags, 0.0 = wrong tool or critical error
    - Aggregate into `EvalReport` with per-task scores, overall score, and summary
  - In `tests/eval/run.ts`, wire up: load tasks, run eval, print report, optionally write to `baseline.json`.
  - Create initial fixture files in `tests/eval/fixtures/` for each task.

  **Must NOT do**:
  - Do NOT call external APIs — eval is fixture-based (offline)
  - Do NOT add external dependencies

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 5 (after Task 18)
  - **Blocks**: Task 20
  - **Blocked By**: Tasks 4, 18

  **References**:
  - `tests/eval/types.ts` — `EvalTask`, `EvalScore`, `EvalReport` types
  - `tests/eval/tasks.ts` — Task definitions (from Task 18)

  **Acceptance Criteria**:
  - [ ] Runner loads tasks and fixtures
  - [ ] Produces scored `EvalReport`
  - [ ] `bun run tests/eval/run.ts` executes without error

  **QA Scenarios:**

  ```
  Scenario: eval runner produces scored report
    Tool: Bash
    Steps:
      1. Run: `bun run tests/eval/run.ts`
    Expected Result: Prints eval report with per-task scores and overall summary
    Evidence: .sisyphus/evidence/task-19-eval-run.txt
  ```

  **Commit**: NO (groups with Wave 5)

- [x] 20. Run baseline eval + record scores

  **What to do**:
  - Run `bun run tests/eval/run.ts` and capture output.
  - Save results to `tests/eval/baseline.json` as the initial baseline.
  - Verify all tasks have scores and no crashes.
  - Document the baseline score in the eval README.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 5 (after Task 19)
  - **Blocks**: Task 23
  - **Blocked By**: Task 19

  **References**:
  - `tests/eval/run.ts` — Entry point
  - `tests/eval/baseline.json` — Output destination

  **Acceptance Criteria**:
  - [ ] `baseline.json` has scores for all tasks
  - [ ] No crashes during eval run

  **QA Scenarios:**

  ```
  Scenario: baseline.json populated with scores
    Tool: Bash
    Steps:
      1. Run: `bun run tests/eval/run.ts`
      2. Check: `cat tests/eval/baseline.json | bun -e "const b = await Bun.file('tests/eval/baseline.json').json(); console.log(Object.keys(b).length)"`
    Expected Result: baseline.json exists with task scores
    Evidence: .sisyphus/evidence/task-20-baseline.txt
  ```

  **Commit**: YES
  - Message: `feat(eval): add ergonomics eval harness with baseline scores`
  - Files: `tests/eval/`
  - Pre-commit: `bun run check`

- [x] 21. Update SKILL.md with new commands and patterns

  **What to do**:
  - Update `skill/agent-tools/SKILL.md` to document:
    - `defaultEnvironment` config option and how it eliminates `--env` on every call
    - Recovery hints in error output (what `hint`, `nextCommand`, `retryable` mean)
    - 5 new k8s subcommands: `pods`, `logs`, `describe`, `exec`, `top` with examples
    - az-tool `build` subcommand group with typed flags
    - PR composite commands: `review-triage`, `reply-and-resolve` with workflow examples
    - Updated workflow recommendations incorporating new composites

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Tasks 22, 23)
  - **Blocks**: Task 23
  - **Blocked By**: Tasks 10, 11, 12

  **References**:
  - `skill/agent-tools/SKILL.md` — Current content to update
  - `src/gh-tool/index.ts:103-128` — Current workflow documentation

  **Acceptance Criteria**:
  - [ ] SKILL.md documents all new features
  - [ ] Examples use new commands
  - [ ] Workflow recommendations updated

  **QA Scenarios:**

  ```
  Scenario: SKILL.md mentions all new features
    Tool: Bash
    Steps:
      1. grep SKILL.md for: defaultEnvironment, review-triage, reply-and-resolve, pods, describe, exec, top, hint, nextCommand
    Expected Result: All terms found
    Evidence: .sisyphus/evidence/task-21-skill-check.txt
  ```

  **Commit**: NO (groups with Wave 6)

- [x] 22. Update README.md + examples/agent-tools.json5

  **What to do**:
  - Update `README.md`:
    - Add `defaultEnvironment` to Quick Start config example
    - Add new k8s subcommands to the tools table or examples
    - Mention PR composite commands
    - Document eval harness: how to run `bun run tests/eval/run.ts`
  - Update `examples/agent-tools.json5`:
    - Verify `defaultEnvironment: "test"` is present (added in Task 1)
    - Add comments explaining the new option

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 6 (with Tasks 21, 23)
  - **Blocks**: Task 23
  - **Blocked By**: Tasks 1, 10, 11, 12

  **References**:
  - `README.md` — Current documentation
  - `examples/agent-tools.json5` — Example config

  **Acceptance Criteria**:
  - [ ] README documents `defaultEnvironment`
  - [ ] README mentions new commands
  - [ ] Example config includes `defaultEnvironment`

  **QA Scenarios:**

  ```
  Scenario: README mentions new features
    Tool: Bash
    Steps:
      1. grep README.md for: defaultEnvironment, review-triage, pods
    Expected Result: All terms found
    Evidence: .sisyphus/evidence/task-22-readme-check.txt
  ```

  **Commit**: NO (groups with Wave 6)

- [x] 23. Run `bun run check` — full verification + fix any issues

  **What to do**:
  - Run `bun run check` (format + lint + typecheck + effect diagnostics + test).
  - Fix ANY failures — this is the final gate before review.
  - Verify all tests pass, no type errors, no lint issues.
  - Run `bun run format` first to auto-fix formatting.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 6 (sequential, after Tasks 20, 21, 22)
  - **Blocks**: F1, F2, F3, F4
  - **Blocked By**: Tasks 20, 21, 22

  **References**:
  - `package.json` — `check` script definition
  - `AGENTS.md` — "CRITICAL: Always run `bun run check` after every change"

  **Acceptance Criteria**:
  - [ ] `bun run check` exits with code 0
  - [ ] No type errors
  - [ ] No lint errors
  - [ ] All tests pass

  **QA Scenarios:**

  ```
  Scenario: bun run check passes clean
    Tool: Bash
    Steps:
      1. Run: `bun run format && bun run check`
    Expected Result: Exit code 0, all checks pass
    Evidence: .sisyphus/evidence/task-23-check.txt
  ```

  **Commit**: YES
  - Message: `docs: update SKILL.md, README, examples with new features`
  - Files: `skill/`, `README.md`, `examples/`
  - Pre-commit: `bun run check`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
      Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
      Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high` + skills: `["effect-ts", "code-review"]`
      Run `bun run check`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify Effect patterns match existing codebase (use `Flag.*` from `effect/unstable/cli`, not `Options.*` from `@effect/cli`).
      Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` + skills: `["effect-ts"]`
      Start from clean state. Run `--help` for all 6 tools — verify new commands appear. Test config resolution with and without `defaultEnvironment`. Test error recovery hints appear in TOON and JSON formats. Run eval harness and verify scores. Save to `.sisyphus/evidence/final-qa/`.
      Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
      For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance (no removed commands, no new dependencies, no consolidated binaries). Detect cross-task contamination.
      Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Wave | Commit | Message                                                                        | Files                                                        |
| ---- | ------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1    | YES    | `feat(config): add defaultEnvironment and recovery hint types`                 | shared/types.ts, config/types.ts, config/loader.ts, schemas/ |
| 2    | YES    | `feat(tools): wire defaultEnvironment + error recovery hints across all tools` | db-tool/, k8s-tool/, logs-tool/, gh-tool/, az-tool/          |
| 3    | YES    | `feat(k8s,az,gh): add structured subcommands and PR composites`                | k8s-tool/, az-tool/, gh-tool/pr/                             |
| 4    | YES    | `test: add tests for new subcommands, defaultEnv, and recovery hints`          | tests/                                                       |
| 5    | YES    | `feat(eval): add ergonomics eval harness with baseline scores`                 | tests/eval/                                                  |
| 6    | YES    | `docs: update SKILL.md, README, examples with new features`                    | skill/, README.md, examples/                                 |

Pre-commit for all: `bun run check`

---

## Success Criteria

### Verification Commands

```bash
bun run check              # Expected: all pass (format + lint + typecheck + test)
bun run test               # Expected: all tests pass including new ones
bun run tests/eval/run.ts  # Expected: scored eval output with baseline metrics
```

### Final Checklist

- [x] All "Must Have" present and verified
- [x] All "Must NOT Have" absent and verified
- [x] All existing tests still pass (zero regressions)
- [x] New features have corresponding tests
- [x] Eval harness produces scored results
- [x] `bun run check` passes clean
- [x] SKILL.md, README.md updated
