// TODO: bun lint ships only in canary builds; oven-sh/bun#46439 enables it in release builds. After the first stable Bun with bun lint: use ["bun", "lint", "--no-script"] and raise packageManager and bun-version in CI.
const lintCommand = ["bunx", "bun@1.4.4-canary.20261027.1", "lint", "--no-script"];

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
  const result = await run([...lintCommand, "-c", "./.oxlintrc.json", "--max-warnings", "0"]);
  return {
    success: result.exitCode === 0,
    output: result.exitCode !== 0 ? result.stderr || result.stdout : undefined,
  };
}

async function typecheck(): Promise<{
  success: boolean;
  output?: string;
}> {
  const result = await run(["bun", "effect-tsgo", "tsrs", "--noEmit", "-p", "tsconfig.json"]);
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
  const result = await run(["bun", "fmt", "--no-script"]);
  return {
    success: result.exitCode === 0,
    output: result.exitCode !== 0 ? result.stderr || result.stdout : undefined,
  };
}

async function formatCheck(): Promise<{
  success: boolean;
  output?: string;
}> {
  const result = await run(["bun", "fmt", "--no-script", "--check"]);
  return {
    success: result.exitCode === 0,
    output: result.exitCode !== 0 ? result.stderr || result.stdout : undefined,
  };
}

async function identifierScan(): Promise<{
  success: boolean;
  output?: string;
}> {
  const result = await run(["bun", "scripts/check-no-identifiers.ts"]);
  return {
    success: result.exitCode === 0,
    output: result.exitCode !== 0 ? result.stderr || result.stdout : undefined,
  };
}

async function test(): Promise<{
  success: boolean;
  output?: string;
}> {
  const result = await run([
    "bun",
    "--bun",
    "node_modules/vitest/vitest.mjs",
    "run",
    "--reporter=dot",
    "--silent",
  ]);

  if (result.exitCode === 0) {
    const counts = [...result.stdout.matchAll(/Tests\s+(\d+)\s+passed/g)];
    return {
      success: true,
      output: counts.length
        ? `${counts.reduce((sum, match) => sum + Number(match[1]), 0)} passed`
        : undefined,
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
  const [lintResult, typecheckResult, effectResult, testResult, identifierResult] =
    await Promise.all([
      runStep("lint", lint),
      runStep("typecheck", typecheck),
      runStep("effect", effectDiagnostics),
      runStep("test", test),
      runStep("identifier scan", identifierScan),
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
  printResult(identifierResult);

  if (
    !lintResult.success ||
    !typecheckResult.success ||
    !effectResult.success ||
    !testResult.success ||
    !identifierResult.success
  ) {
    process.exit(1);
  }
}

async function runCi(): Promise<void> {
  const [lintResult, typecheckResult, effectResult, formatResult, identifierResult, testResult] =
    await Promise.all([
      runStep("lint", lint),
      runStep("typecheck", typecheck),
      runStep("effect", effectDiagnostics),
      runStep("format", formatCheck),
      runStep("identifier scan", identifierScan),
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
  printResult(identifierResult);
  printResult(testResult);

  if (
    !lintResult.success ||
    !typecheckResult.success ||
    !effectResult.success ||
    !formatResult.success ||
    !testResult.success ||
    !identifierResult.success
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
  if (Bun.argv[2] === "lint-files") {
    const result = await run([...lintCommand, ...Bun.argv.slice(3)]);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }
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
