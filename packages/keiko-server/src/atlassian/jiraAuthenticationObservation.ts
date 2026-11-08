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
    return ambiguousTabWrite(request.method, parts) || ambiguousIssueLinkWrite(request.method, parts);
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
