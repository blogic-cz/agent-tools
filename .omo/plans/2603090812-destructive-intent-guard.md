# Destructive Intent Guard — Safety Model Proposal

## TL;DR

> **Problem**: `agent-tools` currently protects agents via a wrapper-centric model (gh, kubectl, psql, az). This is strong for known paths, but does not catch destructive intent outside of wrappers — raw shell commands like `rm -rf /`, `git push --force`, `dropdb prod`, `helm uninstall`, or any irreversible infra command pass through undetected.
>
> **Solution**: Extend the credential guard with a new layer — **Destructive Intent Guard** — that classifies shell commands by operation risk, not by whether a wrapper exists. Deterministic, stateless, zero external dependencies.
>
> **Principle adopted from Sondera**: intent-centric enforcement (protect against what the agent tries to do, not just how it gets there).
>
> **Estimated Effort**: Medium (2-3 days)
> **Parallel Execution**: YES — 3 waves

---

## Context

### Current State of the Credential Guard

`src/credential-guard/index.ts` currently performs 4 types of checks:

| Check                    | Purpose                                                  | Scope           |
| ------------------------ | -------------------------------------------------------- | --------------- |
| `isPathBlocked`          | Blocks access to sensitive files (.env, .pem, .ssh)      | File read/write |
| `detectSecrets`          | Detects API keys, tokens, passwords in content           | File write/edit |
| `isDangerousBashCommand` | Blocks commands that expose secrets (printenv, cat .env) | Shell commands  |
| `getBlockedCliTool`      | Redirects to wrappers (gh→agent-tools-gh, kubectl→k8s)   | Shell commands  |

**What's missing**: None of these checks evaluate whether a command is **destructive** (irreversible, state-changing, data-destroying). `isDangerousBashCommand` is secret-focused, not intent-focused.

### Lesson from the Incident (DataTalksClub / Terraform)

An agent ran a `terraform` command that deleted a production database along with all snapshots. No wrapper for terraform existed, and the credential guard didn't block it because it wasn't a "secret exposure" operation — it was a **destructive infrastructure** operation. The issue isn't Terraform itself, but the absence of risk-class-based protection.

### Principle from Sondera (Cedar Policy Model)

Sondera solves this via a central reference monitor with Cedar policies organized by risk category:

- `destructive.cedar` — irreversible operations (rm -rf, DROP DATABASE, force push, terraform destroy)
- `base.cedar` — credential access, exfiltration, obfuscation
- `ifc.cedar` — information flow control and taint propagation

**What we adopt**: The principle of risk-based classification. **What we don't adopt**: Cedar engine, YARA, Ollama, stateful trajectory tracking, external harness server.

---

## Proposal: Destructive Intent Guard

### Architectural Principle

```
Current model:              Proposed model:

  Shell command              Shell command
       │                          │
       ▼                          ▼
  ┌─────────────┐           ┌─────────────┐
  │ Secret      │           │ Secret      │  ← existing (unchanged)
  │ exposure?   │           │ exposure?   │
  └──────┬──────┘           └──────┬──────┘
         │                         │
         ▼                         ▼
  ┌─────────────┐           ┌─────────────┐
  │ Blocked CLI │           │ Blocked CLI │  ← existing (extended with infra tools)
  │ tool?       │           │ tool?       │
  └──────┬──────┘           └──────┬──────┘
         │                         │
         ▼                         ▼
      ✅ PASS              ┌─────────────┐
                           │ Destructive │  ← NEW
                           │ intent?     │
                           └──────┬──────┘
                                  │
                            ┌─────┴─────┐
                            ▼           ▼
                        🚫 DENY    ⚠️  ASK
```

### Risk Categories

Each pattern belongs to a category and carries a decision (`deny` or `ask`):

