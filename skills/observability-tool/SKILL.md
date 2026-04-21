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

```bash
bun observability-tool trace get 0b7bdf0dde1c55458364ba5588a8075e --env local --format json
bun observability-tool trace logs 0b7bdf0dde1c55458364ba5588a8075e --env local --limit 20 --format json
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

## Tips

- Use `trace get` first when you already have a trace ID.
- Use `trace logs` after `trace get` to check for correlated Loki output.
- Use `metrics query` for quick health and service checks across the LGTM stack.
- Tempo datasource UID is discovered automatically from Grafana datasources.
