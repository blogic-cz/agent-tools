# Local Override Config Code Review

Goal: Support local override config files in `@blogic-cz/agent-tools`, release/tag a new version, and update Nexus.

Scope: Read-only review of current uncommitted product diff in `/Users/gabrielecegi/bp/agent-tools` plus Nexus consumption points in `/Users/gabrielecegi/bp/nexus`.

Note: The product diff appeared after the initial clean status while this review was running. I did not edit product files. I only wrote this review artifact.

## Skill-Perspective Check

- `omo:remove-ai-slops`: loaded and applied. The review specifically checked for deletion-only/tautological tests, tests that merely mirror requested implementation details, dead helpers, and needless production complexity.
- `omo:programming`: loaded with the TypeScript reference and applied. The review specifically checked strict typing, boundary parsing, no `any`/assertion escapes, no needless abstraction, and behavior-facing tests over helper-mirroring tests.
- Result: Production code is mostly aligned with both lenses. Test coverage has one high-severity false-confidence gap.

## Evidence Inspected

- Current loader implementation: `src/config/loader.ts:197`, `src/config/loader.ts:230`, `src/config/loader.ts:258`, `src/config/loader.ts:299`, `src/config/loader.ts:311`.
- Current tests: `tests/config-loader.test.ts:32`, `tests/config-loader.test.ts:437`, `tests/config-loader.test.ts:516`, `tests/config-loader.test.ts:562`.
- Docs/package: `README.md:315`, `.gitignore:5`, `package.json:3`.
- Nexus consumption: `nexus-fe/package.json:96`, `nexus-be/package.json:23`, `/Users/gabrielecegi/bp/nexus/.gitignore:40`.
- Version evidence: local `package.json` now says `0.14.47`; local tags and npm latest were checked and are still `v0.14.46` / `0.14.46`.

## Verification Run

- `bun run test tests/config-loader.test.ts`: PASS, 34 tests.
- `bun run check`: PASS, format, lint, typecheck, Effect diagnostics, and 628 tests.

## Findings By Severity

### CRITICAL

None.

### HIGH

1. `tests/config-loader.test.ts:562` does not actually prove the nearest regular config resets parent inheritance.
   The test writes `github.default` in both parent and child, then asserts the child `default` value. A full root-to-leaf merge would also pass because the child value overrides the parent value. This is the key compatibility risk, so the test gives false confidence. Add a parent-only key, for example `github.rootOnly`, and assert it is absent when the child has its own regular config.

2. The owner goal includes updating Nexus, but the inspected diff only updates `agent-tools`.
   Nexus still pins `github:blogic-cz/agent-tools#v0.14.46` in `nexus-fe/package.json:96` and `nexus-be/package.json:23`, and Nexus root `.gitignore` does not ignore `agent-tools.local.json*`. This is a blocker before claiming the overall goal complete. If release/update is intentionally a later step after tagging, call that out explicitly.

### MEDIUM

1. Same-directory filename precedence is documented and implemented but not tested.
   `README.md:315` documents the order `agent-tools.json`, `agent-tools.json5`, `agent-tools.local.json`, `agent-tools.local.json5`; `src/config/loader.ts:230` and `src/config/loader.ts:281` implement it. Current tests cover base plus local JSON5 and child local JSON, but not the full same-directory order. Add one small observable test using `defaultEnvironment` or `github.default`.

2. The implementation intentionally changes behavior when both `agent-tools.json` and `agent-tools.json5` exist in the same base directory.
   Previous loader behavior ignored JSON when JSON5 existed. New behavior parses and merges both, with JSON5 overriding. That is fine if it is intended, but it should be treated as a documented compatibility edge in release notes because a stale lower-precedence file can now affect config or fail parsing.

3. Consumer `.gitignore` guidance is too implicit.
   Package `.gitignore` now ignores local files, and README says to keep them gitignored, but setup instructions do not give the exact lines consumers should add. Since the feature is explicitly for local machine-specific config, docs should show `agent-tools.local.json` and `agent-tools.local.json5` entries.

### LOW

1. `tests/config-loader.test.ts:516` test name says "without loading parent bases", but the expected result depends on the parent base being loaded. Rename it to describe child local override layering.

2. Final unknown-top-level stripping after merge is not covered at the loader boundary.
   Existing `decodeConfig` tests cover stripping, so this is not a blocker. A tiny loader test with a parent unknown section plus a local known override would lock the merged-boundary behavior.

## Recommended Filename And Order Semantics

The current implementation chooses the safer compatibility shape:

1. Walk upward from `process.cwd()` to the nearest regular config directory.
2. Use that nearest regular directory as the base reset point.
3. Load files in that base directory in this order:
   - `agent-tools.json`
   - `agent-tools.json5`
   - `agent-tools.local.json`
   - `agent-tools.local.json5`
4. From the base directory down to the current working directory, load only local override files in the same local order.
5. Later files override earlier files.
6. Plain objects deep-merge. Arrays, `null`, and primitives replace.
7. Decode the final merged value once with the existing schema and unknown-top-level stripping.

That is the right direction for avoiding the biggest existing-behavior break. The missing part is a stronger test proving parent regular configs above a child regular config do not leak through.

## Minimal Test Coverage

Keep the current tests, then add the smallest missing checks:

1. Strengthen `keeps the nearest regular config as the base` with a parent-only key that must be absent.
2. Add one same-directory file-order test covering all four filenames.
3. Optional low-cost edge: unknown top-level section survives merge input but is stripped by final decode.

Avoid exporting private discovery helpers just for tests. Testing through `loadConfig` is the right surface.

## Version And Release

`0.14.47` is reasonable for the `agent-tools` package if the compatibility-reset behavior is kept. This repo has been releasing feature work as patch increments, and npm/latest plus local tags are still at `0.14.46`.

If the design switches back to full root-to-leaf merging of every regular config, use `0.15.0` or clearly document the behavior break.

## Status

codeQualityStatus: BLOCK

recommendation: REQUEST_CHANGES

blockers:

- Fix the nearest-regular-config test so it fails under parent inheritance.
- Do not claim the overall owner goal complete until Nexus package pins/locks and `.gitignore` entries are updated after the new tag exists, or explicitly split release/Nexus update into a follow-up.
