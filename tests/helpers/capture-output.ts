import { vi } from "vitest";

export const captureOutput = async <A>(
  program: () => A | Promise<A>,
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    encoding?: string;
    timeout?: number;
  } = {},
) => {
  let stdout = "";
  let stderr = "";
  const environment = process.env;
  const argv = process.argv;
  const cwd = process.cwd();
  const fetch = globalThis.fetch;
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk, ...args: unknown[]) => {
      stdout += String(chunk);
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") callback();
      return true;
    });
  const error = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk, ...args: unknown[]) => {
      stderr += String(chunk);
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") callback();
      return true;
    });
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    stdout += values.join(" ") + "\n";
  });
  const warn = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    stderr += values.join(" ") + "\n";
  });
  try {
    if (options.env) process.env = { ...options.env };
    if (options.cwd) process.chdir(options.cwd);
    const value = await program();
    return { status: 0, stdout, stderr, error: undefined, value };
  } finally {
    process.env = environment;
    process.argv = argv;
    if (process.cwd() !== cwd) process.chdir(cwd);
    globalThis.fetch = fetch;
    output.mockRestore();
    error.mockRestore();
    log.mockRestore();
    warn.mockRestore();
  }
};
