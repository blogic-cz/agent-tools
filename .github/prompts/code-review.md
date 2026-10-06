REPO: $GITHUB_REPOSITORY
PR NUMBER: $PR_NUMBER

Review ONLY the changes introduced by this pull request.
Use `gh pr diff $PR_NUMBER` to get the PR diff. Do NOT use `git fetch` or `git diff`.

PROJECT-SPECIFIC REVIEW CHECKS:

Review the PR diff for these project-specific patterns:

Effect Patterns:

- ✅ `ServiceMap.Service` for service definitions ❌ `Context.Tag` (deprecated pattern)
- ✅ `Schema.TaggedError` for typed errors ❌ `Data.TaggedError` or plain `class extends Error`. Verify the API against the installed Effect version and existing typed errors before requesting a rename.
- ✅ `Effect.gen(function* () { ... })` with generator syntax ❌ Bare promise chains or async/await
- ✅ `Effect.scoped` for resource management ❌ Manual cleanup logic
- ✅ Service namespace prefix `@agent-tools/ServiceName` ❌ Missing namespace prefix
- ✅ `Schema.Literals(...)` for union string types ❌ Hardcoded string unions
- ✅ Union type aliases for error types (e.g. `type XServiceError = ErrorA | ErrorB`) ❌ Inline error unions

TypeScript / Code Quality:

- ✅ `type` keyword for type definitions ❌ `interface` (unless extending)
- ✅ `import type { ... }` for type-only imports ❌ Mixed value/type imports (enforced by oxlint `consistent-type-imports`)
- ✅ `??` (nullish coalescing) ❌ `||` for default values
- ✅ No `any` anywhere ❌ `as any`, `@ts-ignore`, `@ts-expect-error`, explicit `any`
- ✅ kebab-case filenames ❌ PascalCase or camelCase filenames
- ✅ Bun APIs (`Bun.argv`, `Bun.file()`, `Bun.spawn()`) ❌ Node.js `fs`, `child_process` (except `node:util`)

CLI Tool Patterns:

- ✅ `parseArgs` from `node:util` for argument parsing ❌ Third-party CLI parsers
- ✅ Shared helpers from `src/shared/` (cli, exec, format, error-renderer) ❌ Duplicated utility logic
- ✅ TOON format as default output (`--format toon`) ❌ Raw `console.log` or unformatted output
- ✅ Config loaded via `src/config/loader.ts` ❌ Manual config file reading

Security (credential-guard):

- No hardcoded secrets, API keys, tokens, or passwords in code
- ✅ Secrets via environment variables (e.g. `passwordEnvVar` in config) ❌ Inline credentials
- ✅ Blocked path patterns for sensitive files ❌ Allowing reads of `.env`, `.pem`, `.key` files
- ✅ CLI wrapper tools (`agent-tools-*`) ❌ Direct `gh`, `kubectl`, `psql`, `az` calls without guard

Project Structure:

- ✅ Each tool in its own directory (`src/<tool-name>/`) ❌ Cross-tool imports between tool directories
- ✅ Shared utilities in `src/shared/` ❌ Tool-specific logic leaked into shared
- ✅ Types in dedicated `types.ts`, errors in `errors.ts` ❌ Types mixed into service files
- ✅ Config types in `src/config/types.ts` ❌ Config types scattered across tool dirs

Only flag patterns above if they appear in CHANGED lines of the PR diff. Do not scan the entire codebase.

INLINE COMMENTS:

- For each concrete issue that maps to a changed line in the PR, add an inline comment on that line.
- Each inline comment MUST end with this invisible signature, on a separate line:
  <!-- claude-code-review-inline -->

FINAL RESULT FORMAT (deterministic):

- At the very end of your run, output EXACTLY one of these lines as plain text (no markdown, no extra text):

  RESULT: PASSED
  (if you found no actionable issues in the PR diff)

  RESULT: FAILED
  (if you found at least one actionable issue)
