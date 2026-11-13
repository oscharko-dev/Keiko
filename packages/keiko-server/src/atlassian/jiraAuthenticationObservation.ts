import { decodeCanonicalUriSegment } from "./canonicalUriSegment.js";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyRequest,
  AtlassianHttpRequest,
  AtlassianHttpResult,
} from "@oscharko-dev/keiko-connectors";

type Request = AtlassianHttpRequest | AtlassianHttpBodyRequest;

// Structural rule (ADR-0128): Jira Data Center answers 401 for a missing WebSudo or administrator
// permission as well as for a failed authentication, and the model reaches about 450 operations
// through discovery, so no hand-maintained route list can be complete. Every 401 from the
// instance except the identity route itself is therefore decided by the existing same-generation
// identity probe: only a probe that itself answers 401 discards the credential. The identity route
// is the one place where no further evidence can exist, so its 401 stays definitive. A positive
// probe never grants a permission, retries a write or borrows another route's facts.
const IDENTITY_SEGMENTS: readonly string[] = ["rest", "api", "2", "myself"];

// An encoded separator can never name a Jira resource; such a request is refused before dispatch.
function canonicalSegment(part: string): boolean {
  if (part.length === 0) return true;
  const decoded = decodeCanonicalUriSegment(part);
  return decoded !== undefined && !/[\\/]/u.test(decoded);
}

function canonicalPathSegments(pathname: string, basePath: string): readonly string[] | undefined {
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return undefined;
  const parts = pathname.slice(basePath.length).split("/").slice(1);
  return parts.every(canonicalSegment) ? parts : undefined;
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
  if (target.origin !== base.origin) return false;
  const parts = canonicalPathSegments(target.pathname, base.pathname.replace(/\/$/u, ""));
  if (parts === undefined || parts.length === 0) return false;
  const identity =
    request.method === "GET" &&
    parts.length === IDENTITY_SEGMENTS.length &&
    parts.every((part, index) => part === IDENTITY_SEGMENTS[index]);
  return !identity;
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

/** How long a positive identity read vouches for the same credential generation and revision. */
export const JIRA_IDENTITY_PROBE_WINDOW_MS = 10_000;

/**
 * Closed outcome of the same-generation identity read that decides a 401: `confirmed` keeps the
 * credential, `rejected` means the identity read itself answered 401 (the owner has discarded the
 * credential), `inconclusive` is everything else (timeout, throttling, server error, redirect,
 * malformed data, cancellation).
 */
export type JiraIdentityProbeOutcome = "confirmed" | "rejected" | "inconclusive";
export type JiraUnsettledProbe = "stale" | "cancelled-or-expired" | "probe-error";

export interface JiraAuthenticationObservationOptions {
  /** Called once when a probe could not settle for a reason the probe owner cannot record. */
  readonly onUnsettled?: (reason: JiraUnsettledProbe) => void;
}

/**
 * Original response observation stays synchronous; only the subsequent identity GET is awaited.
 * A 401 the identity read could not settle returns `authentication: "unconfirmed"`: the request
 * is refused, the credential is kept, and nobody reads an expired token out of an unproven 401.
 */
export function withJiraAuthenticationObservation<
  TRequest extends Request,
  TResult extends AtlassianHttpResult,
>(
  metadata: AtlassianCredentialMetadata,
  port: (request: TRequest) => Promise<TResult>,
  current: () => boolean,
  probe: (deadlineAt: number, signal: AbortSignal | undefined) => Promise<JiraIdentityProbeOutcome>,
  options: JiraAuthenticationObservationOptions = {},
): (request: TRequest) => Promise<TResult> {
  return async (input): Promise<TResult> => {
    const request: TRequest = { ...input };
    Object.freeze(request);
    const deadline = Date.now() + Math.min(request.timeoutMs, 60_000);
    const result = await port(request);
    if (!ambiguousFailure(metadata, request, result)) return result;
    const unconfirmed = { ...result, authentication: "unconfirmed" } as const;
    if (!current()) {
      options.onUnsettled?.("stale");
      return unconfirmed;
    }
    const signal = "signal" in request ? request.signal : undefined;
    if (!withinOriginalRequest(deadline, signal)) {
      options.onUnsettled?.("cancelled-or-expired");
      return unconfirmed;
    }
    const outcome = await settledProbe(probe, deadline, signal, options);
    if (outcome === "rejected") return result;
    if (outcome === "confirmed" && current() && withinOriginalRequest(deadline, signal))
      return { ...result, authentication: "confirmed" };
    return unconfirmed;
  };
}

/** A credential change during the probe throws out of the port; it settles as inconclusive. */
async function settledProbe(
  probe: (deadlineAt: number, signal: AbortSignal | undefined) => Promise<JiraIdentityProbeOutcome>,
  deadline: number,
  signal: AbortSignal | undefined,
  options: JiraAuthenticationObservationOptions,
): Promise<JiraIdentityProbeOutcome> {
  try {
    return await probe(deadline, signal);
  } catch {
    options.onUnsettled?.("probe-error");
    return "inconclusive";
  }
}