| Category                  | Decision | Examples                                                                            |
| ------------------------- | -------- | ----------------------------------------------------------------------------------- |
| **filesystem-destroy**    | `deny`   | `rm -rf /`, `rm -rf ~`, `shred`, `dd of=/dev/`, `mkfs`                              |
| **git-destructive**       | `deny`   | `git push --force`, `git reset --hard`, `git clean -f`, `git filter-branch`         |
| **git-risky**             | `ask`    | `git branch -D`, `git checkout .`, `git restore .`                                  |
| **db-destructive**        | `deny`   | `DROP DATABASE`, `DROP TABLE`, `TRUNCATE`, `dropdb`, `FLUSHALL`                     |
| **db-risky**              | `ask`    | `DELETE FROM` without WHERE, `ALTER TABLE`                                          |
| **infra-destructive**     | `deny`   | `*destroy*`, `*apply --auto-approve*`, `helm uninstall`, `kubectl delete namespace` |
| **process-kill**          | `deny`   | `kill -9`, `killall`, `pkill`                                                       |
| **permission-escalation** | `deny`   | `chmod -R 777`, `chown -R root`                                                     |
| **safety-bypass**         | `deny`   | `--no-verify`, `--force` on git operations                                          |

### Decision Model

```typescript
type RiskDecision = "deny" | "ask";

// deny = throw Error, exit 2 (command is not executed)
// ask  = throw Error with message "⚠️ Risky operation detected..."
//        + hint for the agent to request user confirmation
//        (Claude Code exit 2 = block, agent must reformulate or ask)
```

**Note on `ask`**: The Claude Code hook protocol currently supports only `exit 0` (allow) and `exit 2` (block). A true `ask` (= pause and wait for user input) is not in the hook API. Therefore `ask` is implemented as `deny` with a friendly error message explaining the agent should request explicit user consent and then reformulate the command. In the future, if Claude Code adds `exit 3` or an `escalate` response, we switch to native ask.

### Configuration

Extension of the existing `CredentialGuardConfig`:

```typescript
// New fields in CredentialGuardConfig:
type CredentialGuardConfig = {
  // ... existing fields ...

  /** Override risk decision for specific pattern IDs */
  destructivePatternOverrides?: Record<string, "deny" | "ask" | "allow">;

  /** Completely disable destructive intent checking (NOT recommended) */
  disableDestructiveGuard?: boolean;
};
```

Users can:

- Change `deny` to `ask` for a specific pattern: `{ "git-force-push": "ask" }`
- Change `ask` to `allow` for a pattern they don't care about: `{ "git-branch-force-delete": "allow" }`
- Completely disable the guard (explicit opt-out, not default)

### Code Structure

```
src/credential-guard/
├── index.ts                    ← extend handleToolExecuteBefore
├── claude-hook.ts              ← unchanged
├── destructive-patterns.ts     ← NEW: pattern registry
└── types.ts                    ← NEW: shared types (or extend config/types.ts)
```

### Pattern Registry (destructive-patterns.ts)

```typescript
type DestructivePattern = {
  /** Unique ID for config overrides and error messages */
  id: string;
  /** Category for grouping */
  category: RiskCategory;
  /** Regex matching the shell command */
  pattern: RegExp;
  /** Default decision */
  decision: "deny" | "ask";
  /** Human-readable description for error messages */
  description: string;
};

// Example:
const DEFAULT_DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  {
    id: "rm-rf",
    category: "filesystem-destroy",
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+.*\/|\/)/,
    decision: "deny",
    description: "Recursive file deletion targeting root or absolute paths",
  },
  {
    id: "git-force-push",
    category: "git-destructive",
    pattern: /\bgit\s+push\s+.*(-f|--force)\b/,
    decision: "deny",
    description: "Force push rewrites remote history",
  },
  {
    id: "drop-database",
    category: "db-destructive",
    pattern: /\b(DROP\s+DATABASE|dropdb)\b/i,
    decision: "deny",
    description: "Permanently destroys entire database",
  },
  // ... etc for each category
];
```

### Error Messages

Error message format includes the pattern ID for debuggability (inspired by Sondera annotations):

```
🚫 [rm-rf] Destructive command blocked: Recursive file deletion targeting root or absolute paths.

Command: rm -rf /var/data
Category: filesystem-destroy
Decision: deny

This operation is irreversible. If you need to delete files, be specific about the path
and ask the user for confirmation first.

Override: Set destructivePatternOverrides: { "rm-rf": "ask" } in agent-tools.json5
```

