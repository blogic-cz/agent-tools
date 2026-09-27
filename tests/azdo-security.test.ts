import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { AgentToolsConfig } from "#config";

import { ALLOWED_INVOKE_AREAS, BLOCKED_INVOKE_AREAS } from "#azdo/config";
import { isCommandAllowed, isInvokeAllowed } from "#azdo/security";
import { AzdoService } from "#azdo/service";
import { ConfigService } from "#config";

describe("AzdoService outbound content checks", () => {
  it.effect("refuses credential-bearing pipeline parameters before spawning az", () => {
    const observed: string[] = [];
    const token = `ghp_${"A".repeat(36)}`;
    const splitToken = `ghp_${"A".repeat(18)}'${"A".repeat(18)}'`;
    const config = {
      azure: {
        default: { organization: "https://dev.azure.com/example", defaultProject: "project" },
      },
    } as AgentToolsConfig;
    const spawner = ChildProcessSpawner.make((command) => {
      observed.push((command as { command: string }).command);
      return Effect.die("unexpected subprocess spawn");
    });
    const layer = AzdoService.layer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      Layer.provide(Layer.succeed(ConfigService, config)),
    );

    return Effect.gen(function* () {
      const service = yield* AzdoService;
      const result = yield* service
        .runCommand(`pipelines run --id 123 --variables example=${splitToken}`)
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result) && result.failure._tag === "AzdoSecurityError") {
        expect(result.failure.message).toContain("credential pattern");
        expect(result.failure.command).not.toContain(token);
      }
      expect(observed).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("checks direct invoke parameters before spawning az", () => {
    const observed: string[] = [];
    const variable = "AGENT_TOOLS_AZDO_TOKEN";
    const secret = 'quoted"\\token\nvalue';
    const config = {
      azure: {
        default: { organization: "https://dev.azure.com/example", defaultProject: "project" },
      },
    } as AgentToolsConfig;
    const spawner = ChildProcessSpawner.make((command) => {
      observed.push((command as { command: string }).command);
      return Effect.die("unexpected subprocess spawn");
    });
    const layer = AzdoService.layer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      Layer.provide(Layer.succeed(ConfigService, config)),
    );

    return Effect.gen(function* () {
      const previous = process.env[variable];
      process.env[variable] = secret;
      try {
        const service = yield* AzdoService;
        const result = yield* service
          .runInvoke({ area: "build", resource: "builds", queryParameters: { filter: secret } })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result) && result.failure._tag === "AzdoSecurityError") {
          expect(result.failure.message).toContain("credential from the process environment");
        }
        expect(observed).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
      }
    }).pipe(Effect.provide(layer));
  });
});

describe("azdo-tool security", () => {
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

    it("blocks write operations before allowed operations", () => {
      expect(isCommandAllowed("acr repository delete --name reg --repository list").allowed).toBe(
        false,
      );
    });

    it("blocks credential reads through the acr/account passthrough", () => {
      const result = isCommandAllowed("acr credential show --name reg");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("credential");

      expect(isCommandAllowed("acr token credential show --name t").allowed).toBe(false);
      expect(isCommandAllowed("account get-access-token").allowed).toBe(false);
      expect(isCommandAllowed("acr credential show --name reg --query passwords").allowed).toBe(
        false,
      );
    });

    it("leaves non-credential acr and account reads working", () => {
      expect(isCommandAllowed("acr repository list --name reg").allowed).toBe(true);
      expect(isCommandAllowed("acr list").allowed).toBe(true);
      expect(isCommandAllowed("account show").allowed).toBe(true);
    });

    it("does not apply the credential rules to Azure DevOps groups", () => {
      expect(isCommandAllowed("pipelines list --name secret-rotation").allowed).toBe(true);
    });

    it("allows run only in the pipelines group", () => {
      expect(isCommandAllowed("pipelines run --id 5").allowed).toBe(true);

      const acrRun = isCommandAllowed("acr run --registry reg --cmd 'bash -c whoami' /dev/null");
      expect(acrRun.allowed).toBe(false);
      expect(acrRun.reason).toContain("pipelines run");
      expect(isCommandAllowed("acr task run --registry reg --name t").allowed).toBe(false);
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
      expect(result.reason?.length).toBeGreaterThan(10);
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
