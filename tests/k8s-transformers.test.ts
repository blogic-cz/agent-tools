import { describe, expect, it } from "@effect/vitest";

import {
  transformDescribe,
  transformGenericKubectl,
  transformLogs,
  transformPods,
  transformTop,
} from "#k8s/transformers";

const podsJsonFixture = JSON.stringify({
  kind: "PodList",
  items: [
    {
      metadata: {
        name: "web-app-abc123-7d8f9",
        namespace: "default",
        ownerReferences: [{ name: "web-app-abc123-7d8f9", kind: "ReplicaSet" }],
      },
      status: {
        phase: "Running",
        containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }],
      },
    },
    {
      metadata: {
        name: "web-app-def456-8a7bc",
        namespace: "default",
        ownerReferences: [{ name: "web-app-def456-8a7bc", kind: "ReplicaSet" }],
      },
      status: {
        phase: "Running",
        containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }],
      },
    },
    {
      metadata: {
        name: "worker-xyz789-12345",
        namespace: "default",
        ownerReferences: [{ name: "worker-xyz789-12345", kind: "ReplicaSet" }],
      },
      status: {
        phase: "Error",
        containerStatuses: [
          { ready: false, restartCount: 5, state: { waiting: { reason: "CrashLoopBackOff" } } },
        ],
      },
    },
    {
      metadata: { name: "migration-job", namespace: "default" },
      status: {
        phase: "Failed",
        containerStatuses: [
          { ready: false, restartCount: 0, state: { terminated: { reason: "Error" } } },
        ],
      },
    },
  ],
});

describe("transformPods", () => {
  it("returns summary and only unhealthy pods in issues", () => {
    const result = transformPods(podsJsonFixture);

    expect(typeof result).toBe("object");
    if (typeof result === "string") {
      throw new Error("Expected structured pod summary");
    }

    expect(result.summary).toContain("4 pods");
    expect(result.healthy).toBe(2);
    expect(result.issues).toHaveLength(2);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          owner: "worker-xyz789",
          status: "CrashLoopBackOff",
          count: 1,
          restarts: 5,
        }),
        expect.objectContaining({ name: "migration-job", status: "Error", restarts: 0 }),
      ]),
    );
  });

  it("returns empty issues when all pods are healthy", () => {
    const healthyFixture = JSON.stringify({
      kind: "PodList",
      items: [
        {
          metadata: { name: "api-1", namespace: "default" },
          status: {
            phase: "Running",
            containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }],
          },
        },
        {
          metadata: { name: "job-1", namespace: "default" },
          status: {
            phase: "Succeeded",
            containerStatuses: [
              { ready: false, restartCount: 0, state: { terminated: { reason: "Completed" } } },
            ],
          },
        },
      ],
    });

    const result = transformPods(healthyFixture);

    if (typeof result === "string") {
      throw new Error("Expected structured pod summary");
    }

    expect(result.summary).toContain("2 pods");
    expect(result.healthy).toBe(2);
    expect(result.issues).toEqual([]);
  });

  it("returns input as-is for invalid JSON", () => {
    const raw = "not-json-output";
    expect(transformPods(raw)).toBe(raw);
  });

  it("groups issue pods by owner and status", () => {
    const groupedFixture = JSON.stringify({
      kind: "PodList",
      items: [
        {
          metadata: {
            name: "container-cleanup-29575265-8rw6c",
            namespace: "default",
            ownerReferences: [{ name: "container-cleanup-29575265", kind: "ReplicaSet" }],
          },
          status: {
            phase: "Error",
            containerStatuses: [
              { ready: false, restartCount: 0, state: { terminated: { reason: "Error" } } },
            ],
          },
        },
        {
          metadata: {
            name: "container-cleanup-29575265-9xk2m",
            namespace: "default",
            ownerReferences: [{ name: "container-cleanup-29575265", kind: "ReplicaSet" }],
          },
          status: {
            phase: "Error",
            containerStatuses: [
              { ready: false, restartCount: 2, state: { terminated: { reason: "Error" } } },
            ],
          },
        },
      ],
    });

    const result = transformPods(groupedFixture);
    if (typeof result === "string") {
      throw new Error("Expected structured pod summary");
    }

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual(
      expect.objectContaining({
        owner: "container-cleanup",
        status: "Error",
        count: 2,
        restarts: 2,
      }),
    );
  });
});