For `ask` decisions:

```
⚠️ [git-force-push] Risky operation detected: Force push rewrites remote history.

Command: git push --force origin main
Category: git-destructive
Decision: ask

This operation may be legitimate but carries risk. Ask the user to confirm
before proceeding. Then re-run the command.

Override: Set destructivePatternOverrides: { "git-force-push": "allow" } in agent-tools.json5
```

---

## Work Objectives

### Core Objective

Extend the credential guard with intent-based destructive command detection using a deny/ask decision model.

### Concrete Deliverables

- `src/credential-guard/destructive-patterns.ts` — pattern registry
- Extended `src/credential-guard/index.ts` — new `isDestructiveCommand()` function + integration into `handleToolExecuteBefore`
- Extended `src/config/types.ts` — new config fields
- Extended `schemas/agent-tools.schema.json` — schema for new config fields
- `tests/destructive-guard.test.ts` — tests for all patterns and overrides
- Updated `README.md` — destructive intent guard documentation + explicit safety guarantees
- Extended default blocked CLI tools with infra tools

### Must Have

- All patterns from the Risk Categories table implemented
- Config overrides working (deny→ask, ask→allow, deny→allow)
- Pattern ID in every error message
- Tests for every category (min 2 patterns/category)
- Existing tests still passing

### Must NOT Have

- No external runtime (Cedar, YARA, Ollama, server process)
- No stateful tracking between calls (remains stateless)
- No breaking changes in existing credential guard API
- No changes to claude-hook.ts (same exit protocol)

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — all verification is agent-executed.

### Test Decision

- **Infrastructure exists**: YES (vitest)
- **Automated tests**: YES (tests-after, not TDD — matching existing repo patterns)
- **Framework**: vitest (same as existing tests)

### QA Policy

Every task includes agent-executed QA scenarios.
Evidence: `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — can all start immediately):
├── Task 1: Types + Pattern Registry         [quick]
├── Task 2: Infra CLI defaults               [quick]
└── Task 3: README safety guarantees section  [writing]

Wave 2 (Core implementation — depends on Wave 1):
├── Task 4: isDestructiveCommand + integration  [unspecified-high]  (depends: 1)
├── Task 5: Config schema + overrides           [quick]            (depends: 1)
└── Task 6: Tests for all patterns              [unspecified-high]  (depends: 1)

Wave 3 (Polish + verify — depends on Wave 2):
├── Task 7: README destructive guard docs    [writing]  (depends: 4, 5)
└── Task 8: Full integration test + check    [quick]    (depends: 4, 5, 6)

Wave FINAL (Review):
├── Task F1: Code quality review     [unspecified-high]
└── Task F2: Scope fidelity check    [deep]
```

### Dependency Matrix

| Task | Blocked By | Blocks  |
| ---- | ---------- | ------- |
| 1    | —          | 4, 5, 6 |
| 2    | —          | 8       |
| 3    | —          | 7       |
| 4    | 1          | 7, 8    |
| 5    | 1          | 7, 8    |
| 6    | 1          | 8       |
| 7    | 3, 4, 5    | F1, F2  |
| 8    | 2, 4, 5, 6 | F1, F2  |

---

## TODOs

