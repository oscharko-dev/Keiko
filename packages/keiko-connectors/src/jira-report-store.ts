import { randomUUID } from "node:crypto";
import {
  createJiraReportSession,
  type JiraReportRequest,
  type JiraReportSession,
} from "./jira-report-session.js";
import { trimOwnedBytes } from "./jira-store-bounds.js";

/**
 * Reports live in memory only: a report in progress resumes in the next tool call, and a finished
 * report is what the export reads. Idle reports expire, one owner holds a bounded number of
 * reports (its oldest go first), and beyond the shared byte budget the owner holding the most is
 * trimmed first, so one Chat can never push another Chat's reports out. Nothing is persisted.
 */
export interface JiraReportStore {
  readonly start: (
    owner: string,
    request: JiraReportRequest,
    fingerprint?: string,
  ) => JiraReportSession;
  /** The report only for the owner that started it; anything else is indistinguishable from absent. */
  readonly get: (id: string, owner: string) => JiraReportSession | undefined;
  /** The same lookup without renewing the expiry: an export is not use of the report. */
  readonly peek: (id: string, owner: string) => JiraReportSession | undefined;
  /** Account for a session whose size changed and drop what no longer fits. */
  readonly settle: () => void;
  readonly size: () => number;
}

export interface JiraReportStoreOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly idleTtlMs?: number;
  readonly maxTotalBytes?: number;
  readonly maxSessionsPerOwner?: number;
}

export const JIRA_REPORT_IDLE_TTL_MS = 4 * 60 * 60 * 1000;
/** Retained size of all reports together; a safety bound on memory, never a limit on a scope. */
export const JIRA_REPORT_STORE_MAX_BYTES = 768 * 1024 * 1024;
export const JIRA_REPORT_OWNER_SESSIONS_MAX = 4;

type Sessions = Map<string, JiraReportSession>;

/** Sessions not being read, oldest use first; `owner` narrows them to one owner's. */
function evictable(sessions: Sessions, owner?: string): JiraReportSession[] {
  return [...sessions.values()]
    .filter((session) => !session.busy && (owner === undefined || session.owner === owner))
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
}
function trimOwner(sessions: Sessions, owner: string, limit: number): void {
  let held = [...sessions.values()].filter((session) => session.owner === owner).length;
  for (const session of evictable(sessions, owner)) {
    if (held <= limit) return;
    sessions.delete(session.id);
    held -= 1;
  }
}
function trimBytes(sessions: Sessions, limit: number): void {
  trimOwnedBytes(sessions, limit, (owner) => evictable(sessions, owner)[0]);
}

export function createJiraReportStore(options: JiraReportStoreOptions = {}): JiraReportStore {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const idleTtlMs = options.idleTtlMs ?? JIRA_REPORT_IDLE_TTL_MS;
  const maxTotalBytes = options.maxTotalBytes ?? JIRA_REPORT_STORE_MAX_BYTES;
  const perOwner = options.maxSessionsPerOwner ?? JIRA_REPORT_OWNER_SESSIONS_MAX;
  const sessions: Sessions = new Map();
  const sweep = (): void => {
    const cutoff = now() - idleTtlMs;
    for (const [id, session] of sessions)
      if (!session.busy && session.lastUsedAt < cutoff) sessions.delete(id);
    trimBytes(sessions, maxTotalBytes);
  };
  const peek = (id: string, owner: string): JiraReportSession | undefined => {
    sweep();
    const session = sessions.get(id);
    return session?.owner === owner ? session : undefined;
  };
  return {
    start: (owner, request, fingerprint = ""): JiraReportSession => {
      sweep();
      const request_ = { id: newId(), owner, fingerprint, request, now: now() };
      const session = createJiraReportSession(request_);
      sessions.set(session.id, session);
      trimOwner(sessions, owner, perOwner);
      return session;
    },
    get: (id, owner): JiraReportSession | undefined => {
      const session = peek(id, owner);
      if (session !== undefined) session.lastUsedAt = now();
      return session;
    },
    peek,
    settle: sweep,
    size: () => sessions.size,
  };
}
