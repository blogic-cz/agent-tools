# agent-tools

This project contains safe CLI wrappers for AI coding agents. The tools provide controlled access to GitHub, databases, Kubernetes, Azure DevOps, application logs, and OpenCode sessions — with project-specific configuration via JSON5.

## Code Quality

**CRITICAL: Always run `bun run check` after every change. If it fails, your code is wrong — fix it. Never bypass or ignore failing checks.**

```bash
bun run check      # format + lint + typecheck + effect diagnostics + test
bun run check ci   # all parallel, format --check only (no file modification)
```

## Publishing

Publishing is tag-driven. Do not run `npm publish` locally.

1. Bump version in `package.json`
2. Commit and push to `main`
3. Create and push a git tag: `git tag v0.1.0 && git push origin v0.1.0`
4. GitHub Actions workflow (`.github/workflows/publish.yml`) picks up the tag and publishes to npm via OIDC trusted publishing
