import type { CommandOptions, CommandResult } from "./types";

export function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home || home.trim() === "") {
      throw new Error("HOME environment variable not set");
    }
    return path.replace("~", home);
  }
  return path;
}

export async function runCommand(
  cmd: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const startTime = Date.now();
  const { cwd, env, timeout = 30000, killSignal = "SIGTERM" } = options;

  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: env
      ? {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TERM: process.env.TERM,
          ...env,
        }
      : undefined,
    timeout,
    killSignal,
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  const timedOut = proc.signalCode === killSignal && exitCode !== 0;

  return {
    success: exitCode === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
    signalCode: proc.signalCode,
    timedOut,
    executionTimeMs: Date.now() - startTime,
  };
}

export function runShellCommand(
  command: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  return runCommand(["sh", "-c", command], options);
}
