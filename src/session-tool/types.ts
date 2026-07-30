import { Schema } from "effect";

import type { OutputFormat } from "#shared";

export type { OutputFormat };

export type SessionInfo = {
  id: string;
  directory: string;
  projectID: string;
};

export const SESSION_SOURCES = ["opencode", "claude-code", "codex", "pi"] as const;
export const SessionSourceLiterals = Schema.Literals(SESSION_SOURCES);
export type SessionSource = (typeof SESSION_SOURCES)[number];
export const ALL_SESSION_SOURCES: ReadonlySet<SessionSource> = new Set(SESSION_SOURCES);

export type MessageSummary = {
  sessionID: string;
  id: string;
  title: string;
  body: string;
  created: number;
  role: string;
  source: SessionSource;
};

export type SessionSummary = {
  sessionID: string;
  title: string;
  createdAt: number;
  updatedAt: number;
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
