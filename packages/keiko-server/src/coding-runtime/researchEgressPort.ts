// Research-egress executor for Epic #2384 Code tasks (Issue #2387). This is the `egress` governed
// tool port: the ONLY way a Code task reaches the public internet, and it does so under a
// registered `ResolvedResearchGrant` only. The trust posture is intentionally the narrowest in the
// runtime:
//   * GET-only, so an outbound request can never carry a body — uploads are structurally impossible.
//   * A dedicated egress config that DENIES loopback and inherits none of the CLI/package/connector
//     /credential allowances — proxy and CA settings are copied from the gateway config, nothing
//     else. The named-domain host allowlist (re-checked here on the initial host and every redirect
//     hop) is the PRIMARY control; address-class rejection of a private/loopback/metadata target is
//     defence in depth that the gateway applies only on the direct, non-proxied path — when a proxy
//     is configured, DNS/address classification is skipped there, so this port must never rely on it
//     alone.
//   * Named-domain re-validation on the initial host AND on every redirect hop (no wildcard or
//     subdomain widening, no cross-host redirect escape).
//   * Request-line binding: whenever the initial request's path is non-root or its query is
//     non-empty, the decoded pathname plus visible query must hash to the grant's approved
//     request-line digest, so repository-derived text cannot be smuggled outbound in the path OR
//     the query string. Redirect hops are site-controlled, not model-controlled, and stay
//     host-allowlist-validated only.
//   * Fetch budget is reserved BEFORE each outbound hop (initial and every redirect), so an
//     exhausted grant performs zero network calls; the byte budget is reconciled after each read.
//   * No `authorization`, `cookie`, or api-key header ever leaves; no cookie jar is kept.
//   * The page that comes BACK is quarantined before the model sees it (#2637): none of the above
//     constrains response content, so `researchContentQuarantine` projects the bytes through the
//     hardened visible-text scanner and fences the result as untrusted data. See
//     `docs/coding-runtime/research-content-threat-model.md` for what that does and does not stop.
// Every failure drops the response body and returns a bare `failed`; every fail-closed denial and
// every success emits a content-free `research-performed` event (byte count + outcome only — never
// the page, the URL, the path, or the query).
import { createHash, timingSafeEqual } from "node:crypto";

import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  validateCodingWorkbenchRuntimeEvent,
  type CodingWorkbenchAuxiliaryStatus,
  type CodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import {
  MAX_RESPONSE_BYTES,
  gatewayFetch,
  readBytesCapped,
  type GatewayFetchOptions,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

import type { CodingToolActionOf, GovernedCodingToolPort } from "./codingToolGovernedDelegate.js";
import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import { quarantineResearchContent } from "./researchContentQuarantine.js";
import {
  normalizeResearchHost,
  type ResearchChargeResult,
  type ResearchGrantRegistry,
  type ResolvedResearchGrant,
} from "./researchGrantRegistry.js";

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_READ_BYTES = 2_000_000;

// Research requests never advertise a credential or accept a cookie; the header set is a fixed,
// content-free identity. Kept frozen so no call site can mutate it.
const RESEARCH_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "en",
  "user-agent": "Keiko-Research/1",
});

// Structural mirror of the (non-exported) governed tool result union; assignable to the port's
// `execute` return type. `read` carries the fetched payload plus its content digest and byte count.
interface GovernedResearchRead {
  readonly text: string;
  readonly byteCount: number;
  readonly digest: string;
}
type ResearchEgressResult =
  | { readonly status: "completed"; readonly read?: GovernedResearchRead | undefined }
  | { readonly status: "failed" };

const FAILED: ResearchEgressResult = { status: "failed" };

// Injectable transport: production passes `gatewayFetch`; tests pass a deterministic stub. Options
// are always supplied so the redirect: "manual", DNS-pinned, proxy/CA-aware gateway contract holds.
export type ResearchFetch = (url: string, options: GatewayFetchOptions) => Promise<Response>;

export interface ResearchEgressPortConfig {
  readonly maxRedirects?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxReadBytes?: number | undefined;
}

