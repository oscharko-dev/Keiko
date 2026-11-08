import { maintenancePathNode } from "@oscharko-dev/keiko-connectors";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyRequest,
  AtlassianHttpRequest,
  AtlassianHttpResult,
} from "@oscharko-dev/keiko-connectors";

type Request = AtlassianHttpRequest | AtlassianHttpBodyRequest;

// Retained Jira 11.3 API: these GETs document 401 for missing WebSudo or view permission
// as well as authentication. The exact tab writes and native issue-link operations below also
// document permission401. Other resources/methods remain definitive; no write is retried.
const AMBIGUOUS_PATHS: readonly (readonly string[])[] = [
  ["issueLink", "id"],
  ["index-snapshot"],
  ["user", "columns"],
  ["cluster", "nodes"],
  ["cluster", "zdu", "state"],
  ["index-snapshot", "isRunning"],
  ["workflow"],
  ["screens"],
  ["workflowscheme", "id"],
  ["workflowscheme", "id", "default"],
  ["workflowscheme", "id", "draft"],
  ["workflowscheme", "id", "draft", "default"],
  ["workflowscheme", "id", "issuetype", "id"],
  ["workflowscheme", "id", "draft", "issuetype", "id"],
  ["workflowscheme", "id", "workflow"],
  ["workflowscheme", "id", "draft", "workflow"],
  ["screens", "id", "tabs"],
  ["screens", "id", "tabs", "id", "fields"],
  ["screens", "id", "availableFields"],
];
// Retained 11.3 POST /screens/{screenId}/tabs and PUT/DELETE /screens/{screenId}/tabs/{tabId}.
// The same existing identity probe preserves the original synchronous status and absolute deadline.
function ambiguousTabWrite(method: Request["method"], parts: readonly string[]): boolean {
  if (parts[0] !== "screens" || parts[2] !== "tabs" || !/^[1-9]\d{0,18}$/u.test(parts[1] ?? ""))
    return false;
  if (method === "POST") return parts.length === 3;
  return (
    (method === "PUT" || method === "DELETE") &&
    parts.length === 4 &&
    /^[1-9]\d{0,18}$/u.test(parts[3] ?? "")
  );
}

// Retained 11.3 explicitly uses 401 for missing Link Issues permission on these two identities.
// Remote links have a different authentication contract and do not join this observation.
function ambiguousIssueLinkWrite(method: Request["method"], parts: readonly string[]): boolean {
  if (parts[0] !== "issueLink") return false;
  if (method === "POST") return parts.length === 1;
  return method === "DELETE" && parts.length === 2 && /^[1-9]\d{0,18}$/u.test(parts[1] ?? "");
}

// Pinned 11.3 documents permission/WebSudo401 for these exact implemented mutations.
// A current same-generation positive identity probe preserves the refusal without revoking a
// valid credential; it never grants permission, retries a write or borrows another route's facts.
const AMBIGUOUS_NATIVE_WRITES: readonly (readonly [Request["method"], readonly string[]])[] = [
  ["PUT", ["applicationrole"]],
  ["PUT", ["applicationrole", "$segment"]],
  ["DELETE", ["user", "columns"]],
  ["PUT", ["cluster", "index-snapshot", "$node"]],
  ["DELETE", ["cluster", "node", "$node"]],
  ["PUT", ["cluster", "node", "$node", "offline"]],
  ["POST", ["cluster", "zdu", "approve"]],
  ["POST", ["cluster", "zdu", "cancel"]],
  ["POST", ["cluster", "zdu", "retryUpgrade"]],
  ["POST", ["cluster", "zdu", "start"]],
  ["POST", ["index-snapshot"]],
  ["POST", ["reindex", "request"]],
  ["POST", ["workflowscheme"]],
  ["PUT", ["workflowscheme", "$id"]],
  ["DELETE", ["workflowscheme", "$id"]],
  ["POST", ["workflowscheme", "$id", "createdraft"]],
  ["PUT", ["workflowscheme", "$id", "draft"]],
  ["DELETE", ["workflowscheme", "$id", "draft"]],
  ["PUT", ["workflowscheme", "$id", "default"]],
  ["DELETE", ["workflowscheme", "$id", "default"]],
  ["PUT", ["workflowscheme", "$id", "draft", "default"]],
  ["DELETE", ["workflowscheme", "$id", "draft", "default"]],
  ["PUT", ["workflowscheme", "$id", "issuetype", "$id"]],
  ["DELETE", ["workflowscheme", "$id", "issuetype", "$id"]],
  ["PUT", ["workflowscheme", "$id", "draft", "issuetype", "$id"]],
  ["DELETE", ["workflowscheme", "$id", "draft", "issuetype", "$id"]],
  ["PUT", ["workflowscheme", "$id", "workflow"]],
  ["DELETE", ["workflowscheme", "$id", "workflow"]],
  ["PUT", ["workflowscheme", "$id", "draft", "workflow"]],
  ["DELETE", ["workflowscheme", "$id", "draft", "workflow"]],
  ["PUT", ["issue", "$segment", "assignee"]],
  ["POST", ["issue", "$segment", "watchers"]],
  ["DELETE", ["issue", "$segment", "watchers"]],
  ["POST", ["screens", "addToDefault", "$segment"]],
  ["POST", ["screens", "$id", "tabs", "$id", "fields"]],
  ["DELETE", ["screens", "$id", "tabs", "$id", "fields", "$segment"]],
  ["POST", ["screens", "$id", "tabs", "$id", "fields", "$segment", "move"]],
  ["PUT", ["screens", "$id", "tabs", "$id", "fields", "$segment", "updateShowWhenEmptyIndicator", "$boolean"]],
  ["POST", ["screens", "$id", "tabs", "$id", "move", "$position"]],
];
function nativeTextSegment(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim().length > 0 && decoded.length <= 255 && decoded === decoded.trim() && decoded !== "." && decoded !== ".." &&
      !/[\\/%?#\p{Cc}\p{Surrogate}]/u.test(decoded);
  } catch { return false; }
}
function nativeNodeSegment(value: string): boolean {
  try { return maintenancePathNode(decodeURIComponent(value)); } catch { return false; }
}
function nativeWriteSegment(expected: string, actual: string): boolean {
  switch (expected) {
    case "$node": return nativeNodeSegment(actual);
    case "$id": return /^[1-9]\d{0,18}$/u.test(actual) && BigInt(actual) <= 9223372036854775807n;
    case "$segment": return nativeTextSegment(actual);
    case "$boolean": return actual === "true" || actual === "false";
    case "$position": return /^(?:0|[1-9]\d{0,9})$/u.test(actual) && Number(actual) <= 2147483647;
    default: return expected === actual;
  }
}
function ambiguousNativeWrite(method: Request["method"], parts: readonly string[]): boolean {
  return AMBIGUOUS_NATIVE_WRITES.some(([candidate, path]) => candidate === method && path.length === parts.length &&
    path.every((part, index) => nativeWriteSegment(part, parts[index] ?? "")));
}

