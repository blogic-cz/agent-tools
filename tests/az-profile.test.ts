import { describe, expect, it } from "vitest";

import type { AzurePlatformConfig } from "#config/types";

import { isProductionProfile, selectAzProfileName } from "#az/profile";

const profile = (overrides: Partial<AzurePlatformConfig> = {}): AzurePlatformConfig => ({
  subscription: "00000000-0000-0000-0000-000000000000",
  ...overrides,
});

describe("az-tool profile resolution", () => {
  describe("selectAzProfileName", () => {
    it("prefers an explicit profile", () => {
      expect(selectAzProfileName({ default: {}, prod: {} }, "prod")).toBe("prod");
    });

    it("auto-selects a lone profile", () => {
      expect(selectAzProfileName({ staging: {} }, undefined)).toBe("staging");
    });

    it("falls back to the default key when several exist", () => {
      expect(selectAzProfileName({ default: {}, prod: {} }, undefined)).toBe("default");
    });

    it("resolves nothing when several exist without a default", () => {
      expect(selectAzProfileName({ test: {}, prod: {} }, undefined)).toBeUndefined();
    });

    it("resolves nothing without a section", () => {
      expect(selectAzProfileName(undefined, undefined)).toBeUndefined();
    });
  });

  describe("isProductionProfile", () => {
    it("treats prod and production keys as production by convention", () => {
      expect(isProductionProfile("prod", profile())).toBe(true);
      expect(isProductionProfile("production", profile())).toBe(true);
      expect(isProductionProfile("PROD", profile())).toBe(true);
    });

    it("treats other keys as non-production", () => {
      expect(isProductionProfile("default", profile())).toBe(false);
      expect(isProductionProfile("staging", profile())).toBe(false);
      expect(isProductionProfile(undefined, profile())).toBe(false);
    });

    it("lets an explicit flag mark any profile production", () => {
      expect(isProductionProfile("default", profile({ production: true }))).toBe(true);
    });

    it("lets an explicit flag opt a prod-named profile out", () => {
      expect(isProductionProfile("prod", profile({ production: false }))).toBe(false);
    });
  });
});
