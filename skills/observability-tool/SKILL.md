---
name: observability-tool
description: "LOAD THIS SKILL when: investigating Grafana-backed LGTM telemetry, especially Tempo traces, Loki log correlation, and Prometheus metrics through observability-tool. Contains all observability-tool commands and usage patterns."
---

# observability-tool (LGTM)

LGTM wrapper for trace and telemetry inspection through Grafana. Covers Tempo trace lookup, Loki trace log correlation, and Prometheus metrics queries using the project `agent-tools.json5` configuration.

## How to Run

Run via `bun observability-tool` (requires `@blogic-cz/agent-tools` as a dev dependency).
Auth: Grafana URL comes from `agent-tools.json5`; token is optional and read from the configured `tokenEnvVar` when present.

## Commands

Both `trace get` and `trace logs` accept a 32-char trace ID **or** a 16-char span ID. When given a span ID, the tool automatically resolves it to the parent trace via Tempo TraceQL search (with auto-widening: 1h → 24h).

```bash
bun observability-tool trace get 0b7bdf0dde1c55458364ba5588a8075e --env local --format json
bun observability-tool trace get 95fe83f969df3c29 --env local --format json
bun observability-tool trace logs 0b7bdf0dde1c55458364ba5588a8075e --env local --limit 20 --format json
bun observability-tool trace logs 95fe83f969df3c29 --env local --limit 20 --format json
bun observability-tool trace find 95fe83f969df3c29 --env local --format json
bun observability-tool metrics query 'up' --env local --start now-1h --end now --step 60 --format json
```

## Configuration

```json5
{
  observability: {
    default: {
      environments: {
        local: {
          url: "http://localhost:40300",
          prometheusUid: "prometheus",
          lokiUid: "loki",
        },
        prod: {
          url: "https://grafana.example.com",
          tokenEnvVar: "AGENT_TOOLS_OBSERVABILITY_PROD_TOKEN",
          prometheusUid: "prometheus",
          lokiUid: "loki",
        },
      },
    },
  },
}
```

## Output Schema

When using `trace get` or `trace logs`, the response always includes `data.input` and `data.resolution`:

- `data.input.kind` — `"trace_id"` or `"span_id"` (what was provided)
- `data.resolution.via` — `"direct_trace_id"` or `"span_search"` (how the trace was found)
- `data.resolution.resolvedTraceId` — the 32-char trace ID used for the actual lookup
- `data.resolution.focusSpan` — the matched span object when searching by span ID
- `data.resolution.attemptedWindows` — search windows tried during span lookup
- `data.resolution.usedWindow` — the window that produced the match

If a span ID is found in multiple traces, the tool returns an `AMBIGUOUS_SPAN_ID` error with `candidateTraceIds`.

## Tips

- Use `trace get <id>` with either a trace ID or span ID — the tool auto-detects and resolves.
- Use `trace logs <id>` the same way — span IDs are resolved to trace IDs before the Loki query.
- `trace find` is an alias for `trace get` — use whichever feels natural.
- Span search auto-widens from 1h to 24h. Pass explicit `--start`/`--end` to override.
- Use `metrics query` for quick health and service checks across the LGTM stack.
- Tempo datasource UID is discovered automatically from Grafana datasources.
- Use `bun observability-tool commands` for the full machine-readable command/flag tree; `--help` for one subcommand.
- Output defaults to **TOON** (token-efficient) — leave it as-is to save tokens. Add `--format json` only when you'll machine-parse the result.
