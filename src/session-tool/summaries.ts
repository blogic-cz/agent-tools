import type { MessageSummary, SessionSummary } from "./types";

/**
 * Shapes a message body for output. A body silently cut to 500 chars was
 * indistinguishable from a short one, so callers read "no match in this snippet" as
 * "not in this session". When the body is cut, say so and report its real length.
 *
 * maxBodyChars <= 0 returns the full body.
 */
export const shapeBody = (
  body: string,
  maxBodyChars: number,
): { body: string; bodyLength?: number; truncated?: true } => {
  if (maxBodyChars <= 0 || body.length <= maxBodyChars) {
    return { body };
  }

  const kept = body.slice(0, Math.max(0, maxBodyChars - 3));
  return { body: `${kept}...`, bodyLength: body.length, truncated: true };
};

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