- [ ] 1. Pattern Registry + Types

  **What to do**:
  - Create `src/credential-guard/destructive-patterns.ts` with types `DestructivePattern`, `RiskCategory`, `RiskDecision`
  - Implement `DEFAULT_DESTRUCTIVE_PATTERNS` array with at least 20-25 patterns covering all 9 categories
  - Export `getDestructivePatterns(overrides?)` function that merges defaults with config overrides
  - Patterns must handle chaining (`&&`, `|`, `;`, `\n`) the same way existing `getBlockedCliTool` does

  **Must NOT do**:
  - Do not duplicate existing `DEFAULT_DANGEROUS_BASH_PATTERNS` (those remain for secret exposure)
  - Do not add runtime dependencies

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Tasks 4, 5, 6
  - **Blocked By**: None

  **References**:
  - `src/credential-guard/index.ts:144-154` — pattern for pattern array (DEFAULT_DANGEROUS_BASH_PATTERNS)
  - `src/credential-guard/index.ts:159-185` — pattern for BlockedCliTool with pattern/name/wrapper
  - `src/config/types.ts:46-57` — existing CredentialGuardConfig types
  - Sondera `destructive.cedar` — reference for category coverage (don't import, just inspiration for scope)

  **Acceptance Criteria**:
  - [ ] File `src/credential-guard/destructive-patterns.ts` exists
  - [ ] Exports types `DestructivePattern`, `RiskCategory`, `RiskDecision`
  - [ ] `DEFAULT_DESTRUCTIVE_PATTERNS` contains min 20 patterns
  - [ ] Each pattern has unique `id`, `category`, `pattern` (RegExp), `decision`, `description`
  - [ ] All 9 categories from the proposal are covered

  **QA Scenarios**:

  ```
  Scenario: Pattern registry exports correct types
    Tool: Bash (bun)
    Steps:
      1. bun -e "import { DEFAULT_DESTRUCTIVE_PATTERNS } from './src/credential-guard/destructive-patterns'; console.log(JSON.stringify(DEFAULT_DESTRUCTIVE_PATTERNS.length))"
      2. Assert: output >= 20
    Expected Result: Number >= 20 printed
    Evidence: .sisyphus/evidence/task-1-pattern-count.txt

  Scenario: All 9 categories covered
    Tool: Bash (bun)
    Steps:
      1. bun -e "import { DEFAULT_DESTRUCTIVE_PATTERNS } from './src/credential-guard/destructive-patterns'; const cats = [...new Set(DEFAULT_DESTRUCTIVE_PATTERNS.map(p => p.category))]; console.log(cats.sort().join('\n'))"
      2. Assert: output contains all 9 category names
    Expected Result: 9 unique category strings
    Evidence: .sisyphus/evidence/task-1-categories.txt
  ```

  **Commit**: NO (groups with Task 4)

---

- [ ] 2. Extend Default Blocked CLI Tools with Infra Tools

  **What to do**:
  - In `src/credential-guard/index.ts`, add to `DEFAULT_BLOCKED_CLI_TOOLS`:
    - `helm` → suggestion "Use agent-tools-k8s for read-only Kubernetes operations"
    - `ansible-playbook` → suggestion "Infrastructure automation blocked for agent safety"
    - `cdk` → suggestion "AWS CDK operations blocked for agent safety"
  - Do not add `terraform`/`pulumi`/`tofu` — they are not relevant to this project; if needed, users add them via `additionalBlockedCliTools`
  - Add matching tests to `tests/credential-guard.test.ts`

  **Must NOT do**:
  - Do not modify existing blocked tools
  - Do not add tools the project doesn't actually use where it would be noise

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Task 8
  - **Blocked By**: None

  **References**:
  - `src/credential-guard/index.ts:159-185` — existing DEFAULT_BLOCKED_CLI_TOOLS
  - `tests/credential-guard.test.ts:444-477` — existing tests for CLI tool blocking

  **Acceptance Criteria**:
  - [ ] `helm`, `ansible-playbook`, `cdk` are in DEFAULT_BLOCKED_CLI_TOOLS
  - [ ] Tests in credential-guard.test.ts verify blocking of new tools

  **QA Scenarios**:

  ```
  Scenario: helm is blocked by default
    Tool: Bash (bun test)
    Steps:
      1. bun test tests/credential-guard.test.ts --reporter verbose
      2. Assert: all tests pass including new helm/ansible-playbook/cdk tests
    Expected Result: Test suite PASS, 0 failures
    Evidence: .sisyphus/evidence/task-2-cli-blocking.txt
  ```

  **Commit**: NO (groups with Task 4)

---

- [ ] 3. README — Safety Guarantees Section

  **What to do**:
  - Add a new "Safety Guarantees" section to README.md (before or after "Credential Guard")
  - Clearly distinguish 3 protection layers:
    1. **Wrapper Safety** — for gh, kubectl, psql, az (strongest, read-only enforcement)
    2. **Destructive Intent Guard** — for any shell command (pattern-based, deny/ask)
    3. **Credential Guard** — for secret exposure (file/content/bash patterns)
  - Explicitly state what is NOT protected: "agent-tools does not provide a sandbox — it protects against known risky patterns, not arbitrary code"
  - Add table of default blocked infra CLI tools

  **Must NOT do**:
  - Do not promise "full protection" — be precise about limits
  - Do not modify existing README sections other than adding the new one

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Task 7
  - **Blocked By**: None

  **References**:
  - `README.md:250-370` — existing Credential Guard documentation

  **Acceptance Criteria**:
  - [ ] README contains "Safety Guarantees" section
  - [ ] Distinguishes 3 protection layers
  - [ ] Contains explicit limits (what is NOT protected)

  **QA Scenarios**:

  ```
  Scenario: README contains safety guarantees
    Tool: Bash (grep)
    Steps:
      1. grep -c "Safety Guarantees" README.md
      2. Assert: count >= 1
    Expected Result: At least 1 match
    Evidence: .sisyphus/evidence/task-3-readme-section.txt
  ```

  **Commit**: NO (groups with Task 7)

---

- [ ] 4. Core: isDestructiveCommand + Integration

  **What to do**:
  - In `src/credential-guard/index.ts`:
    - Import pattern registry from `destructive-patterns.ts`
    - Add new function `isDestructiveCommand(command: string): DestructiveMatch | null`
    - Integrate into `handleToolExecuteBefore` — call after `isDangerousBashCommand` and `getBlockedCliTool` checks
    - Support config overrides via `destructivePatternOverrides` in `CredentialGuardConfig`
    - Support `disableDestructiveGuard` flag
  - Error messages must include: pattern ID, description, category, decision, override hint
  - Export `isDestructiveCommand` from the module (for testing and potential MCP plugins)
  - Add to `createCredentialGuard` factory function

  **Must NOT do**:
  - Do not change existing behavior of `isDangerousBashCommand` or `getBlockedCliTool`
  - Do not change `claude-hook.ts` (exit protocol stays: 0=allow, 2=block)
  - `ask` decision = same exit 2 as deny, just different message text

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (with Tasks 5, 6)
  - **Blocks**: Tasks 7, 8
  - **Blocked By**: Task 1

  **References**:
  - `src/credential-guard/index.ts:239-409` — createCredentialGuard factory + handleToolExecuteBefore
  - `src/credential-guard/index.ts:300-302` — pattern for isDangerousBashCommand check
  - `src/credential-guard/index.ts:328-338` — pattern for getBlockedCliTool check
  - `src/credential-guard/index.ts:375-397` — bash tool handling flow where the new check is added

  **Acceptance Criteria**:
  - [ ] `isDestructiveCommand` is an exported function
  - [ ] `handleToolExecuteBefore` calls destructive check for bash tool
  - [ ] Deny patterns generate error with pattern ID
  - [ ] Ask patterns generate error with different text (⚠️ vs 🚫)
  - [ ] Config override `{ "rm-rf": "allow" }` causes rm-rf to pass through
  - [ ] `disableDestructiveGuard: true` disables the entire layer

  **QA Scenarios**:

  ```
  Scenario: rm -rf / is blocked by default
    Tool: Bash (bun)
    Steps:
      1. bun -e "import { isDestructiveCommand } from './src/credential-guard'; const r = isDestructiveCommand('rm -rf /'); console.log(JSON.stringify(r))"
      2. Assert: output contains "rm-rf" and "deny"
    Expected Result: { id: "rm-rf", decision: "deny", ... }
    Evidence: .sisyphus/evidence/task-4-rm-rf-blocked.txt

  Scenario: Override changes decision
    Tool: Bash (bun)
    Steps:
      1. bun -e "import { createCredentialGuard } from './src/credential-guard'; const g = createCredentialGuard({ destructivePatternOverrides: { 'rm-rf': 'allow' } }); const r = g.isDestructiveCommand('rm -rf /'); console.log(JSON.stringify(r))"
      2. Assert: output is null (allowed, no match returned)
    Expected Result: null
    Evidence: .sisyphus/evidence/task-4-override-allow.txt

  Scenario: git push --force is deny, git branch -D is ask
    Tool: Bash (bun)
    Steps:
      1. bun -e "import { isDestructiveCommand } from './src/credential-guard'; console.log(isDestructiveCommand('git push --force origin main')?.decision); console.log(isDestructiveCommand('git branch -D feature')?.decision)"
      2. Assert: first line = "deny", second line = "ask"
    Expected Result: deny\nask
    Evidence: .sisyphus/evidence/task-4-deny-vs-ask.txt
  ```

  **Commit**: YES
  - Message: `feat(credential-guard): add destructive intent detection with deny/ask decisions`
  - Files: `src/credential-guard/destructive-patterns.ts`, `src/credential-guard/index.ts`, `src/config/types.ts`
  - Pre-commit: `bun run check`

---

- [ ] 5. Config Schema Update

  **What to do**:
  - Extend `src/config/types.ts` — add `destructivePatternOverrides?` and `disableDestructiveGuard?`
  - Extend `schemas/agent-tools.schema.json` — add new fields to CredentialGuardConfig definition
  - Extend `examples/agent-tools.json5` — add commented override example

  **Must NOT do**:
  - Do not modify existing config fields
  - Do not set defaults that would change behavior without an upgrade

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 4, 6 once types from Task 1 are ready)
  - **Parallel Group**: Wave 2
  - **Blocks**: Tasks 7, 8
  - **Blocked By**: Task 1

  **References**:
  - `src/config/types.ts:52-57` — existing CredentialGuardConfig
  - `schemas/agent-tools.schema.json:218-256` — schema definition
  - `examples/agent-tools.json5:77-87` — existing credentialGuard example

  **Acceptance Criteria**:
  - [ ] Types in `config/types.ts` contain new fields
  - [ ] JSON schema validates new fields
  - [ ] Example in `examples/agent-tools.json5` shows override

  **QA Scenarios**:

  ```
  Scenario: Schema validates new config fields
    Tool: Bash
    Steps:
      1. bun run check
      2. Assert: exit code 0
    Expected Result: All checks pass
    Evidence: .sisyphus/evidence/task-5-schema-valid.txt
  ```

  **Commit**: NO (included in Task 4 commit)

