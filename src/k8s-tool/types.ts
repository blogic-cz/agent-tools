export type Environment = "test" | "prod";

export type CommandResult = {
  success: boolean;
  output?: string;
  error?: string;
  command?: string;
  executionTimeMs: number;
  hint?: string;
  nextCommand?: string;
  retryable?: boolean;
  environment?: string;
};
