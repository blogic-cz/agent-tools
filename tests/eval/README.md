# Eval Suite

Deterministic fixture-based evaluation for agent-tools CLI wrappers. Measures whether agent tool calls produce correct tool selection, command routing, flag handling, and output pattern matching.

## Running

```bash
bun run tests/eval/run.ts
```

## Structure

| File                  | Purpose                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `tasks.ts`            | 23 eval tasks with expected tool, input, and output pattern       |
| `fixtures/tasks.json` | Simulated agent responses (tool + input + output per task)        |
| `runner.ts`           | Deterministic scorer: compares fixtures against task expectations |
| `run.ts`              | Entry point — prints per-task scores and summary                  |
| `baseline.json`       | Recorded baseline scores for regression tracking                  |
| `types.ts`            | Shared types (`EvalTask`, `EvalScore`, `EvalReport`)              |

## Scoring

Each task scores 0, 0.5, or 1.0:

| Score   | Meaning                                               |
| ------- | ----------------------------------------------------- |
| **1.0** | Tool + command + all flags + output pattern all match |
| **0.5** | Tool + command match, but flags or pattern mismatch   |
| **0.0** | Tool or command mismatch, or fixture missing          |

A task **passes** only at score 1.0.

## Baseline (2026-03-01)

| Metric        | Value |
| ------------- | ----- |
| Total tasks   | 23    |
| Passed        | 21    |
| Failed        | 2     |
| Average score | 0.935 |

### Known failures

- **k8s-top-memory-hotspots** (0.5): Fixture missing `sortBy` flag — partial match
- **session-release-regression-search** (0.0): Fixture has `tool: "gh-tool"` but task expects `tool: "session-tool"`

### Per-tool breakdown

| Tool         | Tasks | Passed | Score   |
| ------------ | ----- | ------ | ------- |
| gh-tool      | 7     | 7      | 7.0/7.0 |
| db-tool      | 4     | 4      | 4.0/4.0 |
| k8s-tool     | 5     | 4      | 4.5/5.0 |
| az-tool      | 4     | 4      | 4.0/4.0 |
| logs-tool    | 2     | 2      | 2.0/2.0 |
| session-tool | 1     | 0      | 0.0/1.0 |

## Adding tasks

1. Add an `EvalTask` entry in `tasks.ts`
2. Add a matching fixture in `fixtures/tasks.json`
3. Run `bun run tests/eval/run.ts` and verify
4. Update `baseline.json` with new results