export interface ResearchEgressPortDeps {
  readonly registry: ResearchGrantRegistry;
  readonly resolveRunId: () => string;
  // The gateway's outbound egress config (proxy/CA); research egress copies only these and adds
  // `denyLoopback`. Resolved per request so runtime config updates are honored immediately.
  readonly gatewayEgress: () => OutboundHttpEgressConfig | undefined;
  readonly emitEvent: (event: CodingWorkbenchRuntimeEvent) => void;
  // Invoked when no live grant covers the requested host (#2387 approval loop): the composition
  // raises a `network-egress` permission request for the exact URL so an operator approval can mint
  // the grant. The fetch itself still fails closed on this call — the model retries after approval.
  readonly onGrantMissing?: ((url: URL) => void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly fetchImpl?: ResearchFetch | undefined;
  readonly config?: ResearchEgressPortConfig | undefined;
}

interface ResolvedResearchEgressConfig {
  readonly maxRedirects: number;
  readonly timeoutMs: number;
  readonly maxReadBytes: number;
}

interface ResearchEgressContext {
  readonly deps: ResearchEgressPortDeps;
  readonly now: () => number;
  readonly fetchImpl: ResearchFetch;
  readonly config: ResolvedResearchEgressConfig;
  readonly nextEventId: () => string;
}

interface ResearchFollowState {
  readonly grant: ResolvedResearchGrant;
  readonly runId: string;
  readonly cfg: OutboundHttpEgressConfig;
  readonly signal: AbortSignal | undefined;
  readonly guard: CodingToolMutationGuard;
}

// ─── Public helpers (shared with the grant-minting side) ────────────────────────────
// The grant's `queryTextDigest` MUST equal `sha256Hex(sanitizeVisibleText(<decoded pathname> + " "
// + <decoded query>))` for the exact request line the user approved; the executor recomputes it
// here and compares in constant time, so both sides must use these two functions and nothing else.

export function sanitizeVisibleText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The canonical reviewable request-line TEXT for a research URL: the sanitized decoded pathname
 * plus the decoded visible query. This is both what the operator is shown before approving
 * (#2387 "visible sanitized queries") and the exact input the digest below is computed over, so the
 * approved text and the bound text can never drift apart.
 */
export function researchRequestLineText(url: URL): string {
  return sanitizeVisibleText(decodeRequestLine(url));
}

/**
 * The canonical request-line digest for a research URL: `sha256Hex(researchRequestLineText(url))`.
 * The grant-minting side (approval issuance) and the executor's request-line binding MUST both call
 * this function so an approved URL always verifies.
 */
export function researchRequestLineDigest(url: URL): string {
  return sha256Hex(researchRequestLineText(url));
}

// ─── Executor ───────────────────────────────────────────────────────────────────────

export function createResearchEgressPort(
  deps: ResearchEgressPortDeps,
): GovernedCodingToolPort<"egress"> {
  let eventSequence = 0;
  const ctx: ResearchEgressContext = {
    deps,
    now: deps.now ?? Date.now,
    fetchImpl: deps.fetchImpl ?? gatewayFetch,
    config: resolveConfig(deps.config),
    nextEventId: (): string => {
      eventSequence += 1;
      return `event-research-${String(eventSequence)}`;
    },
  };
  return {
    execute: (
      request: CodingToolActionOf<"egress">,
      signal: AbortSignal | undefined,
      guard: CodingToolMutationGuard,
    ): Promise<ResearchEgressResult> => runResearchEgress(ctx, request, signal, guard),
  };
}

// Not `async`: every admission failure short-circuits synchronously to a resolved `failed`, and the
// only awaiting work lives inside `followResearch`. This keeps the guard cascade free of an
// await-less async body (and of a `return await` outside a try/catch).
function runResearchEgress(
  ctx: ResearchEgressContext,
  request: CodingToolActionOf<"egress">,
  signal: AbortSignal | undefined,
  guard: CodingToolMutationGuard,
): Promise<ResearchEgressResult> {
  if (signal?.aborted === true || !guard.check()) return failedResult();
  const url = parseHttpsResearchUrl(request.target);
  if (url === undefined) return failedResult();
  const runId = ctx.deps.resolveRunId();
  const grants = ctx.deps.registry.activeGrants(runId, ctx.now());
  const grant = grantForRequest(grants, url);
  if (grant === undefined) {
    // No live grant covers this host: hand the URL to the approval loop and fail this call closed.
    ctx.deps.onGrantMissing?.(url);
    return failedResult();
  }
  if (!requestLineBindingOk(url, grant)) return denyResearch(ctx, runId, "denied");
  const cfg = researchEgressConfig(ctx.deps.gatewayEgress());
  return followResearch(ctx, url, { grant, runId, cfg, signal, guard });
}

function failedResult(): Promise<ResearchEgressResult> {
  return Promise.resolve(FAILED);
}

// Emits a content-free denial event (never the url, path, or query) and fails the fetch closed.
// Used on every fail-closed policy branch: request-line binding, off-allowlist/private redirect,
// expiry, and budget exhaustion.
function denyResearch(
  ctx: ResearchEgressContext,
  runId: string,
  outcome: CodingWorkbenchAuxiliaryStatus,
): Promise<ResearchEgressResult> {
  emitResearchOutcome(ctx, runId, outcome);
  return failedResult();
}

// Maps a non-"ok" registry result to the audit vocabulary: an exhausted count/byte budget is
// "limit-reached"; an elapsed grant is "denied"; a grant the registry no longer holds a record of
// is "unavailable".
function auxiliaryOutcomeForCharge(
  result: Exclude<ResearchChargeResult, "ok">,
): CodingWorkbenchAuxiliaryStatus {
  switch (result) {
    case "limit-reached":
      return "limit-reached";
    case "expired":
      return "denied";
    case "unknown":
      return "unavailable";
  }
}

// https only, no embedded credentials, no explicit non-default port (the URL API strips :443).
function parseHttpsResearchUrl(target: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  return isAllowedResearchUrlShape(url) ? url : undefined;
}

function isAllowedResearchUrlShape(url: URL): boolean {
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "";
}

// Selects the grant for a request binding-aware: among the grants covering the host, prefer one
// whose bound request-line digest admits THIS request line, so several per-URL approvals on the
// same host coexist (each approval mints its own grant). When none binds, the first host-covering
// grant is returned so the subsequent binding check fails closed with an audited denial.
function grantForRequest(
  grants: readonly ResolvedResearchGrant[],
  url: URL,
): ResolvedResearchGrant | undefined {
  const host = normalizeResearchHost(url.hostname);
  const covering = grants.filter((grant) => grant.domains.includes(host));
  return covering.find((grant) => requestLineBindingOk(url, grant)) ?? covering[0];
}

// A bound grant always admits only its exact request line, including the root path. An explicitly
// unbound grant may reach only the root path with no query because that request carries no
// repository-derived text. Any other mismatch is a path/query-smuggling attempt and fails closed.
// Only the INITIAL request is bound this way — redirect hops are site-controlled, not
// model-controlled, and stay host-allowlist-validated only (`isAllowlistedResearchTarget`).
function requestLineBindingOk(url: URL, grant: ResolvedResearchGrant): boolean {
  if (grant.queryTextDigest !== undefined) {
    return digestsEqual(researchRequestLineDigest(url), grant.queryTextDigest);
  }
  return isRootResearchPath(url.pathname) && url.search === "";
}

function isRootResearchPath(pathname: string): boolean {
  return pathname === "" || pathname === "/";
}

function decodeRequestLine(url: URL): string {
  return `${decodePathname(url.pathname)} ${decodeSearch(url.search)}`;
}

function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function decodeSearch(search: string): string {
  const raw = (search.startsWith("?") ? search.slice(1) : search).replaceAll("+", " ");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function digestsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

// A DISTINCT egress config: proxy/CA are copied from the gateway config, but loopback is denied and
// NO private-network / link-local / metadata allowance is inherited. Research egress starts from
// the most restrictive posture regardless of what the gateway itself is permitted.
// `denyLoopback` is declared on `OutboundHttpEgressConfig` (keiko-model-gateway/src/types.ts) and
// enforced in `isTargetClassBlocked` (keiko-model-gateway/src/egress-policy.ts), which blocks the
// "loopback" target class only when this flag is set. `gatewayFetch` additionally resolves the
// target for policy even on the proxied path while the flag is set, so a public name that resolves
// to loopback cannot slip past the proxy hand-off.
function researchEgressConfig(
  base: OutboundHttpEgressConfig | undefined,
): OutboundHttpEgressConfig {
  return {
    denyLoopback: true,
    ...(base?.httpProxy !== undefined ? { httpProxy: base.httpProxy } : {}),
    ...(base?.httpsProxy !== undefined ? { httpsProxy: base.httpsProxy } : {}),
    ...(base?.noProxy !== undefined ? { noProxy: base.noProxy } : {}),
    ...(base?.caBundlePath !== undefined ? { caBundlePath: base.caBundlePath } : {}),
  };
}

async function followResearch(
  ctx: ResearchEgressContext,
  initial: URL,
  state: ResearchFollowState,
): Promise<ResearchEgressResult> {
  let current = initial;
  for (let hop = 0; hop <= ctx.config.maxRedirects; hop += 1) {
    if (!state.guard.check()) return FAILED;
    if (!isAllowlistedResearchTarget(current, state.grant)) {
      return denyResearch(ctx, state.runId, "denied");
    }
    const reserved = ctx.deps.registry.reserveFetch(state.runId, state.grant.grantId, ctx.now());
    if (reserved !== "ok") {
      return denyResearch(ctx, state.runId, auxiliaryOutcomeForCharge(reserved));
    }
    const response = await safeFetch(ctx, current, state);
    if (response === undefined) return FAILED;
    if (isRedirect(response.status)) {
      const next = await redirectTarget(response, current, state.grant);
      if (next === undefined) return denyResearch(ctx, state.runId, "denied");
      current = next;
      continue;
    }
    return finalizeResearch(ctx, response, state);
  }
  return FAILED;
}

// The named-domain re-validation applied to the initial host and to every redirect hop: https, no
// credentials, no non-default port, and the host must be one of the grant's canonical domains
// (exact match — no wildcard or subdomain widening).
function isAllowlistedResearchTarget(url: URL, grant: ResolvedResearchGrant): boolean {
  if (!isAllowedResearchUrlShape(url)) return false;
  return grant.domains.includes(normalizeResearchHost(url.hostname));
}

async function safeFetch(
  ctx: ResearchEgressContext,
  url: URL,
  state: ResearchFollowState,
): Promise<Response | undefined> {
  // KEIKO-0586: register an AbortController per outbound fetch so revokeResearch can abort
  // in-flight requests instead of waiting for them to run to completion and discarding the body.
  // The AbortSignal passed to fetchImpl combines the caller's own signal (which cancels the
  // whole followResearch loop) with the revoke-driven controller (which stops this one hop).
  const controller = new AbortController();
  const release = ctx.deps.registry.registerInFlightFetch(state.runId, controller);
  const signals: AbortSignal[] = [controller.signal];
  if (state.signal !== undefined) signals.push(state.signal);
  const combined = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  try {
    return await ctx.fetchImpl(url.toString(), buildFetchOptions(ctx, state.cfg, combined));
  } catch {
    // Any transport-class failure (blocked target, DNS, TLS, timeout, redirect-policy) fails the
    // fetch closed; the error text is dropped so no upstream detail rides into diagnostics.
    return undefined;
  } finally {
    release();
  }
}

function buildFetchOptions(
  ctx: ResearchEgressContext,
  cfg: OutboundHttpEgressConfig,
  signal: AbortSignal | undefined,
): GatewayFetchOptions {
  return {
    method: "GET",
    headers: { ...RESEARCH_HEADERS },
    egress: cfg,
    timeoutMs: ctx.config.timeoutMs,
    maxResponseBytes: ctx.config.maxReadBytes,
    ...(signal === undefined ? {} : { signal }),
  };
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

// A redirect is followed only to another allowlisted target on the SAME grant; an absent, invalid,
// or off-allowlist `location` (redirect-escape) fails closed.
async function redirectTarget(
  response: Response,
  current: URL,
  grant: ResolvedResearchGrant,
): Promise<URL | undefined> {
  await discardBody(response);
  const location = response.headers.get("location");
  if (location === null || location.trim() === "") return undefined;
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return undefined;
  }
  return isAllowlistedResearchTarget(next, grant) ? next : undefined;
}

// #3099 R10: differentiate over-cap-for-sure (Content-Length header exceeds maxReadBytes) from
// transient / unknown-length failures. Only the former justifies exhausting the grant's byte
// budget on a single strike — a transient stream error should keep subsequent legitimate
// fetches available.
function isDefinitelyOverCap(response: Response, maxReadBytes: number): boolean {
  const raw = response.headers.get("content-length");
  if (raw === null) return false;
  const declared = Number.parseInt(raw, 10);
  return Number.isFinite(declared) && declared > maxReadBytes;
}

async function finalizeResearch(
  ctx: ResearchEgressContext,
  response: Response,
  state: ResearchFollowState,
): Promise<ResearchEgressResult> {
  let bytes: Uint8Array;
  try {
    bytes = await readBytesCapped(response, ctx.config.maxReadBytes);
  } catch {
    // #3099 R7/R10: saturate the grant ONLY when we can prove the response was over-cap.
    // readBytesCapped throws for two reasons: (a) content exceeded maxBytes, or (b) a
    // transient network / stream error. A transient error should NOT deny subsequent
    // legitimate fetches (R10 KfQ), so we require a Content-Length header exceeding maxReadBytes
    // as the definitive signal. Absent a length or a length within cap, the failure is either
    // transient or already under budget; both fall closed for THIS fetch but leave the grant
    // alive.
    if (isDefinitelyOverCap(response, ctx.config.maxReadBytes)) {
      ctx.deps.registry.saturateBytes(state.runId, state.grant.grantId);
    }
    return FAILED;
  }
  const charge = ctx.deps.registry.chargeFetch(
    state.runId,
    state.grant.grantId,
    bytes.byteLength,
    ctx.now(),
  );
  if (charge !== "ok") return denyResearch(ctx, state.runId, auxiliaryOutcomeForCharge(charge));
  // #2637: the page NEVER reaches the model as fetched. It is projected through the read-only
  // quarantine step first, which drops the channels a human previewing the page could not have seen
  // and fences what survives as explicitly untrusted data. The accepted event says so, so the
  // timeline can tell the operator that this run took in third-party content.
  const read = await researchRead(bytes, ctx.now);
  emitResearchPerformed(ctx, state.runId, bytes.byteLength);
  return { status: "completed", read };
}

// `byteCount` and `digest` stay bound to the bytes that actually came off the wire — they are the
// budget and audit truth for the fetch, not a description of the quarantined projection.
async function researchRead(bytes: Uint8Array, now: () => number): Promise<GovernedResearchRead> {
  const quarantined = await quarantineResearchContent(bytes, now);
  return {
    text: quarantined.text,
    byteCount: bytes.byteLength,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function emitResearchPerformed(ctx: ResearchEgressContext, runId: string, byteCount: number): void {
  emitResearchOutcome(ctx, runId, "accepted", byteCount);
}

// Emits a content-free `research-performed` event: the normalized outcome and, on success, the
// byte count only — never the url, path, or query. Used for both the accepted path and every
// fail-closed denial so the audit trail never silently drops a policy decision.
function emitResearchOutcome(
  ctx: ResearchEgressContext,
  runId: string,
  auxiliaryOutcome: CodingWorkbenchAuxiliaryStatus,
  byteCount?: number,
): void {
  const event: CodingWorkbenchRuntimeEvent = {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    eventId: ctx.nextEventId(),
    runId,
    occurredAt: new Date(ctx.now()).toISOString(),
    kind: "research-performed",
    auxiliaryOutcome,
    // #2637: an accepted read handed quarantined page text to the model; the contract REQUIRES the
    // classification on exactly that outcome, and rejects it on every denial (which produced no
    // read at all). Keeping it here — next to the outcome it is bound to — is what makes the
    // emitted event unable to describe a research read whose trust was never asserted.
    ...(auxiliaryOutcome === "accepted" ? { contentTrust: "untrusted" as const } : {}),
    ...(byteCount === undefined ? {} : { byteCount }),
  };
  if (validateCodingWorkbenchRuntimeEvent(event).ok) {
    ctx.deps.emitEvent(event);
  }
}

// Best-effort body drain on a redirect so the connection is released; releasing the unread stream
// is best-effort only and its failure is not actionable.
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing the unread stream is best-effort only.
  }
}

function resolveConfig(config: ResearchEgressPortConfig | undefined): ResolvedResearchEgressConfig {
  return {
    maxRedirects: clampNonNegative(config?.maxRedirects, DEFAULT_MAX_REDIRECTS),
    timeoutMs: clampPositive(config?.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxReadBytes: Math.min(
      clampPositive(config?.maxReadBytes, DEFAULT_MAX_READ_BYTES),
      MAX_RESPONSE_BYTES,
    ),
  };
}

function clampPositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function clampNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}
