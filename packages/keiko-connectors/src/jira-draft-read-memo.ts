// Read memo for the Jira reads one draft invocation repeats (Jira metadata that every staged item
// shares: create metadata, project and issue-type reads, template catalogs).
//
// A staged page passes the same checks a create passes, item after item, and each check reads Jira's
// metadata through the connection. Fifteen items of one project and type read the same few
// resources fifteen times, and a batch repeats that for every page. The memo answers an identical
// GET from the invocation's own earlier answer. It is scoped to ONE invocation (the context object
// the batch and its pages share) and one transport, holds only complete 200 answers, expires after a
// short time, is bounded by entry count and by total bytes, and never answers a write. The create
// step that follows an approval reads Jira afresh through its own connection and is not served from
// here.

import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";

/** Long enough to span the pages of one batch, short enough that a change in Jira is seen soon. */
export const JIRA_DRAFT_READ_MEMO_TTL_MS = 120_000;
/** Bounds the memory one invocation can hold: by entries and by the bytes of the answers. */
export const JIRA_DRAFT_READ_MEMO_ENTRIES_MAX = 256;
export const JIRA_DRAFT_READ_MEMO_BYTES_MAX = 4 * 1024 * 1024;

type MemoResult = Extract<AtlassianHttpBodyResult, { kind: "response" }>;

interface MemoEntry {
  readonly at: number;
  readonly result: MemoResult;
  readonly bytes: number;
}

interface Memo {
  readonly entries: Map<string, MemoEntry>;
  bytes: number;
}

/** What one staging call did: reads sent to Jira, and reads answered from the memo. */
export interface JiraDraftReadCounts {
  made: number;
  reused: number;
}

// One memo per invocation AND per transport: a different connection never reads another's answers.
const memos = new WeakMap<object, WeakMap<object, Memo>>();

function memoFor(context: ManagedMcpInvocationContext, http: AtlassianHttpBodyPort): Memo {
  let byTransport = memos.get(context);
  if (byTransport === undefined) {
    byTransport = new WeakMap();
    memos.set(context, byTransport);
  }
  let memo = byTransport.get(http);
  if (memo === undefined) {
    memo = { entries: new Map(), bytes: 0 };
    byTransport.set(http, memo);
  }
  return memo;
}

function memoizable(result: AtlassianHttpBodyResult): result is MemoResult {
  return result.kind === "response" && result.status === 200 && !result.truncated;
}

function drop(memo: Memo, key: string): void {
  const entry = memo.entries.get(key);
  if (entry === undefined) return;
  memo.bytes -= entry.bytes;
  memo.entries.delete(key);
}

function evictExpired(memo: Memo, now: number): void {
  for (const [key, entry] of memo.entries) {
    if (now - entry.at >= JIRA_DRAFT_READ_MEMO_TTL_MS) drop(memo, key);
  }
}

/** Makes room for one more entry by dropping the expired ones, then the oldest. */
function remember(memo: Memo, key: string, result: MemoResult, now: number): void {
  const bytes = Math.max(result.bodyBytes, result.bodyText.length);
  if (bytes > JIRA_DRAFT_READ_MEMO_BYTES_MAX) return;
  drop(memo, key);
  evictExpired(memo, now);
  while (
    memo.entries.size >= JIRA_DRAFT_READ_MEMO_ENTRIES_MAX ||
    memo.bytes + bytes > JIRA_DRAFT_READ_MEMO_BYTES_MAX
  ) {
    const oldest = memo.entries.keys().next();
    if (oldest.done === true) break;
    drop(memo, oldest.value);
  }
  memo.entries.set(key, { at: now, result, bytes });
  memo.bytes += bytes;
}

/** The connection with its GET reads answered from this invocation's memo while still current. */
export function withJiraDraftReadMemo(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  counts: JiraDraftReadCounts,
  now: () => number = Date.now,
): JiraManagedConnection {
  const memo = memoFor(context, connection.http);
  const http: AtlassianHttpBodyPort = async (request) => {
    if (request.method !== "GET") return connection.http(request);
    const key = `${request.url}\u0000${String(request.maxBodyBytes)}`;
    const hit = memo.entries.get(key);
    if (hit !== undefined && now() - hit.at < JIRA_DRAFT_READ_MEMO_TTL_MS) {
      counts.reused += 1;
      return hit.result;
    }
    counts.made += 1;
    const result = await connection.http(request);
    if (memoizable(result)) remember(memo, key, result, now());
    return result;
  };
  return { ...connection, http };
}
