import { randomUUID } from "node:crypto";
import {
  createJiraReportSession,
  type JiraReportRequest,
  type JiraReportSession,
} from "./jira-report-session.js";

/**
 * Reports live in memory only: a report in progress resumes in the next tool call, and a finished
 * report is what the export reads. Idle reports expire and the least recently used finished
 * reports are dropped first when the retained size would exceed the budget; nothing is persisted.
 */
export interface JiraReportStore {
  readonly start: (owner: string, request: JiraReportRequest) => JiraReportSession;
  /** The report only for the owner that started it; anything else is indistinguishable from absent. */
  readonly get: (id: string, owner: string) => JiraReportSession | undefined;
  /** Account for a session whose size changed and drop what no longer fits. */
  readonly settle: () => void;
  readonly size: () => number;
}

export interface JiraReportStoreOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly idleTtlMs?: number;
  readonly maxTotalBytes?: number;
}

export const JIRA_REPORT_IDLE_TTL_MS = 4 * 60 * 60 * 1000;
/** Retained size of all reports together; a safety bound on memory, never a limit on a scope. */
export const JIRA_REPORT_STORE_MAX_BYTES = 1024 * 1024 * 1024;

export function createJiraReportStore(options: JiraReportStoreOptions = {}): JiraReportStore {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const idleTtlMs = options.idleTtlMs ?? JIRA_REPORT_IDLE_TTL_MS;
  const maxTotalBytes = options.maxTotalBytes ?? JIRA_REPORT_STORE_MAX_BYTES;
  const sessions = new Map<string, JiraReportSession>();
  const sweep = (): void => {
    const cutoff = now() - idleTtlMs;
    for (const [id, session] of sessions)
      if (!session.busy && session.lastUsedAt < cutoff) sessions.delete(id);
    let total = [...sessions.values()].reduce((sum, session) => sum + session.bytes, 0);
    const oldest = [...sessions.values()]
      .filter((session) => !session.busy)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const session of oldest) {
      if (total <= maxTotalBytes) break;
      sessions.delete(session.id);
      total -= session.bytes;
    }
  };
  return {
    start: (owner, request): JiraReportSession => {
      sweep();
      const session = createJiraReportSession({ id: newId(), owner, request, now: now() });
      sessions.set(session.id, session);
      return session;
    },
    get: (id, owner): JiraReportSession | undefined => {
      sweep();
      const session = sessions.get(id);
      if (session?.owner !== owner) return undefined;
      session.lastUsedAt = now();
      return session;
    },
    settle: sweep,
    size: () => sessions.size,
  };
}