export function ambiguousJiraAuthenticationResponse(
  metadata: AtlassianCredentialMetadata,
  request: Request,
): boolean {
  if (
    metadata.provider !== "jira" ||
    metadata.deployment !== "data-center" ||
    metadata.livePod === undefined
  )
    return false;
  const base = new URL(metadata.baseUrl);
  const target = new URL(request.url);
  const prefix = `${base.pathname.replace(/\/$/, "")}/rest/api/2/`;
  if (target.origin !== base.origin || !target.pathname.startsWith(prefix)) return false;
  const parts = target.pathname.slice(prefix.length).split("/");
  if (request.method !== "GET")
    return ambiguousTabWrite(request.method, parts) || ambiguousIssueLinkWrite(request.method, parts) || ambiguousNativeWrite(request.method, parts);
  return AMBIGUOUS_PATHS.some(
    (path) =>
      path.length === parts.length &&
      path.every((part, index) =>
        part === "id" ? /^[1-9]\d{0,18}$/u.test(parts[index] ?? "") : part === parts[index],
      ),
  );
}

export function currentJiraAuthenticationObservation(
  metadata: AtlassianCredentialMetadata,
  current: AtlassianCredentialMetadata | undefined,
): boolean {
  if (metadata.deployment !== "data-center" || current?.deployment !== "data-center") return false;
  const state = current.livePod;
  if (metadata.livePod === undefined || state === undefined) return false;
  return (
    current.generation === metadata.generation &&
    state.verificationRevision === metadata.livePod.verificationRevision &&
    state.verificationStatus === "ok" &&
    !state.verificationInProgress &&
    state.credentialOperation === undefined
  );
}

function ambiguousFailure(
  metadata: AtlassianCredentialMetadata,
  request: Request,
  result: AtlassianHttpResult,
): boolean {
  return (
    result.kind === "response" &&
    result.status === 401 &&
    ambiguousJiraAuthenticationResponse(metadata, request)
  );
}
function withinOriginalRequest(deadline: number, signal: AbortSignal | undefined): boolean {
  return !signal?.aborted && Date.now() < deadline;
}

/** Original response observation stays synchronous; only the subsequent identity GET is awaited. */
export function withJiraAuthenticationObservation<
  TRequest extends Request,
  TResult extends AtlassianHttpResult,
>(
  metadata: AtlassianCredentialMetadata,
  port: (request: TRequest) => Promise<TResult>,
  current: () => boolean,
  probe: (deadlineAt: number, signal: AbortSignal | undefined) => Promise<boolean>,
): (request: TRequest) => Promise<TResult> {
  return async (input): Promise<TResult> => {
    const request: TRequest = { ...input };
    Object.freeze(request);
    const deadline = Date.now() + Math.min(request.timeoutMs, 60_000);
    const result = await port(request);
    if (!ambiguousFailure(metadata, request, result) || !current()) return result;
    const signal = "signal" in request ? request.signal : undefined;
    if (!withinOriginalRequest(deadline, signal)) return result;
    const confirmed = await probe(deadline, signal);
    if (confirmed && current() && withinOriginalRequest(deadline, signal))
      return { ...result, authentication: "confirmed" };
    return result;
  };
}
