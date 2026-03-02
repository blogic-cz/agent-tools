import type { Environment, OutputFormat } from "../shared";
export type { Environment, OutputFormat };

export type LogFile = {
  name: string;
  size: string;
  date: string;
};

export type ReadOptions = {
  tail: number;
  grep?: string;
  file?: string;
  pretty: boolean;
};

export type LogResult = {
  success: boolean;
  data?: string | string[] | Record<string, unknown>[];
  error?: string;
  source?: string;
  executionTimeMs: number;
  hint?: string;
  nextCommand?: string;
  retryable?: boolean;
};

export type ParsedArgs =
  | { mode: "help" }
  | {
      mode: "list";
      env: Environment;
      format: OutputFormat;
    }
  | {
      mode: "read";
      env: Environment;
      tail: number;
      grep?: string;
      file?: string;
      pretty: boolean;
      format: OutputFormat;
    };
