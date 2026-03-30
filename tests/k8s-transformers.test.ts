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

  it("parses table output and strips <none> columns", () => {
    const input = [
      "NAME    READY   STATUS    NOMINATED NODE   READINESS GATES",
      "pod-1   1/1     Running   <none>           <none>",
      "pod-2   1/1     Running   <none>           <none>",
    ].join("\n");

    const result = transformGenericKubectl(input, "get pods");
    expect(result).toEqual({
      headers: ["NAME", "READY", "STATUS"],
      rows: [
        { NAME: "pod-1", READY: "1/1", STATUS: "Running" },
        { NAME: "pod-2", READY: "1/1", STATUS: "Running" },
      ],
    });
  });

  it("returns short plain text as-is", () => {
    const input = "deployment.apps/api configured";
    expect(transformGenericKubectl(input, "rollout restart deploy/api")).toBe(input);
  });
});
