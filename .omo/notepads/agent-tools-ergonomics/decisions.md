# Decisions

## defaultEnvironment Field Design

- **Placement**: Root level of AgentToolsConfig (global, not per-profile)
- **Type**: Optional string literal union: `"local" | "test" | "prod"`
- **Rationale**: Tools need a fallback environment when no `--env` flag is provided
- **Validation**: Enforced at schema level (Effect + JSON Schema)
- **Example**: `defaultEnvironment: "test"` in agent-tools.json5

## Implementation Approach

- Added to types.ts as optional field with union type
- Added to loader.ts using `Schema.Literal()` with `optionalKey()`
- Added to JSON schema with enum constraint
- Added example in agent-tools.json5 near top (after $schema)

## Recovery Hint Fields Implementation

- **Placement**: Added to `BaseResult` type as optional fields (not required)
- **Fields**: `nextCommand?: string`, `retryable?: boolean`, `hint?: string`
- **Format Support**: Both TOON and JSON automatically include fields when present
- **Error Rendering**: Hint appended to error message on new line with "Hint: " prefix
- **Backward Compatibility**: Existing code without hints continues to work unchanged
- **Filtering**: Hint field excluded from generic details rendering to prevent duplication

## Task 3: getDefaultEnvironment() Helper Implementation

- **Function Signature**: `getDefaultEnvironment(config: AgentToolsConfig | undefined): "local" | "test" | "prod" | undefined`
- **Placement**: In src/config/loader.ts, immediately after getToolConfig()
- **Logic**: Simple optional chaining accessor — returns config?.defaultEnvironment
- **Export**: Added to src/config/index.ts alongside ConfigService, getToolConfig, loadConfig
- **Rationale**: Provides consistent API for tools to access default environment without direct config access
- **Unblocks**: Tasks 5/6/7 which need env fallback logic

## Task 4: Use Shared Environment Type

- **Change**: Updated `getDefaultEnvironment()` return type from `"local" | "test" | "prod" | undefined` to `Environment | undefined`
- **Import**: Added type-only import `import type { Environment } from "../shared/types.ts"`
- **Rationale**: Centralizes environment type definition, reduces duplication, improves maintainability
- **Implementation**: No logic changes, only signature adjustment

## Task 4: Eval Harness Type Design

- **EvalTask**: Minimal fields for task definition (id, tool, description, input, expectedPattern)
- **EvalScore**: Separate from task to allow independent scoring logic
- **EvalReport**: Aggregates tasks + scores + summary for baseline comparison
- **Summary metrics**: total, passed, failed, averageScore for quick assessment
- **Stub runner**: Returns empty scores array (implementation deferred to Task 19)

## Task 4: Scaffold-Only Approach

- No eval logic implemented (belongs to Tasks 18-20)
- No external dependencies added
- Stub runner returns deterministic empty report
- All files compile and execute without errors
- Ready for Task 18 (task definitions) and Task 19 (runner implementation)

## Task 5: defaultEnvironment Dynamic String Override

- **Change**: Removed enum restriction from `defaultEnvironment` field
- **Type**: Changed from `"local" | "test" | "prod"` to `string`
- **Rationale**: User feedback requested flexibility for custom environment names
- **Files Modified**:
  - `src/config/types.ts`: `defaultEnvironment?: string`
  - `src/config/loader.ts`: `Schema.optionalKey(Schema.String)`
  - `schemas/agent-tools.schema.json`: Removed enum, kept type string + description
- **Backward Compatibility**: Existing configs with "local", "test", "prod" remain valid

## Task 5 (db-tool): Optional --env Implementation

- **Pattern**: `Flag.optional(Flag.string("env"))` for both `sql` and `schema` commands
- **Resolution order**: explicit `--env` flag → `getDefaultEnvironment(config)` → error with hint
- **Helper placement**: `resolveEnv()` defined in `index.ts` (CLI-level, not service-level)
- **Error type for missing env**: `DbConnectionError` with `environment: "(not specified)"`
- **Hint fields on errors**: All 5 db error classes get `hint`, `nextCommand`, `retryable` as optional Schema fields
- **No service.ts changes**: Error hints in service.ts deferred — only index.ts and errors.ts modified per scope
- **No implicit prod default**: Missing env fails explicitly rather than guessing a dangerous default
- **Backward compatibility**: All existing error constructors work without new fields

