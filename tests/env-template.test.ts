import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { EnvTemplateError, resolveEnvTemplate } from "#shared/env-template";

const template = (name: string) => `$${`{${name}}`}`;

describe("resolveEnvTemplate", () => {
  it.effect("replaces embedded environment variable templates", () =>
    Effect.gen(function* () {
      const previous = process.env.AGENT_TOOLS_TEST_KUBECONFIG_DIR;
      process.env.AGENT_TOOLS_TEST_KUBECONFIG_DIR = "/tmp/kube";
      try {
        const resolved = yield* resolveEnvTemplate(
          `${template("AGENT_TOOLS_TEST_KUBECONFIG_DIR")}/config.yaml`,
        );

        expect(resolved).toBe("/tmp/kube/config.yaml");
      } finally {
        if (previous === undefined) {
          delete process.env.AGENT_TOOLS_TEST_KUBECONFIG_DIR;
        } else {
          process.env.AGENT_TOOLS_TEST_KUBECONFIG_DIR = previous;
        }
      }
    }),
  );

  it.effect("fails with EnvTemplateError when a referenced variable is missing", () =>
    Effect.gen(function* () {
      const previous = process.env.AGENT_TOOLS_TEST_MISSING_KUBECONFIG;
      delete process.env.AGENT_TOOLS_TEST_MISSING_KUBECONFIG;
      try {
        const error = yield* Effect.flip(
          resolveEnvTemplate(template("AGENT_TOOLS_TEST_MISSING_KUBECONFIG")),
        );

        expect(error).toBeInstanceOf(EnvTemplateError);
        expect(error.envVar).toBe("AGENT_TOOLS_TEST_MISSING_KUBECONFIG");
      } finally {
        if (previous !== undefined) {
          process.env.AGENT_TOOLS_TEST_MISSING_KUBECONFIG = previous;
        }
      }
    }),
  );
});
