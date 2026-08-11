import { describe, expect, it } from "@effect/vitest";

import { parseKubeConfigView, selectKubeContext } from "#k8s/context";

const view = {
  contexts: [
    { name: "other", context: { cluster: "other-cluster" } },
    { name: "admin@dev-cluster", context: { cluster: "dev-cluster" } },
  ],
  clusters: [
    { name: "other-cluster", cluster: { server: "https://other.example" } },
    { name: "dev-cluster", cluster: { server: "https://dev-cluster.example" } },
  ],
};

describe("parseKubeConfigView", () => {
  it("returns undefined for output that is not JSON", () => {
    expect(parseKubeConfigView("")).toBeUndefined();
    expect(parseKubeConfigView("not json")).toBeUndefined();
  });

  it("returns undefined for JSON that is not an object", () => {
    expect(parseKubeConfigView("null")).toBeUndefined();
  });

  it("parses a kubectl config view document", () => {
    expect(parseKubeConfigView(JSON.stringify(view))?.contexts).toHaveLength(2);
  });
});

describe("selectKubeContext", () => {
  it("matches a context by exact cluster name", () => {
    expect(selectKubeContext(view, "dev-cluster")).toBe("admin@dev-cluster");
  });

  it("falls back to a cluster whose server URL contains the id", () => {
    const serverOnly = {
      contexts: [{ name: "prod-ctx", context: { cluster: "renamed-cluster" } }],
      clusters: [{ name: "renamed-cluster", cluster: { server: "https://prd-cluster.example:6443" } }],
    };

    expect(selectKubeContext(serverOnly, "prd-cluster")).toBe("prod-ctx");
  });

  it("prefers the exact cluster-name match over a server URL match", () => {
    const both = {
      contexts: [
        { name: "by-server", context: { cluster: "renamed" } },
        { name: "by-name", context: { cluster: "dev-cluster" } },
      ],
      clusters: [
        { name: "renamed", cluster: { server: "https://dev-cluster.example" } },
        { name: "dev-cluster", cluster: { server: "https://elsewhere.example" } },
      ],
    };

    expect(selectKubeContext(both, "dev-cluster")).toBe("by-name");
  });

  it("returns undefined when no context matches", () => {
    expect(selectKubeContext(view, "missing-cluster")).toBeUndefined();
  });

  it("returns undefined for an absent or empty document", () => {
    expect(selectKubeContext(undefined, "dev-cluster")).toBeUndefined();
    expect(selectKubeContext({}, "dev-cluster")).toBeUndefined();
  });

  it("ignores entries with a missing name", () => {
    const nameless = {
      contexts: [{ context: { cluster: "dev-cluster" } }],
      clusters: [{ name: "dev-cluster", cluster: { server: "https://dev-cluster.example" } }],
    };

    expect(selectKubeContext(nameless, "dev-cluster")).toBeUndefined();
  });
});