## Task 6 (k8s-tool): Optional --env + Prod Safety + Error Hints

- **Flag change**: `Flag.choice` → `Flag.optional(Flag.string("env"))` — env is now any string, not enum-restricted to test/prod
- **Resolution order**: explicit `--env` flag → `getDefaultEnvironment(config)` → error with hint
- **Prod safety gate**: Implicit prod (via config `defaultEnvironment: "prod"`) is blocked; explicit `--env prod` required
- **Error propagation**: `resolveEnv` errors propagate to `renderCauseToStderr` — consistent with db-tool approach
- **Environment in output**: Resolved env included in final output via `{ ...result, environment: resolvedEnv }` spread
- **Hint strategy**: Each `catchTags` handler provides contextual hints; error objects' own hints are used when present (fallback to generic)
- **CommandResult extension**: Added `hint?`, `nextCommand?`, `retryable?`, `environment?` fields to k8s `CommandResult` type
- **No service.ts changes**: Service layer unchanged; env resolution and hints are CLI-level concerns in `index.ts`
- **Backward compatibility**: All existing error constructors work without new optional fields

## Task 7 (logs-tool): Optional --env + Error Recovery Hints

- **Flag change**: `Flag.choice` → `Flag.optional(Flag.string("env"))` — env is now any string, not enum-restricted
- **Resolution order**: explicit `--env` flag → `getDefaultEnvironment(config)` → error with hint
- **Error type**: `LogsConfigError` for missing env (not `LogsReadError`) — config/input issue, not a read failure
- **No prod safety gate**: Unlike k8s-tool, logs are read-only so implicit prod access is safe
- **Layer composition**: `Layer.provideMerge(ConfigServiceLayer)` at MainLayer to expose `ConfigService` to CLI handlers
- **Hint fields on errors**: All 4 logs error classes get `hint`, `nextCommand`, `retryable` as optional Schema fields
- **No service.ts changes**: Service layer unchanged; env resolution and hints are CLI-level concerns in `index.ts`
- **Backward compatibility**: All existing error constructors and test mocks work without new fields

## Task 7 Fix: LogResult hint field propagation

- **LogResult extension**: Added `hint?`, `nextCommand?`, `retryable?` to match `BaseResult` pattern
- **Propagation strategy**: `error.hint ?? fallback` — error's own hint takes priority over computed fallbacks
- **Fallback rules**:
  - `LogsReadError` with `source === "config"`: guidance to add logs section to config
  - `LogsTimeoutError`: `retryable: true` always (timeouts are transient)
  - All other errors: pass through error's own fields or undefined
- **No service.ts changes**: Hint propagation is a CLI-level output concern

## Task 8 (gh-tool): Error Recovery Hints

- **Hint fields on errors**: All 5 GH error classes get `hint`, `nextCommand`, `retryable` as optional Schema fields
- **Selective population**: Only key call sites get hints — auth, not-found (service.ts), merge by reason (pr/core.ts), timeout (pr/core.ts), job resolution (workflow.ts)
- **Not populated**: JSON parse errors, GraphQL errors, empty-body validation — already self-descriptive
- **Merge hint strategy**: Each merge failure reason gets a tailored hint:
  - `conflicts`: resolve locally + `gh pr diff`
  - `checks_failing`: wait/investigate + `agent-tools-gh pr checks` + `retryable: true`
  - `branch_protected`: admin action needed (no retryable)
  - `unknown`: check PR state + `agent-tools-gh pr view`
- **Auth hint**: dual guidance (CLI login or GITHUB_TOKEN env var) + `nextCommand: gh auth login`
- **Timeout always retryable**: Consistent with k8s/logs pattern
- **No pr/review.ts or issue.ts changes**: Existing errors there are specific enough; hints would be redundant
- **No repo.ts changes**: Errors flow through service.ts which now has hints
- **Backward compatibility**: All existing error constructors work without new optional fields; 37 tests pass unchanged

