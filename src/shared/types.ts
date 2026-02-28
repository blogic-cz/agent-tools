export type OutputFormat = "json" | "toon";
export type Environment = "local" | "test" | "prod";

export type BaseResult = {
  success: boolean;
  error?: string;
  executionTimeMs: number;
};

export type CommandOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  killSignal?: NodeJS.Signals;
};

export type CommandResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  signalCode: NodeJS.Signals | null;
  timedOut: boolean;
  executionTimeMs: number;
};
