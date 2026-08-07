import { describe, expect, it } from "vitest";

import { K8sCommandError } from "#k8s/errors";
import { selectKubeContext } from "#k8s/context";

const view = {
  contexts: [
    { name: "admin@dev-cluster", context: { cluster: "dev-cluster", user: "admin" } },
    { name: "admin@prod-cluster", context: { cluster: "prod-cluster", user: "admin" } },
    { name: "other", context: { cluster: "unrelated-cluster", user: "someone" } },
  ],
  clusters: [
    { name: "dev-cluster", cluster: { server: "https://10.0.0.1:6443" } },
    { name: "prod-cluster", cluster: { server: "https://10.0.0.2:6443" } },
    { name: "unrelated-cluster", cluster: { server: "https://example.test:443" } },
  ],
};

describe("selectKubeContext", () => {
  it("matches a context by exact cluster name", () => {
    expect(selectKubeContext(view, "dev-cluster")).toBe("admin@dev-cluster");
    expect(selectKubeContext(view, "prod-cluster")).toBe("admin@prod-cluster");
  });

  it("falls back to a cluster whose server URL contains the cluster id", () => {
    const serverOnly = {
      contexts: [{ name: "by-server", context: { cluster: "alias" } }],
      clusters: [{ name: "alias", cluster: { server: "https://dev-cluster.example.test:6443" } }],
    };

    expect(selectKubeContext(serverOnly, "dev-cluster")).toBe("by-server");
  });

  it("returns undefined when no context matches", () => {
    expect(selectKubeContext(view, "missing-cluster")).toBeUndefined();
  });

  it("tolerates malformed kubeconfig payloads instead of throwing", () => {
    expect(selectKubeContext(null, "dev-cluster")).toBeUndefined();
    expect(selectKubeContext({ contexts: "nope" }, "dev-cluster")).toBeUndefined();
    expect(selectKubeContext({ contexts: [{ name: 1 }] }, "dev-cluster")).toBeUndefined();
  });
});

describe("K8sCommandError", () => {
  it("accepts an explicitly undefined stderr instead of masking the real failure", () => {
    const error = new K8sCommandError({
      message: "Command execution failed: NotFound: ChildProcess.spawn (sh -c kubectl config view)",
      command: "sh -c kubectl config view",
      exitCode: -1,
      stderr: undefined,
    });

    expect(error.message).toContain("NotFound");
  });
});
