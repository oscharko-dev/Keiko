// Read memo for the Jira reads one draft invocation repeats (Jira metadata that every staged item
// shares: create metadata, project and issue-type reads, template catalogs).
//
// A staged page passes the same checks a create passes, item after item, and each check reads Jira's
// metadata through the connection. Fifteen items of one project and type read the same few
// resources fifteen times, and a batch repeats that for every page. The memo answers an identical
// GET from the invocation's own earlier answer. It is scoped to ONE invocation (the context object
// the batch and its pages share), holds only complete 200 answers, expires after a short time, and
// never answers a write. The create step that follows an approval reads Jira afresh through its own
// connection and is not served from here.

import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";

/** Long enough to span the pages of one batch, short enough that a change in Jira is seen soon. */
export const JIRA_DRAFT_READ_MEMO_TTL_MS = 120_000;
/** Bounds the memory one invocation can hold. */
const MEMO_ENTRIES_MAX = 256;

interface MemoEntry {
  readonly at: number;
  readonly result: Extract<AtlassianHttpBodyResult, { kind: "response" }>;
}

// One memo per invocation AND per transport: a different connection never reads another's answers.
const memos = new WeakMap<object, WeakMap<object, Map<string, MemoEntry>>>();

function memoFor(
  context: ManagedMcpInvocationContext,
  http: AtlassianHttpBodyPort,
): Map<string, MemoEntry> {
  let byTransport = memos.get(context);
  if (byTransport === undefined) {
    byTransport = new WeakMap();
    memos.set(context, byTransport);
  }
  let memo = byTransport.get(http);
  if (memo === undefined) {
    memo = new Map();
    byTransport.set(http, memo);
  }
  return memo;
}

function memoizable(
  result: AtlassianHttpBodyResult,
): result is Extract<AtlassianHttpBodyResult, { kind: "response" }> {
  return result.kind === "response" && result.status === 200 && !result.truncated;
}

/** The connection with its GET reads answered from this invocation's memo while still current. */
export function withJiraDraftReadMemo(
  connection: JiraManagedConnection,
  context: ManagedMcpInvocationContext,
  now: () => number = Date.now,
): JiraManagedConnection {
  const memo = memoFor(context, connection.http);
  const http: AtlassianHttpBodyPort = async (request) => {
    if (request.method !== "GET") return connection.http(request);
    const key = `${request.url}\u0000${String(request.maxBodyBytes)}`;
    const hit = memo.get(key);
    if (hit !== undefined && now() - hit.at < JIRA_DRAFT_READ_MEMO_TTL_MS) return hit.result;
    const result = await connection.http(request);
    if (memoizable(result) && (memo.size < MEMO_ENTRIES_MAX || memo.has(key)))
      memo.set(key, { at: now(), result });
    return result;
  };
  return { ...connection, http };
}