## Task 9 (az-tool): Error Recovery Hints

- **Hint fields on errors**: All 4 AZ error classes get `hint`, `nextCommand`, `retryable` as optional Schema fields
- **invalidBuildCommand refactor**: Added optional `hint` parameter to helper function, populated at all 4 call sites in index.ts
- **Selective population strategy**: Hints added at high-value sites; AzCommandError for non-zero exit codes left without hints since stderr already descriptive
- **Timeout always retryable**: Consistent with k8s/logs/gh pattern
- **Security errors not retryable**: Policy violations cannot be fixed by retry
- **Platform errors retryable with nextCommand**: `az login` suggested since auth expiry is most common cause
- **Parse errors informational only**: Hints describe what went wrong but no retry/nextCommand — API format issues need investigation
- **No types.ts changes**: AZ tool doesn't have a separate result type that needs hint propagation (unlike logs-tool)
- **Backward compatibility**: All existing error constructors work without new optional fields; 34 tests pass unchanged

## Task 10 (k8s-tool): Structured Kubernetes Subcommands

- **Scope**: Add `pods`, `logs`, `describe`, `exec`, `top` subcommands in `src/k8s-tool/index.ts` only
- **Execution model**: All subcommands compile kubectl argument strings and call existing `K8sService.runKubectl(...)` via shared helper
- **Compatibility**: Keep `kubectl --cmd` subcommand intact as the unrestricted escape hatch
- **Common UX contract**: Every subcommand includes `--env`, `--dry-run`, `--format`, `--profile` with the same semantics as current kubectl command
- **Env behavior**: Preserve existing resolver and implicit-prod safety gate by reusing `resolveEnv(...)` unchanged

## Task 11 (az-tool): Build Subcommand Structure

- **Architecture**: Two-level command tree: `az-tool` → `build` (parent) → `timeline|failed-jobs|logs|log-content|summary` (subcommands), plus `cmd` (raw escape hatch)
- **Removed**: `runBuildHelperCommand()`, `invalidBuildCommand()`, `parseRequiredIntOption()` — all string-parsing infrastructure replaced by typed CLI flags
- **Removed import**: `extractOptionValue` from `./extract-option-value` — no longer needed in index.ts (file kept since deletion not in scope)
- **Removed import**: `AzCommandError` from `./errors` — was only used by `invalidBuildCommand` helper
- **Flag design**: `Flag.integer("build-id")` and `Flag.integer("log-id")` — Effect CLI handles parsing + validation + error messages
- **Profile handling**: `_profile` destructured but unused in all subcommands — AzService reads config at layer creation time (same as before)
- **Output format**: Build subcommands use `formatAny()` (not `formatOutput()`) — matches original behavior where build helpers returned raw data, not `BaseResult`
- **Raw cmd subcommand**: Uses `formatOutput()` with `BaseResult` shape — matches original raw command output format
- **Compatibility**: `build.ts` untouched, `service.ts` untouched, `errors.ts` untouched — only `index.ts` changed

## Task 12: PR Composite Commands

- **`review-triage`**: Parallel fetch of PR info + unresolved threads + discussion summary + checks status
- **`reply-and-resolve`**: Sequential reply-to-comment then resolve-thread
- **Composition strategy**: Reuse existing Effect functions directly, no wrapper abstractions
- **Output shape**: Single object with named sub-results (`{ info, unresolvedThreads, summary, checks }` and `{ reply, resolve }`)
- **Flag reuse**: Same `--pr` (optional), `--format` conventions as all other PR commands
- **No new business logic**: Pure orchestration — if underlying functions change, composites get updates for free
- **Backward compatibility**: Existing granular commands unchanged; composites are additive-only
- **Wiring**: 3-file change (commands.ts, pr/index.ts, gh-tool/index.ts) — minimal surface area
