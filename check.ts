import {
  runEffectDiagnostics,
  formatDiagnostics as formatEffectDiagnostics,
} from "./scripts/effect-diagnostics";

type StepResult = {
  name: string;
  success: boolean;
  duration: number;
  output?: string;
};

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function run(cmd: string[]): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { exitCode, stdout, stderr };
}

async function runStep(
  name: string,
  fn: () => Promise<{ success: boolean; output?: string }>,
): Promise<StepResult> {
  const start = performance.now();
  const { success, output } = await fn();
  const duration = (performance.now() - start) / 1000;
  return { name, success, duration, output };
}

function formatDuration(seconds: number): string {
  return seconds >= 1 ? `${seconds.toFixed(1)}s` : `${(seconds * 1000).toFixed(0)}ms`;
}

function printResult(result: StepResult): void {
  const icon = result.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`${icon} ${result.name} (${formatDuration(result.duration)})`);

  if (!result.success && result.output) {
    console.log();
    console.log(result.output);
  }
}

async function lint(): Promise<{
  success: boolean;
  output?: string;
}> {
  const result = await run(["bunx", "oxlint", "-c", "./.oxlintrc.json", "--deny-warnings"]);
  return {
    success: result.exitCode === 0,
    output: result.exitCode !== 0 ? result.stderr || result.stdout : undefined,
  };
}

async function typecheck(): Promise<{
  success: boolean;
  output?: string;
}> {
  const result = await run(["bun", "tsc", "--noEmit"]);
  return {
    success: result.exitCode === 0,
    output: result.exitCode !== 0 ? result.stdout || result.stderr : undefined,
  };
}

async function effectDiagnostics(): Promise<{
  success: boolean;
  output?: string;
}> {
  const result = await runEffectDiagnostics();

  const hasErrors = result.totalErrors > 0 || result.totalWarnings > 0;

  if (!hasErrors) {
    return {
      success: true,
      output: `${result.files} files`,
    };
  }

  return {
    success: false,
    output: formatEffectDiagnostics(result),
  };
}

async function format(): Promise<{
  success: boolean;
  output?: string;
}> {
  const result = await run(["bunx", "oxfmt"]);
  return {
    success: result.exitCode === 0,
    output: result.exitCode !== 0 ? result.stderr || result.stdout : undefined,
  };
}

async function formatCheck(): Promise<{
  success: boolean;
  output?: string;
}> {
  const result = await run(["bunx", "oxfmt", "--check"]);
  return {
    success: result.exitCode === 0,
    output: result.exitCode !== 0 ? result.stderr || result.stdout : undefined,
  };
}

async function test(): Promise<{
  success: boolean;
  output?: string;
}> {
  const result = await run(["bunx", "vitest", "run", "--reporter=dot", "--silent"]);

  if (result.exitCode === 0) {
    const match = result.stdout.match(/Tests\s+(\d+\s+passed)/);
    return {
      success: true,
      output: match ? match[1] : undefined,
    };
  }

  return {
    success: false,
    output: result.stderr || result.stdout,
  };
}

type Command = "all" | "lint" | "typecheck" | "format" | "test" | "effect" | "ci";

function parseArgs(): {
  command: Command;
} {
  const args = Bun.argv.slice(2);
  const command = (args.find((a: string) => !a.startsWith("-")) as Command) ?? "all";
  return { command };
}

async function runAll(): Promise<void> {
  // 1. Format first (may modify files)
  const formatResult = await runStep("format", format);
  printResult(formatResult);
  if (!formatResult.success) {
    process.exit(1);
  }

  // 2. Run lint, typecheck, effect, test in parallel
  const [lintResult, typecheckResult, effectResult, testResult] = await Promise.all([
    runStep("lint", lint),
    runStep("typecheck", typecheck),
    runStep("effect", effectDiagnostics),
    runStep("test", test),
  ]);

  if (testResult.success && testResult.output) {
    testResult.name = `test (${testResult.output})`;
    testResult.output = undefined;
  }

  if (effectResult.success && effectResult.output) {
    effectResult.name = `effect (${effectResult.output})`;
    effectResult.output = undefined;
  }

  printResult(lintResult);
  printResult(typecheckResult);
  printResult(effectResult);
  printResult(testResult);

  if (
    !lintResult.success ||
    !typecheckResult.success ||
    !effectResult.success ||
    !testResult.success
  ) {
    process.exit(1);
  }
}

async function runCi(): Promise<void> {
  // Run all checks in parallel (no format modification in CI)
  const [lintResult, typecheckResult, effectResult, formatResult, testResult] = await Promise.all([
    runStep("lint", lint),
    runStep("typecheck", typecheck),
    runStep("effect", effectDiagnostics),
    runStep("format", formatCheck),
    runStep("test", test),
  ]);

  if (testResult.success && testResult.output) {
    testResult.name = `test (${testResult.output})`;
    testResult.output = undefined;
  }

  if (effectResult.success && effectResult.output) {
    effectResult.name = `effect (${effectResult.output})`;
    effectResult.output = undefined;
  }

  printResult(lintResult);
  printResult(typecheckResult);
  printResult(effectResult);
  printResult(formatResult);
  printResult(testResult);

  if (
    !lintResult.success ||
    !typecheckResult.success ||
    !effectResult.success ||
    !formatResult.success ||
    !testResult.success
  ) {
    process.exit(1);
  }
}

async function runSingle(command: Command): Promise<void> {
  let result: StepResult;

  switch (command) {
    case "lint":
      result = await runStep("lint", lint);
      break;
    case "typecheck":
      result = await runStep("typecheck", typecheck);
      break;
    case "format":
      result = await runStep("format", format);
      break;
    case "test":
      result = await runStep("test", test);
      if (result.success && result.output) {
        result.name = `test (${result.output})`;
        result.output = undefined;
      }
      break;
    case "effect":
      result = await runStep("effect", effectDiagnostics);
      if (result.success && result.output) {
        result.name = `effect (${result.output})`;
        result.output = undefined;
      }
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log("Usage: bun check.ts [command]");
      console.log("Commands: all, lint, typecheck, effect, format, test, ci");
      process.exit(1);
  }

  printResult(result);

  if (!result.success) {
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { command } = parseArgs();

  switch (command) {
    case "all":
      await runAll();
      break;
    case "ci":
      await runCi();
      break;
    default:
      await runSingle(command);
  }
}

void main();
