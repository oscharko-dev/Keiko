// Run-bound, in-memory registry of public-research egress grants for Epic #2384 Code tasks
// (Issue #2387). A grant is minted from a validated `AuxiliaryResearchScopeV1` (a non-empty set of
// public domains plus an exact expiry and the sha256 of the sanitized approved request line — the
// visible pathname plus query the executor will bind against) and is the sole authority the
// research-egress executor consults before any outbound fetch: it never widens authority, never
// names a private/loopback/metadata host (those are rejected by `isCodeTaskPublicDomain` at
// registration and again by the gateway at fetch time), and expires deterministically. The fetch
// count is reserved via `reserveFetch` BEFORE each outbound hop, so an exhausted grant performs
// zero network calls; the cumulative byte budget is reconciled via `chargeFetch` after each read.
// Every stored value is content-free except the in-memory-only `sanitizedQuery`, which is retained
// for local re-hashing and is NEVER persisted, evidenced, or emitted.
import type { AuxiliaryResearchScopeV1 } from "@oscharko-dev/keiko-contracts";
import { isCodeTaskPublicDomain } from "@oscharko-dev/keiko-contracts/runtime/code-task-auxiliary";

// Defaults are bounded and fail-closed: a grant lives at most ten minutes, permits a small number
// of fetches, and never streams more than the gateway's own per-response ceiling in aggregate.
export const RESEARCH_GRANT_DEFAULT_MAX_TTL_MS = 600_000;
export const RESEARCH_GRANT_DEFAULT_MAX_FETCHES = 16;
export const RESEARCH_GRANT_DEFAULT_MAX_TOTAL_BYTES = 10_000_000;

export interface ResearchGrantRegistryLimits {
  readonly maxGrantTtlMs: number;
  readonly maxFetchesPerGrant: number;
  readonly maxTotalBytesPerGrant: number;
}

export interface ResearchGrantRegistryOptions {
  readonly limits?: Partial<ResearchGrantRegistryLimits> | undefined;
}

// A resolved grant as seen by the executor. `queryTextDigest` and `sanitizedQuery` are optional:
// a grant may be domain-scoped without binding a specific request line. When present,
// `queryTextDigest` covers the approved REQUEST LINE — the sanitized, decoded pathname plus visible
// query the executor recomputes and compares against on the initial request (see
// `researchEgressPort.ts`'s request-line binding) — not the query string alone. `sanitizedQuery`
// stays in memory only.
export interface ResolvedResearchGrant {
  readonly grantId: string;
  readonly runId: string;
  readonly domains: readonly string[];
  readonly expiresAtMs: number;
  readonly queryTextDigest?: string | undefined;
  readonly sanitizedQuery?: string | undefined;
  readonly approvalDigest: string;
  readonly maxFetches: number;
  readonly usedFetches: number;
  readonly maxTotalBytes: number;
  readonly usedBytes: number;
}

// Distinct results so the executor can tell an exhausted budget from an expired or unknown grant
// (each still fails the outbound fetch closed, but the reason is retained for the audit event).
export type ResearchChargeResult = "ok" | "limit-reached" | "expired" | "unknown";

export interface ResearchGrantRegistry {
  readonly register: (
    runId: string,
    scope: AuxiliaryResearchScopeV1,
    sanitizedQuery: string | undefined,
    approvalDigest: string,
    nowMs: number,
  ) => ResolvedResearchGrant | undefined;
  readonly activeGrants: (runId: string, nowMs: number) => readonly ResolvedResearchGrant[];
  // KEIKO-0595: `resolveForHost` was removed from the registry interface. The one production
  // consumer (`researchEgressPort.ts::grantForRequest`) needs request-line-binding-aware
  // selection on top of host normalisation, so it reads `activeGrants` and applies the richer
  // rule locally. Keeping a separate host-only resolver here invited silent drift and offered a
  // shape a future caller could reach for and lose the request-line-binding gate.
  // Reserves one fetch against the grant's fetch-count budget BEFORE any network call is made, so
  // the executor calls this ahead of every outbound hop (initial request and each redirect) and
  // performs zero outbound requests once the budget is exhausted. Increments `usedFetches` on "ok".
  readonly reserveFetch: (runId: string, grantId: string, nowMs: number) => ResearchChargeResult;
  // Reconciles the actual bytes read against the grant's cumulative byte budget AFTER a response
  // body has been read. Does not touch the fetch-count budget — that is `reserveFetch`'s job.
  readonly chargeFetch: (
    runId: string,
    grantId: string,
    bytes: number,
    nowMs: number,
  ) => ResearchChargeResult;
  readonly invalidateRun: (runId: string) => void;
  /**
   * KEIKO-0586: registers an AbortController that the executor is about to use for one outbound
   * fetch. The registration is dropped automatically once the returned `release()` is called
   * (finally block on the fetch), and every registered controller for a runId is fired when the
   * run's grants are invalidated (revokeResearch or expiry sweep). This narrows the
   * time-bounded gap between "operator clicked Revoke" and "underlying HTTP request actually
   * stops" — previously the fetch continued running to completion with its body merely discarded.
   */
  readonly registerInFlightFetch: (runId: string, controller: AbortController) => () => void;
  /**
   * Saturates a specific grant's cumulative byte budget so `reserveFetch`'s byte gate fails
   * closed on the next call. #3099 R7 P1: used by the research egress port on an over-cap or
   * mid-stream read failure — the fetch DID happen against the endpoint, we just cannot
   * measure the exact bytes read. Charging maxReadBytes (2 MB) against the 10 MB grant is
   * insufficient because the charge succeeds and lets 4 more oversized responses through
   * before the fetch-count cap. Saturating gives one strike, one exhaustion.
   */
  readonly saturateBytes: (runId: string, grantId: string) => void;
}

