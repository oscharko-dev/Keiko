import { randomUUID } from "node:crypto";
import {
  JIRA_REPORT_IDLE_TTL_MS,
  JIRA_REPORT_STORE_MAX_BYTES,
  JIRA_REPORT_OWNER_SESSIONS_MAX,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  createJiraReportSession,
  type JiraReportRequest,
  type JiraReportSession,
} from "./jira-report-session.js";
import { trimOwnedBytes } from "./jira-store-bounds.js";

/**
 * Report sessions live in memory. Tool calls continue an in-progress session and can export
 * a finished session. Idle sessions expire. Limits trim each owner's oldest sessions first,
 * and the shared byte budget trims the owner holding the most.
 * Separately, the server retains bounded, owner-bound finished downloads in
 * `jira_report_exports` so the Chat card can download them after restart.
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
  /** The owner's finished reports, newest first, without renewing their expiry. */
  readonly finished: (owner: string) => readonly JiraReportSession[];
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

export { JIRA_REPORT_IDLE_TTL_MS, JIRA_REPORT_STORE_MAX_BYTES, JIRA_REPORT_OWNER_SESSIONS_MAX };

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
  const finished = (owner: string): readonly JiraReportSession[] => {
    sweep();
    return [...sessions.values()]
      .filter(
        (session) =>
          session.owner === owner && session.phase === "finished" && session.report !== undefined,
      )
      .sort((left, right) => right.startedAt - left.startedAt);
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
    finished,
    settle: sweep,
    size: () => sessions.size,
  };
}
