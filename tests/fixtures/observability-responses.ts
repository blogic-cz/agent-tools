export const observabilityResponses = {
  datasources: [
    {
      id: 1,
      uid: "prometheus",
      name: "Prometheus",
      type: "prometheus",
      url: "http://prometheus:9090",
    },
    { id: 2, uid: "loki", name: "Loki", type: "loki", url: "http://loki:3100" },
    { id: 3, uid: "tempo", name: "Tempo", type: "tempo", url: "http://tempo:3200" },
  ],
  trace: {
    batches: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "mock-service" } },
            { key: "deployment.environment.name", value: { stringValue: "local" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "mock-scope" },
            spans: [
              {
                traceId: "C3vfDd4cVUWDZLpViKgHXg==",
                spanId: "S0N7+zAcy2E=",
                name: "GET /health",
                kind: "SPAN_KIND_SERVER",
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "2000000000",
                status: { code: "STATUS_CODE_OK" },
                attributes: [{ key: "http.request.method", value: { stringValue: "GET" } }],
              },
              {
                traceId: "C3vfDd4cVUWDZLpViKgHXg==",
                spanId: "lpm/1p/QGE0=",
                parentSpanId: "S0N7+zAcy2E=",
                name: "select 1",
                kind: "SPAN_KIND_CLIENT",
                startTimeUnixNano: "1200000000",
                endTimeUnixNano: "1500000000",
                status: { code: "STATUS_CODE_OK" },
                attributes: [{ key: "db.system", value: { stringValue: "postgresql" } }],
              },
            ],
          },
        ],
      },
    ],
  },
  '{job=~".+"} |= "0b7bdf0dde1c55458364ba5588a8075e"': {
    results: {
      A: {
        frames: [
          {
            schema: {
              fields: [
                { name: "timestamp", type: "time" },
                { name: "line", type: "string" },
                { name: "labels", type: "string" },
              ],
            },
            data: {
              values: [
                [1710000000000],
                ['{"level":"info","trace_id":"0b7bdf0dde1c55458364ba5588a8075e"}'],
                ['{"job":"mock-app"}'],
              ],
            },
          },
        ],
      },
    },
  },
  up: {
    results: {
      A: {
        frames: [
          {
            schema: {
              fields: [
                { name: "Time", type: "time" },
                { name: "Value", type: "number", labels: { job: "tempo", instance: "tempo:3200" } },
              ],
            },
            data: {
              values: [
                [1710000000000, 1710000060000],
                [1, 1],
              ],
            },
          },
        ],
      },
    },
  },
  '{job="mock-app"} |= "ExternalService"': {
    results: {
      A: {
        frames: [
          {
            schema: {
              fields: [
                { name: "timestamp", type: "time" },
                { name: "line", type: "string" },
                { name: "labels", type: "string" },
              ],
            },
            data: {
              values: [
                [1710000000001],
                [
                  '{"body":"ExternalService request failed","severity":"Error","attributes":{"JobId":"job-1","exception.message":"permission denied"}}',
                ],
                ['{"job":"mock-app"}'],
              ],
            },
          },
        ],
      },
    },
  },
  '{job="field-label-app"}': {
    results: {
      A: {
        frames: [
          {
            schema: {
              fields: [
                { name: "timestamp", type: "time" },
                { name: "line", type: "string", labels: { job: "field-label-app", pod: "pod-1" } },
              ],
            },
            data: {
              values: [[1710000000002], ["field labels log"]],
            },
          },
        ],
      },
    },
  },
  '{job="mixed-label-app"}': {
    results: {
      A: {
        frames: [
          {
            schema: {
              fields: [
                { name: "timestamp", type: "time" },
                { name: "line", type: "string", labels: { job: "mixed-label-app", pod: "pod-2" } },
                { name: "labelTypes", type: "other" },
              ],
            },
            data: {
              values: [[1710000000003], ["mixed labels log"], [{ job: "S", pod: "S" }]],
            },
          },
        ],
      },
    },
  },
};
