import { afterEach, expect, it, vi } from "vitest";

import { formatDiagnostics, runEffectDiagnostics } from "../scripts/effect-diagnostics";

afterEach(() => vi.unstubAllGlobals());

function mockDiagnosticProcess(stdout: string) {
  vi.stubGlobal("Bun", {
    spawn: () => ({
      exited: Promise.resolve(1),
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
    }),
  });
}

it("reports Effect diagnostics when the compiler exits nonzero", async () => {
  mockDiagnosticProcess(
    JSON.stringify({
      diagnostics: [
        {
          file: "src/probe.ts",
          line: 2,
          column: 1,
          severity: "error",
          code: 377001,
          name: "floatingEffect",
          message: "This Effect value is neither yielded nor used in an assignment.",
        },
      ],
      summary: { filesChecked: 1, errors: 1, warnings: 0, messages: 0 },
    }),
  );

  const result = await runEffectDiagnostics();
  expect(result.totalErrors).toBe(1);
  expect(formatDiagnostics(result)).toContain("[floatingEffect] src/probe.ts:2:1");
});

it("fails when the compiler exits nonzero without diagnostics", async () => {
  mockDiagnosticProcess(
    JSON.stringify({
      diagnostics: [],
      summary: { filesChecked: 1, errors: 0, warnings: 0, messages: 0 },
    }),
  );

  const result = await runEffectDiagnostics();
  expect(result.totalErrors).toBe(1);
  expect(formatDiagnostics(result)).toContain("effect-tsgo exited with code 1");
});
