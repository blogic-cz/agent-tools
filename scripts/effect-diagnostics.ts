type TsgoDiagnostic = {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "message" | "suggestion";
  code: number;
  message: string;
};

type TsgoResult = {
  diagnostics: TsgoDiagnostic[];
  summary: {
    filesChecked: number;
    errors: number;
    warnings: number;
    messages: number;
  };
};

export type EffectDiagnostic = TsgoDiagnostic;

export type EffectDiagnosticsResult = {
  files: number;
  diagnostics: EffectDiagnostic[];
  totalErrors: number;
  totalWarnings: number;
  totalMessages: number;
  duration: number;
};

export async function runEffectDiagnostics(): Promise<EffectDiagnosticsResult> {
  const start = performance.now();
  const process = Bun.spawn(
    [
      "bunx",
      "effect-tsgo",
      "diagnostics",
      "--project",
      "tsconfig.json",
      "--format",
      "json",
      "--severity",
      "error",
      "--lspconfig",
      '{"diagnostics":true}',
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  try {
    const result = JSON.parse(stdout) as TsgoResult;
    return {
      files: result.summary.filesChecked,
      diagnostics: result.diagnostics,
      totalErrors: result.summary.errors,
      totalWarnings: result.summary.warnings,
      totalMessages: result.summary.messages,
      duration: performance.now() - start,
    };
  } catch {
    return {
      files: 0,
      diagnostics: [
        {
          file: "tsconfig.json",
          line: 1,
          column: 1,
          severity: "error",
          code: exitCode,
          message: stderr.trim() || "effect-tsgo returned invalid JSON",
        },
      ],
      totalErrors: 1,
      totalWarnings: 0,
      totalMessages: 0,
      duration: performance.now() - start,
    };
  }
}

export function formatDiagnostics(result: EffectDiagnosticsResult): string {
  return result.diagnostics
    .map(
      (diag) =>
        `  ${diag.severity} [${diag.code}] ${diag.file}:${diag.line}:${diag.column}\n    ${diag.message}`,
    )
    .join("\n");
}