describe("transformTop", () => {
  it("parses top output and computes totals", () => {
    const input = [
      "NAME                     CPU(cores)   MEMORY(bytes)",
      "web-app-1                500m         256Mi",
      "worker-1                 2000m        4Gi",
    ].join("\n");

    const result = transformTop(input);
    expect(result).toEqual({
      summary: "2 pods: total CPU 2500m, Memory 4352Mi",
      pods: [
        { name: "web-app-1", cpu: "500m", memory: "256Mi" },
        { name: "worker-1", cpu: "2000m", memory: "4Gi" },
      ],
    });
  });
});

describe("transformDescribe", () => {
  it("keeps important sections and strips noise", () => {
    const longAnnotation = "x".repeat(140);
    const input = [
      "Name:           web-app-abc123",
      "Namespace:      default",
      "Labels:         app=web-app",
      "                tier=frontend",
      `Annotations:    sidecar.istio.io/status: ${longAnnotation}`,
      "Status:         Running",
      "Volumes:",
      "  config:",
      "    Type: ConfigMap (a volume populated by a ConfigMap)",
      "  cache:",
      "    Type: EmptyDir (a temporary directory that shares a pod's lifetime)",
      "Conditions:",
      "  Type              Status  Reason",
      "  Initialized       True    -",
      "  Ready             False   ContainersNotReady",
      "Events:",
      "  Type    Reason   Age   From     Message",
      "  Normal  Pulling  1m    kubelet  Pulling image",
      "  Warning BackOff  1m    kubelet  Back-off restarting failed container",
      "Managed Fields:",
      "  apiVersion: v1",
    ].join("\n");

    const result = transformDescribe(input);

    expect(result).toContain("Name: web-app-abc123");
    expect(result).toContain("Namespace: default");
    expect(result).toContain("Status: Running");
    expect(result).toContain("Labels:");
    expect(result).toContain("app=web-app");
    expect(result).toContain("Volumes: 2 standard volumes");
    expect(result).toContain("Conditions:");
    expect(result).toContain("Ready: False");
    expect(result).toContain("Events:");
    expect(result).not.toContain("Managed Fields");
    expect(result).toContain("…");
  });

  it("summarizes conditions when all are True", () => {
    const input = [
      "Name:       api",
      "Conditions:",
      "  Type              Status",
      "  Initialized       True",
      "  Ready             True",
      "  ContainersReady   True",
      "  PodScheduled      True",
    ].join("\n");

    const result = transformDescribe(input);
    expect(result).toContain("Conditions: All 4 conditions True");
  });
});

describe("transformLogs", () => {
  it("deduplicates repeated lines with timestamp normalization", () => {
    const input = [
      "2026-01-01T12:00:00Z request id=123e4567-e89b-12d3-a456-426614174000 failed",
      "2026-01-01T12:00:01Z request id=123e4567-e89b-12d3-a456-426614174111 failed",
      "2026-01-01T12:00:02Z other line",
    ].join("\n");

    const result = transformLogs(input);
    expect(result).toContain("failed [×2]");
    expect(result).toContain("other line");
  });
});