---

- [ ] 6. Tests for All Destructive Patterns

  **What to do**:
  - Create `tests/destructive-guard.test.ts`
  - For each of the 9 categories: min 2 "blocked" tests + 1 "allowed" test (false positive check)
  - Tests for config overrides: deny→ask, deny→allow, ask→allow
  - Test for `disableDestructiveGuard: true`
  - Test for command chaining (`rm -rf / && echo done` — still blocked)
  - Test for case sensitivity where relevant (DROP DATABASE vs drop database)

  **Must NOT do**:
  - Do not duplicate tests from `credential-guard.test.ts`

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["testing-patterns"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 4, 5)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 8
  - **Blocked By**: Task 1

  **References**:
  - `tests/credential-guard.test.ts:383-442` — pattern for dangerous bash command tests
  - `tests/credential-guard.test.ts:479-519` — pattern for config override tests
  - `tests/az-security.test.ts` — pattern for security test structure

  **Acceptance Criteria**:
  - [ ] `tests/destructive-guard.test.ts` exists
  - [ ] Min 2 positive + 1 negative test per each of the 9 categories
  - [ ] Override tests cover deny→ask, deny→allow, ask→allow
  - [ ] `bun test tests/destructive-guard.test.ts` → PASS

  **QA Scenarios**:

  ```
  Scenario: All destructive guard tests pass
    Tool: Bash (bun test)
    Steps:
      1. bun test tests/destructive-guard.test.ts --reporter verbose
      2. Assert: exit code 0, 0 failures
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-6-tests-pass.txt

  Scenario: False positive check — safe commands not blocked
    Tool: Bash (bun)
    Steps:
      1. bun -e "import { isDestructiveCommand } from './src/credential-guard'; ['ls -la', 'git status', 'npm test', 'cat README.md', 'git push origin main', 'git commit -m test'].forEach(cmd => { const r = isDestructiveCommand(cmd); if (r) console.log('FALSE POSITIVE:', cmd, r.id); else console.log('OK:', cmd) })"
      2. Assert: all lines start with "OK:"
    Expected Result: No false positives on safe commands
    Evidence: .sisyphus/evidence/task-6-false-positives.txt
  ```

  **Commit**: NO (included in Task 8 commit)