// Internal mutable form: only the two usage counters mutate (`usedFetches` via `reserveFetch`,
// `usedBytes` via `chargeFetch`); everything else is frozen for the grant's lifetime.
interface MutableResearchGrant {
  readonly grantId: string;
  readonly runId: string;
  readonly domains: readonly string[];
  readonly expiresAtMs: number;
  readonly queryTextDigest: string | undefined;
  readonly sanitizedQuery: string | undefined;
  readonly approvalDigest: string;
  readonly maxFetches: number;
  usedFetches: number;
  readonly maxTotalBytes: number;
  usedBytes: number;
}

// Canonical host form shared by grant registration and executor host matching, so the domain a
// grant names and the host a URL resolves to are compared under identical rules (lower-case, no
// surrounding IPv6 brackets, no trailing dot). Exported so the executor never forks the rule.
export function normalizeResearchHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.$/u, "");
}

// Re-validates a single domain as a canonical public domain (defence in depth on top of the
// contract validator): IP literals, loopback names, and malformed labels return undefined so the
// whole registration fails closed.
function canonicalizePublicDomain(domain: string): string | undefined {
  const canonical = normalizeResearchHost(domain);
  return isCodeTaskPublicDomain(canonical) ? canonical : undefined;
}

// Canonicalizes and de-duplicates the grant's domains. Any invalid domain, or an empty result,
// fails the whole registration closed — a research grant must always name at least one public host.
function canonicalizeDomains(domains: readonly string[]): readonly string[] | undefined {
  const canonical: string[] = [];
  for (const domain of domains) {
    const one = canonicalizePublicDomain(domain);
    if (one === undefined) return undefined;
    if (!canonical.includes(one)) canonical.push(one);
  }
  return canonical.length > 0 ? canonical : undefined;
}

function knownQueryDigest(fact: AuxiliaryResearchScopeV1["queryTextDigest"]): string | undefined {
  return fact.outcome === "known" ? fact.value : undefined;
}

function clampBytes(bytes: number): number {
  return Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : 0;
}

function resolveLimits(
  options: ResearchGrantRegistryOptions | undefined,
): ResearchGrantRegistryLimits {
  const limits = options?.limits;
  return {
    maxGrantTtlMs: limits?.maxGrantTtlMs ?? RESEARCH_GRANT_DEFAULT_MAX_TTL_MS,
    maxFetchesPerGrant: limits?.maxFetchesPerGrant ?? RESEARCH_GRANT_DEFAULT_MAX_FETCHES,
    maxTotalBytesPerGrant: limits?.maxTotalBytesPerGrant ?? RESEARCH_GRANT_DEFAULT_MAX_TOTAL_BYTES,
  };
}

class InMemoryResearchGrantRegistry implements ResearchGrantRegistry {
  private readonly grantsByRun = new Map<string, MutableResearchGrant[]>();

  public constructor(private readonly limits: ResearchGrantRegistryLimits) {}

  public register(
    runId: string,
    scope: AuxiliaryResearchScopeV1,
    sanitizedQuery: string | undefined,
    approvalDigest: string,
    nowMs: number,
  ): ResolvedResearchGrant | undefined {
    const domains = canonicalizeDomains(scope.domains);
    if (domains === undefined) return undefined;
    const expiresAtMs = this.grantExpiry(scope.expiresAt, nowMs);
    if (expiresAtMs === undefined) return undefined;
    const grant: MutableResearchGrant = {
      grantId: scope.grantId,
      runId,
      domains,
      expiresAtMs,
      queryTextDigest: knownQueryDigest(scope.queryTextDigest),
      sanitizedQuery,
      approvalDigest,
      maxFetches: this.limits.maxFetchesPerGrant,
      usedFetches: 0,
      maxTotalBytes: this.limits.maxTotalBytesPerGrant,
      usedBytes: 0,
    };
    this.store(runId, grant, nowMs);
    return grant;
  }

  // A grant never outlives min(scope expiry, now + max TTL); a non-parseable or already-elapsed
  // expiry fails closed (undefined).
  private grantExpiry(expiresAt: string, nowMs: number): number | undefined {
    const parsed = Date.parse(expiresAt);
    if (!Number.isFinite(parsed)) return undefined;
    const expiresAtMs = Math.min(parsed, nowMs + this.limits.maxGrantTtlMs);
    return expiresAtMs > nowMs ? expiresAtMs : undefined;
  }

