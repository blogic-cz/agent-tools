---
name: grafana-tool
description: "LOAD THIS SKILL when: querying Grafana dashboards, datasources, alerts, Prometheus metrics, or Loki logs. Contains all grafana-tool commands and usage patterns."
---

# grafana-tool (Grafana)

Grafana API wrapper — health, dashboards, datasources, alerts, PromQL, and LogQL queries. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Run via `bun grafana-tool` (requires `@blogic-cz/agent-tools` as a dev dependency).
Auth: Grafana URL comes from `agent-tools.json5`; token is optional and read from the configured `tokenEnvVar` when present.

## Commands

```bash
bun grafana-tool health --env local
bun grafana-tool dashboards list --env local
bun grafana-tool dashboards get abcd1234 --env local
bun grafana-tool datasources list --env local
bun grafana-tool alerts list --env prod --profile default
bun grafana-tool alerts status --env prod --all
bun grafana-tool metrics query 'up' --env local
bun grafana-tool metrics range 'rate(http_server_request_duration_seconds_count[5m])' --env local --start now-1h --end now --step 60
bun grafana-tool logs query '{service_name="web-app"}' --env local --limit 100
```

Environment is any string from the selected Grafana profile's `environments` map (for example `local`, `test`, `prod`, `staging`).

## Configuration

```json5
{
  grafana: {
    default: {
      environments: {
        local: {
          url: "http://localhost:40300",
          prometheusUid: "prometheus",
          lokiUid: "loki",
        },
        prod: {
          url: "https://grafana.example.com",
          tokenEnvVar: "AGENT_TOOLS_GRAFANA_PROD_TOKEN",
          prometheusUid: "prometheus",
          lokiUid: "loki",
        },
      },
    },
  },
}
```

## Tips

- Use `--profile <name>` when a project defines multiple Grafana profiles.
- Use `metrics query` for instant PromQL and `metrics range` for time-series windows.
- Use `logs query` for LogQL via the configured Loki datasource.
- Error responses include a `hint` field when available. Some commands also include `nextCommand` and `retryable` when the underlying tool can suggest a concrete recovery path.