---

- [ ] 7. README — Destructive Guard Documentation

  **What to do**:
  - Expand the Safety Guarantees section (from Task 3) with destructive guard details:
    - Table of all categories with examples
    - Config override examples
    - Explanation of deny vs ask
  - Add "Customizing Risk Policies" section to README

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 8)
  - **Parallel Group**: Wave 3
  - **Blocks**: F1, F2
  - **Blocked By**: Tasks 3, 4, 5

  **Acceptance Criteria**:
  - [ ] README contains risk categories table
  - [ ] README contains config override examples
  - [ ] README explains deny vs ask

  **QA Scenarios**:

  ```
  Scenario: README documents all categories
    Tool: Bash (grep)
    Steps:
      1. grep -c "filesystem-destroy\|git-destructive\|git-risky\|db-destructive\|db-risky\|infra-destructive\|process-kill\|permission-escalation\|safety-bypass" README.md
      2. Assert: count >= 9
    Expected Result: All 9 categories mentioned
    Evidence: .sisyphus/evidence/task-7-readme-categories.txt
  ```

  **Commit**: NO (groups with Task 8)

---

- [ ] 8. Full Integration Check

  **What to do**:
  - Run `bun run check` (format + lint + typecheck + effect diagnostics + test)
  - Verify all existing tests still pass
  - Verify new tests pass
  - Verify `bun run check ci` also passes

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on all previous)
  - **Parallel Group**: Wave 3
  - **Blocks**: F1, F2
  - **Blocked By**: Tasks 2, 4, 5, 6

  **Acceptance Criteria**:
  - [ ] `bun run check` → exit code 0
  - [ ] `bun run check ci` → exit code 0
  - [ ] Zero new lint errors, zero type errors

  **QA Scenarios**:

  ```
  Scenario: Full check passes
    Tool: Bash
    Steps:
      1. bun run check
      2. Assert: exit code 0
    Expected Result: All checks pass
    Evidence: .sisyphus/evidence/task-8-full-check.txt
  ```

  **Commit**: YES
  - Message: `feat(credential-guard): add destructive intent guard with 9 risk categories, deny/ask decisions, config overrides`
  - Files: all changed files
  - Pre-commit: `bun run check`

