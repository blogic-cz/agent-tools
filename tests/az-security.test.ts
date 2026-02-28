import { describe, expect, it } from "vitest";

import { ALLOWED_INVOKE_AREAS, BLOCKED_INVOKE_AREAS } from "../src/az-tool/config";
import { isCommandAllowed, isInvokeAllowed } from "../src/az-tool/security";

describe("az-tool security", () => {
  describe("isCommandAllowed", () => {
    it("allows read-only operations", () => {
      expect(isCommandAllowed("pipelines list").allowed).toBe(true);
      expect(isCommandAllowed("repos show --id 123").allowed).toBe(true);
      expect(isCommandAllowed("acr repository list --name test").allowed).toBe(true);
      expect(
        isCommandAllowed("devops invoke --area build --resource timeline --api-version 7.1")
          .allowed,
      ).toBe(true);
    });

    it("blocks write operations", () => {
      expect(isCommandAllowed("pipelines create").allowed).toBe(false);
      expect(isCommandAllowed("repos delete --id 123").allowed).toBe(false);
      expect(isCommandAllowed("pipelines update --id 123").allowed).toBe(false);
    });

    it("blocks write operations after allowed operations", () => {
      expect(isCommandAllowed("pipelines list delete").allowed).toBe(false);
    });

    it("provides reason for blocked commands", () => {
      const result = isCommandAllowed("pipelines create");
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain("blocked");
    });

    it("blocks invoke in blocked area", () => {
      const result = isCommandAllowed("devops invoke --area git --resource refs");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });

    it("blocks invoke with non-GET method", () => {
      const result = isCommandAllowed(
        "devops invoke --area build --resource timeline --http-method POST",
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("GET");
    });

    it("blocks invoke without required parameters", () => {
      const result = isCommandAllowed("devops invoke --resource timeline");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("--area");
    });
  });

  describe("isInvokeAllowed", () => {
    it("allows read-only areas and resources", () => {
      expect(
        isInvokeAllowed({
          area: "build",
          resource: "timeline",
        }).allowed,
      ).toBe(true);
      expect(isInvokeAllowed({ area: "build", resource: "logs" }).allowed).toBe(true);
      expect(
        isInvokeAllowed({
          area: "build",
          resource: "builds",
        }).allowed,
      ).toBe(true);
    });

    it("blocks dangerous areas", () => {
      const result = isInvokeAllowed({
        area: "git",
        resource: "refs",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });

    it("blocks write resources in allowed areas", () => {
      const result = isInvokeAllowed({
        area: "build",
        resource: "definitions",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });

    it("blocks unknown areas by default", () => {
      const result = isInvokeAllowed({
        area: "unknown-area",
        resource: "anything",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in allowed list");
    });

    it("blocks unknown resources in allowed areas", () => {
      const result = isInvokeAllowed({
        area: "build",
        resource: "unknown-resource",
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in allowed list");
    });

    it("provides helpful error messages", () => {
      const result = isInvokeAllowed({
        area: "git",
        resource: "pushes",
      });
      expect(result.reason).toBeDefined();
      expect(result.reason!.length).toBeGreaterThan(10);
    });
  });

  describe("config exports", () => {
    it("ALLOWED_INVOKE_AREAS contains only read-only areas", () => {
      expect(ALLOWED_INVOKE_AREAS).toContain("build");
    });

    it("BLOCKED_INVOKE_AREAS contains dangerous write areas", () => {
      expect(BLOCKED_INVOKE_AREAS).toContain("git");
      expect(BLOCKED_INVOKE_AREAS).toContain("policy");
      expect(BLOCKED_INVOKE_AREAS).toContain("security");
    });

    it("ALLOWED and BLOCKED areas do not overlap", () => {
      const overlap = ALLOWED_INVOKE_AREAS.filter((area) =>
        BLOCKED_INVOKE_AREAS.includes(area as (typeof BLOCKED_INVOKE_AREAS)[number]),
      );
      expect(overlap).toHaveLength(0);
    });
  });
});
