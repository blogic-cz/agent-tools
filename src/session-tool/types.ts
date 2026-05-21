import type { OutputFormat } from "#shared";

export type { OutputFormat };

export type SessionInfo = {
  id: string;
  directory: string;
  projectID: string;
};

export type SessionSource = "opencode" | "claude-code" | "codex";

export type MessageSummary = {
  sessionID: string;
  id: string;
  title: string;
  body: string;
  created: number;
  role: string;
  source: SessionSource;
};

export type SessionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  query?: string | null;
  scope?: string;
  count?: number;
  executionTimeMs: number;
};
