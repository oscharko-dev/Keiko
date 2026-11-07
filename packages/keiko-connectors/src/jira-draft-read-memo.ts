// Read memo for the Jira reads one draft invocation repeats (Jira metadata that every staged item
// shares: create metadata, project and issue-type reads, template catalogs).
//
// A staged page passes the same checks a create passes, item after item, and each check reads Jira's
// metadata through the connection. Fifteen items of one project and type read the same few
// resources fifteen times, and a batch repeats that for every page. The memo answers an identical
// GET from the invocation's own earlier answer. It is scoped to ONE invocation (the context object
// the batch and its pages share) and one transport, holds only complete 200 answers, expires after a
// short time, is bounded by entry count and by total bytes, and never answers a write.
//
// The create run of an approved batch shares a narrower view of the same memo
// (`withJiraCreateMetadataMemo`): only the metadata every item of one project and type reads
// identically (`issue/createmeta/...`, `project/...`, `issuetype/...`, `field`) is served once per
// invocation. Everything else stays live per item, because it carries the safety of the create: the
// duplicate-detection search (`search?jql=...`) and the read-back of the created issue
// (`issue/{key}`) are never answered from here, and no write is. A permission or field change in
// the middle of a batch therefore surfaces as a Jira rejection of the POST, not as a silent bad
// write; the short expiry bounds how long a stale metadata answer can be reused at all.

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

function memoFor(context: ManagedMcpInvocationContext, scope: object): Memo {
  let byTransport = memos.get(context);
  if (byTransport === undefined) {
    byTransport = new WeakMap();
    memos.set(context, byTransport);
  }
  let memo = byTransport.get(scope);
  if (memo === undefined) {
    memo = { entries: new Map(), bytes: 0 };
    byTransport.set(scope, memo);
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

function memoizedHttp(
  http: AtlassianHttpBodyPort,
  memo: Memo,
  counts: JiraDraftReadCounts,
  now: () => number,
  admits: (url: string) => boolean,
): AtlassianHttpBodyPort {
  return async (request) => {
    if (request.method !== "GET") return http(request);
    if (!admits(request.url)) {
      counts.made += 1;
      return http(request);
    }
    const key = `${request.url}\u0000${String(request.maxBodyBytes)}`;
    const hit = memo.entries.get(key);
    if (hit !== undefined && now() - hit.at < JIRA_DRAFT_READ_MEMO_TTL_MS) {
      counts.reused += 1;
      return hit.result;
    }
    counts.made += 1;
    const result = await http(request);
    if (memoizable(result)) remember(memo, key, result, now());
    return result;
  };
}

/** The connection with its GET reads answered from this invocation's memo while still current. */
export function withJiraDraftReadMemo(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  counts: JiraDraftReadCounts,
  now: () => number = Date.now,
): JiraManagedConnection {
  const memo = memoFor(context, connection.http);
  return { ...connection, http: memoizedHttp(connection.http, memo, counts, now, () => true) };
}

const CREATE_METADATA_PATH =
  /\/rest\/api\/2\/(?:issue\/createmeta\/|project\/|issuetype\/|field(?:\?|$))/u;

/** Only the metadata identical for every item of one project and issue type. */
function isCreateMetadataUrl(url: string): boolean {
  return CREATE_METADATA_PATH.test(url);
}

/**
 * The create path's connection with its metadata reads (create metadata, project, issue type, field
 * list) answered once per invocation. `scope` names the transport the items share (each item gets
 * its own lifecycle-wrapped port, so the port itself cannot): a different scope or invocation
 * starts empty. Searches, read-backs and every write stay live and are counted as reads made.
 */
export function withJiraCreateMetadataMemo(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  scope: object,
  counts: JiraDraftReadCounts,
  now: () => number = Date.now,
): JiraManagedConnection {
  const memo = memoFor(context, scope);
  const http = memoizedHttp(connection.http, memo, counts, now, isCreateMetadataUrl);
  return { ...connection, http };
}