  private store(runId: string, grant: MutableResearchGrant, nowMs: number): void {
    const live = this.pruned(runId, nowMs).filter((existing) => existing.grantId !== grant.grantId);
    live.push(grant);
    this.grantsByRun.set(runId, live);
  }

  // Drops expired grants for a run before every read/registration so an expired grant can never be
  // resolved and the map does not retain dead runs.
  private pruned(runId: string, nowMs: number): MutableResearchGrant[] {
    const grants = this.grantsByRun.get(runId);
    if (grants === undefined) return [];
    const live = grants.filter((grant) => grant.expiresAtMs > nowMs);
    if (live.length === 0) this.grantsByRun.delete(runId);
    else this.grantsByRun.set(runId, live);
    return live;
  }

  public activeGrants(runId: string, nowMs: number): readonly ResolvedResearchGrant[] {
    return [...this.pruned(runId, nowMs)];
  }

  // KEIKO-0595: resolveForHost was removed; grantForRequest in researchEgressPort.ts owns the
  // one production host-resolution path (activeGrants + request-line-binding preference).

  // Reserves one fetch against the fetch-count budget BEFORE the caller makes any network call.
  // Expiry is checked before pruning would remove the grant so "expired" stays distinguishable
  // from "unknown". Also refuses a reservation once the cumulative byte budget is already exhausted
  // — chargeFetch runs after the response body has been read, so without this gate the next hop
  // would be admitted and only stopped at charge time, permitting one extra outbound request per
  // over-budget grant.
  public reserveFetch(runId: string, grantId: string, nowMs: number): ResearchChargeResult {
    const grant = this.findGrant(runId, grantId);
    if (grant === undefined) return "unknown";
    if (grant.expiresAtMs <= nowMs) return "expired";
    if (grant.usedFetches + 1 > grant.maxFetches) return "limit-reached";
    if (grant.usedBytes >= grant.maxTotalBytes) return "limit-reached";
    grant.usedFetches += 1;
    return "ok";
  }

  // Reconciles actual bytes read against the cumulative byte budget AFTER a response body has been
  // read. Never touches `usedFetches` — that budget is reserved up front by `reserveFetch`.
  // #3099 P1 follow-up: an over-limit charge now saturates `usedBytes` at `maxTotalBytes` so
  // subsequent `reserveFetch` calls see the terminally-exhausted state and deny. Previously
  // `usedBytes` was left below the ceiling on the rejected charge, so the byte gate in
  // reserveFetch never fired and later hops slipped through until the fetch-count cap.
  public chargeFetch(
    runId: string,
    grantId: string,
    bytes: number,
    nowMs: number,
  ): ResearchChargeResult {
    const grant = this.findGrant(runId, grantId);
    if (grant === undefined) return "unknown";
    if (grant.expiresAtMs <= nowMs) return "expired";
    const charged = clampBytes(bytes);
    if (grant.usedBytes + charged > grant.maxTotalBytes) {
      grant.usedBytes = grant.maxTotalBytes;
      return "limit-reached";
    }
    grant.usedBytes += charged;
    return "ok";
  }

  private findGrant(runId: string, grantId: string): MutableResearchGrant | undefined {
    return this.grantsByRun.get(runId)?.find((candidate) => candidate.grantId === grantId);
  }

  // KEIKO-0586: in-flight AbortControllers keyed by runId. When invalidateRun fires (revoke or
  // expiry), every controller registered for that runId is aborted so the underlying HTTP
  // request stops immediately instead of running to completion with its body discarded.
  private readonly abortControllersByRun = new Map<string, Set<AbortController>>();

  public registerInFlightFetch(runId: string, controller: AbortController): () => void {
    const existing = this.abortControllersByRun.get(runId) ?? new Set<AbortController>();
    existing.add(controller);
    this.abortControllersByRun.set(runId, existing);
    return (): void => {
      const set = this.abortControllersByRun.get(runId);
      if (set === undefined) return;
      set.delete(controller);
      if (set.size === 0) this.abortControllersByRun.delete(runId);
    };
  }

  public invalidateRun(runId: string): void {
    this.grantsByRun.delete(runId);
    // KEIKO-0586: abort any in-flight fetches for the run so the underlying HTTP request stops
    // immediately rather than running to completion and having its body discarded.
    const controllers = this.abortControllersByRun.get(runId);
    if (controllers !== undefined) {
      for (const controller of controllers) {
        try {
          controller.abort();
        } catch {
          /* aborting a controller must never throw into the invalidation path */
        }
      }
      this.abortControllersByRun.delete(runId);
    }
  }

  public saturateBytes(runId: string, grantId: string): void {
    const grant = this.findGrant(runId, grantId);
    if (grant === undefined) return;
    grant.usedBytes = grant.maxTotalBytes;
  }
}

export function createResearchGrantRegistry(
  options: ResearchGrantRegistryOptions = {},
): ResearchGrantRegistry {
  return new InMemoryResearchGrantRegistry(resolveLimits(options));
}
