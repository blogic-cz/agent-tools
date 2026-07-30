import type { MessageSummary, SessionSummary } from "./types";

export const sessionSummariesFromMessages = (summaries: MessageSummary[]): SessionSummary[] => {
  const bySession = new Map<string, SessionSummary>();

  for (const summary of summaries) {
    const key = `${summary.source}:${summary.sessionID}`;
    const previous = bySession.get(key);
    if (previous === undefined) {
      bySession.set(key, {
        sessionID: summary.sessionID,
        title: summary.title,
        createdAt: summary.created,
        updatedAt: summary.created,
        source: summary.source,
      });
      continue;
    }
    previous.createdAt = Math.min(previous.createdAt, summary.created);
    if (summary.created > previous.updatedAt) {
      previous.updatedAt = summary.created;
      previous.title = summary.title;
    }
  }

  return [...bySession.values()];
};

export const projectSessionFilter = (
  sessionsBySource: ReadonlyMap<SessionSummary["source"], Set<string>>,
  source: SessionSummary["source"],
  allProjects: boolean,
): Set<string> | null => (allProjects ? null : (sessionsBySource.get(source) ?? new Set()));

export const sortSessionSummaries = (summaries: SessionSummary[]): SessionSummary[] =>
  summaries.toSorted(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      left.source.localeCompare(right.source) ||
      left.sessionID.localeCompare(right.sessionID),
  );