---

## Final Verification Wave

- [ ] F1. **Code Quality Review** — `unspecified-high`
      Run `bun run check ci`. Review all changed files for: `as any`, empty catches, console.log, unused imports, excessive comments. Verify new patterns don't have regex catastrophic backtracking.
      Output: `Build [PASS/FAIL] | Tests [N/N] | VERDICT`

- [ ] F2. **Scope Fidelity Check** — `deep`
      For each task: read "What to do", read the diff. Verify 1:1 — everything in spec was built (nothing missing), nothing beyond spec was built (no creep). Verify "Must NOT do" compliance.
      Output: `Tasks [N/N compliant] | VERDICT`

---

## Commit Strategy

| Commit | Contains                                                            | Message                                                                            |
| ------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1      | Tasks 1-5 (types, patterns, core logic, config, infra CLI blocking) | `feat(credential-guard): add destructive intent detection with deny/ask decisions` |
| 2      | Tasks 6-8 (tests, docs, final check)                                | `feat(credential-guard): add destructive guard tests and documentation`            |

---

## Success Criteria

### Verification Commands

```bash
bun run check           # Expected: exit 0
bun test                # Expected: all tests pass
bun run check ci        # Expected: exit 0
```

### Final Checklist

- [ ] New `isDestructiveCommand` function exported and integrated
- [ ] 20+ destructive patterns covering 9 categories
- [ ] Deny/ask decision model working
- [ ] Config overrides working (deny→ask→allow)
- [ ] Error messages contain pattern ID
- [ ] Existing tests still passing
- [ ] README explicitly communicates guarantees and limits
- [ ] Zero breaking changes in existing API