describe("transformGenericKubectl", () => {
  it("parses JSON output", () => {
    const input = '{"kind":"Pod","metadata":{"name":"api"}}';
    const result = transformGenericKubectl(input, "get pod api -o json");

    expect(result).toEqual({ kind: "Pod", metadata: { name: "api" } });
  });

  it("strips placeholder columns, collapses uniform values, and strips label columns", () => {
    const input = [
      "NAME    READY   STATUS    NOMINATED NODE   READINESS GATES",
      "pod-1   1/1     Running   <none>           <none>",
      "pod-2   1/1     Running   <none>           <none>",
    ].join("\n");

    const result = transformGenericKubectl(input, "get pods");
    expect(result).toEqual({
      headers: ["NAME"],
      rows: [{ NAME: "pod-1" }, { NAME: "pod-2" }],
      uniform: { READY: "1/1", STATUS: "Running" },
      stripped: ["NOMINATED_NODE", "READINESS_GATES"],
    });
  });

  it("keeps columns with varying values", () => {
    const input = [
      "NAME    READY   STATUS",
      "pod-1   1/1     Running",
      "pod-2   0/1     Error",
    ].join("\n");

    const result = transformGenericKubectl(input, "get pods");
    expect(result).toEqual({
      headers: ["NAME", "READY", "STATUS"],
      rows: [
        { NAME: "pod-1", READY: "1/1", STATUS: "Running" },
        { NAME: "pod-2", READY: "0/1", STATUS: "Error" },
      ],
    });
  });

  it("strips SELECTOR column and collapses uniform AGE for service tables", () => {
    const input = [
      "NAME                    TYPE           CLUSTER-IP       EXTERNAL-IP   PORT(S)        AGE    SELECTOR",
      "alertmanager            ClusterIP      None             <none>        9093/TCP       133d   app.kubernetes.io/name=alertmanager",
      "ingress-nginx           LoadBalancer   10.97.150.227    <pending>     80:31523/TCP   133d   app.kubernetes.io/name=ingress-nginx",
      "postgresql              ClusterIP      10.108.64.208    <none>        5432/TCP       133d   app.kubernetes.io/name=postgres",
    ].join("\n");

    const result = transformGenericKubectl(input, "get svc -o wide");
    expect(result).toEqual({
      headers: ["NAME", "TYPE", "CLUSTER-IP", "PORT(S)"],
      rows: [
        { NAME: "alertmanager", TYPE: "ClusterIP", "CLUSTER-IP": "None", "PORT(S)": "9093/TCP" },
        {
          NAME: "ingress-nginx",
          TYPE: "LoadBalancer",
          "CLUSTER-IP": "10.97.150.227",
          "PORT(S)": "80:31523/TCP",
        },
        {
          NAME: "postgresql",
          TYPE: "ClusterIP",
          "CLUSTER-IP": "10.108.64.208",
          "PORT(S)": "5432/TCP",
        },
      ],
      uniform: { AGE: "133d" },
      stripped: ["EXTERNAL-IP", "SELECTOR"],
    });
  });

  it("strips <pending> and <unknown> placeholders", () => {
    const input = [
      "NAME      STATUS      EXTERNAL-IP   NOMINATED",
      "node-1    Ready       <pending>     <unknown>",
      "node-2    NotReady    <pending>     <unknown>",
    ].join("\n");

    const result = transformGenericKubectl(input, "get nodes");
    expect(result).toEqual({
      headers: ["NAME", "STATUS"],
      rows: [
        { NAME: "node-1", STATUS: "Ready" },
        { NAME: "node-2", STATUS: "NotReady" },
      ],
      stripped: ["EXTERNAL-IP", "NOMINATED"],
    });
  });

  it("strips LABELS column even with short label values", () => {
    const input = [
      "NAME      READY   AGE    LABELS",
      "node-1    True    30d    role=worker",
      "node-2    True    30d    role=control",
    ].join("\n");

    const result = transformGenericKubectl(input, "get nodes");
    expect(result).toEqual({
      headers: ["NAME"],
      rows: [{ NAME: "node-1" }, { NAME: "node-2" }],
      uniform: { READY: "True", AGE: "30d" },
      stripped: ["LABELS"],
    });
  });

  it("strips unnamed columns with long kubernetes label values", () => {
    const input = [
      "NAME      TYPE         ANNOTATIONS",
      "svc-1     ClusterIP    app.kubernetes.io/managed-by=helm,app.kubernetes.io/instance=prometheus-stack,app.kubernetes.io/version=2.51.0",
      "svc-2     ClusterIP    app.kubernetes.io/managed-by=helm,app.kubernetes.io/instance=cert-manager,app.kubernetes.io/version=1.14.0",
    ].join("\n");

    const result = transformGenericKubectl(input, "get svc");
    expect(result).toEqual({
      headers: ["NAME"],
      rows: [{ NAME: "svc-1" }, { NAME: "svc-2" }],
      uniform: { TYPE: "ClusterIP" },
      stripped: ["ANNOTATIONS"],
    });
  });

  it("keeps columns with long non-label values", () => {
    const input = [
      "NAME      MESSAGE",
      "event-1   Back-off restarting failed container web-app in pod web-app-abc123-7d8f9_default",
      "event-2   Successfully pulled image registry.example.com/web-app:v1.2.3 in 3.456s (4.567s total)",
    ].join("\n");

    const result = transformGenericKubectl(input, "get events");
    expect(result).toEqual({
      headers: ["NAME", "MESSAGE"],
      rows: [
        {
          NAME: "event-1",
          MESSAGE:
            "Back-off restarting failed container web-app in pod web-app-abc123-7d8f9_default",
        },
        {
          NAME: "event-2",
          MESSAGE:
            "Successfully pulled image registry.example.com/web-app:v1.2.3 in 3.456s (4.567s total)",
        },
      ],
    });
  });

  it("does not collapse uniform columns for single-row tables", () => {
    const input = ["NAME      READY   STATUS", "pod-1     1/1     Running"].join("\n");

    const result = transformGenericKubectl(input, "get pod pod-1");
    expect(result).toEqual({
      headers: ["NAME", "READY", "STATUS"],
      rows: [{ NAME: "pod-1", READY: "1/1", STATUS: "Running" }],
    });
  });

  it("preserves column with mixed placeholder and real values", () => {
    const input = [
      "NAME      TYPE           EXTERNAL-IP     PORT(S)",
      "svc-1     ClusterIP      <none>          80/TCP",
      "svc-2     LoadBalancer   203.0.113.50    443/TCP",
      "svc-3     ClusterIP      <none>          8080/TCP",
    ].join("\n");

    const result = transformGenericKubectl(input, "get svc");
    expect(result).toEqual({
      headers: ["NAME", "TYPE", "EXTERNAL-IP", "PORT(S)"],
      rows: [
        { NAME: "svc-1", TYPE: "ClusterIP", "EXTERNAL-IP": "<none>", "PORT(S)": "80/TCP" },
        {
          NAME: "svc-2",
          TYPE: "LoadBalancer",
          "EXTERNAL-IP": "203.0.113.50",
          "PORT(S)": "443/TCP",
        },
        { NAME: "svc-3", TYPE: "ClusterIP", "EXTERNAL-IP": "<none>", "PORT(S)": "8080/TCP" },
      ],
    });
  });

  it("does not collapse column when some rows have missing trailing values", () => {
    const input = [
      "NAME      ENV     STATUS",
      "pod-1     prod    Running",
      "pod-2     prod    Running",
      "pod-3     prod",
    ].join("\n");

    const result = transformGenericKubectl(input, "get pods");
    expect(result).toEqual({
      headers: ["NAME", "STATUS"],
      rows: [
        { NAME: "pod-1", STATUS: "Running" },
        { NAME: "pod-2", STATUS: "Running" },
        { NAME: "pod-3", STATUS: "" },
      ],
      uniform: { ENV: "prod" },
    });
  });

  it("does not strip column at label-detection boundary (avg=50, ratio=0.5)", () => {
    // Exactly 50-char avg and exactly 50% label-like — should NOT strip (threshold is >50 and >0.5)
    const input = [
      "NAME      INFO",
      // 50 chars, label-like
      "row-1     app.kubernetes.io/name=xxxxxxxxxxxxxxxxxxxxxxxxx",
      // 50 chars, not label-like (no = sign)
      "row-2     this-is-a-plain-text-value-that-is-fifty-chars--",
    ].join("\n");

    const result = transformGenericKubectl(input, "get things");
    expect(result).toEqual({
      headers: ["NAME", "INFO"],
      rows: [
        { NAME: "row-1", INFO: "app.kubernetes.io/name=xxxxxxxxxxxxxxxxxxxxxxxxx" },
        { NAME: "row-2", INFO: "this-is-a-plain-text-value-that-is-fifty-chars--" },
      ],
    });
  });

  it("strips column just above label-detection threshold", () => {
    const input = [
      "NAME      ANNOTATIONS",
      // 52 chars, label-like
      "row-1     app.kubernetes.io/name=xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      // 52 chars, label-like
      "row-2     app.kubernetes.io/instance=xxxxxxxxxxxxxxxxxxxxxxxx",
      // 52 chars, not label-like
      "row-3     this-is-just-a-long-plain-text-value-no-labels-ok",
    ].join("\n");

    const result = transformGenericKubectl(input, "get things");
    // 2/3 = 0.667 > 0.5 ratio, avg > 50 → stripped
    expect(result).toEqual({
      headers: ["NAME"],
      rows: [{ NAME: "row-1" }, { NAME: "row-2" }, { NAME: "row-3" }],
      stripped: ["ANNOTATIONS"],
    });
  });

  it("handles header-only table with zero data rows", () => {
    const input = "NAME    READY   STATUS";
    // Only 1 line = header, no data rows → not a table (rows.length < 1)
    expect(transformGenericKubectl(input, "get pods")).toBe(input);
  });

  it("returns short plain text as-is", () => {
    const input = "deployment.apps/api configured";
    expect(transformGenericKubectl(input, "rollout restart deploy/api")).toBe(input);
  });
});
