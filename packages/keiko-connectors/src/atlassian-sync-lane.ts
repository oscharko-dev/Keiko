// Provider-agnostic Atlassian sync lane (Issue #2242, Epic #2238, ADR-0128 D3/D5).
//
// One bounded enumerate → fetch → normalize run over TWO injected ports and nothing else:
//
//   - `AtlassianHttpBodyPort` — the credential-blind transport (concrete adapter in keiko-server).
//     The lane wraps it once per run in a budget- and deadline-aware retrying port
//     (`ATLASSIAN_SYNC_RETRY_*`, ADR-0128 D3 backoff) so every provider adapter gets the identical
//     429/5xx policy without reimplementing it.
//   - `AtlassianSyncSource` — the provider adapter seam. The Confluence adapter implements it in
//     this package; the Jira adapter (#2243) plugs into the SAME lane by implementing the same two
//     methods. The lane never knows provider endpoints.
//
// Handoff stays in keiko-server (the composition root): the lane returns a classified
// `AtlassianSyncFetchOutcome` (normalized items + enumerated keys + closed failure tallies) and
// the server feeds it into the keiko-local-knowledge connector-pod sink. Fail-closed coverage
// rule (mirroring the Epic #1856 limit-reached-crawl rule): a run whose ENUMERATION or FETCH
// coverage was truncated by a run budget (items, bytes, duration) or cancelled is NOT applicable —
// applying a truncated view would prune live pages and misreport removals. Per-item failures
// (403, oversized, malformed, per-item timeout) degrade gracefully and keep the run applicable.
//
// D5 bounds hold continuously: the byte budget is decremented by every response body actually
// read (enumeration pages included) and each request's body cap is clamped to the remaining
// budget, so the lane can never buffer past `maxBytes` even transiently.

import type {
  AtlassianSyncBounds,
  AtlassianSyncFailureReason,
  AtlassianSyncProgressCounts,
} from "@oscharko-dev/keiko-contracts";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";

// ─── ADR-0128 D3 transport constants ──────────────────────────────────────────
// Exponential backoff for 429/5xx: 500 ms base, factor 2, 8 000 ms per-attempt cap, at most 5
// attempts total; `Retry-After` is honored when present and capped at the same ceiling. 4xx other
// than 429 never retries. 60 000 ms per paginated bulk-sync fetch.
export const ATLASSIAN_SYNC_RETRY_BASE_DELAY_MS = 500;
export const ATLASSIAN_SYNC_RETRY_FACTOR = 2;
export const ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS = 8_000;
export const ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS = 5;
export const ATLASSIAN_SYNC_PAGINATED_FETCH_TIMEOUT_MS = 60_000;

// Per-item normalized-content cap. A single page whose storage body exceeds this is skipped with
// `bounds-exceeded` (indexing a mid-tag-truncated body would be malformed), without failing the
// run — mirroring the manual crawler's `oversized-page` denial.
export const ATLASSIAN_SYNC_ITEM_MAX_BYTES = 2_000_000;

// ─── Run context (what the lane hands each provider-adapter call) ─────────────
// `http` is already budget-, deadline-, and retry-aware; adapters never wrap it again. `signal`
// aborts between page boundaries. `deadlineExceeded` lets an adapter stop a pagination loop
// early; the budgeted port re-checks it fail-closed on every request anyway.
export interface AtlassianSyncFetchContext {
  readonly http: AtlassianHttpBodyPort;
  readonly signal?: AbortSignal | undefined;
  readonly deadlineExceeded: () => boolean;
  readonly maxItems: number;
}

// One enumerated provider item: a stable provider identity (`confluence:<connectorId>:<pageId>`),
// never a resolved path. Adapters may extend the ref with provider-private fields; the lane hands
// the exact ref back to `fetchItem`.
export interface AtlassianSyncItemRef {
  readonly itemKey: string;
}

// One fetched, normalized item ready for the shared parser/chunking/indexing lane downstream.
// `contentHtml` is a complete HTML document (the provider adapter wraps storage-format bodies);
// `relativePath` is derived from the stable item id only, so renames never move the document.
export interface AtlassianSyncItem {
  readonly itemKey: string;
  readonly title: string;
  readonly relativePath: string;
  readonly contentHtml: string;
  readonly byteLength: number;
  // Provider webui link path for citation click-through (e.g. `/wiki/spaces/K/pages/1/Title` or
  // `/browse/PROJ-1`).
  readonly webuiPath?: string | undefined;
  // Optional provider-structured citation metadata, serialized deterministically and validated by
  // the producing adapter (#2243: the `JiraIssueCitationMetadata` contract shape). Bounded
  // display-safe field values only — never a body. The sink persists it beside the item
  // fingerprint for citation display.
  readonly citationMetadataJson?: string | undefined;
}

export type AtlassianSyncEnumerationOutcome<TRef extends AtlassianSyncItemRef> =
  | { readonly ok: true; readonly refs: readonly TRef[]; readonly complete: boolean }
  | { readonly ok: false; readonly reason: AtlassianSyncFailureReason };

// Closed per-item fetch classification (issue Scope 4): `item` indexes; `skipped` degrades the run
// to partial with a closed reason; `missing` (404) means the item vanished upstream between
// enumeration and fetch — it leaves the enumerated set so removal detection counts it; `fatal`
// (401) aborts the whole run.
export type AtlassianSyncItemFetchOutcome =
  | { readonly kind: "item"; readonly item: AtlassianSyncItem }
  | { readonly kind: "skipped"; readonly reason: AtlassianSyncFailureReason }
  | { readonly kind: "missing" }
  | { readonly kind: "fatal"; readonly reason: AtlassianSyncFailureReason };

// The provider-adapter seam (#2243 plugs Jira in here). `enumerate` lists the approved scope's
// item refs (complete=false when it stopped early at the lane's `maxItems` ceiling); `fetchItem`
// retrieves and normalizes one item.
export interface AtlassianSyncSource<TRef extends AtlassianSyncItemRef = AtlassianSyncItemRef> {
  readonly enumerate: (
    context: AtlassianSyncFetchContext,
  ) => Promise<AtlassianSyncEnumerationOutcome<TRef>>;
  readonly fetchItem: (
    ref: TRef,
    context: AtlassianSyncFetchContext,
  ) => Promise<AtlassianSyncItemFetchOutcome>;
}

// ─── Lane result ───────────────────────────────────────────────────────────────
export interface AtlassianSyncItemFailure {
  readonly itemKey: string;
  readonly reason: AtlassianSyncFailureReason;
}

// `applicable` is the fail-closed coverage verdict: true only when enumeration completed within
// bounds AND every enumerated item reached a terminal per-item outcome (fetched, skipped with a
// reason, or missing). Truncated/cancelled/fatal runs must not be applied downstream.
export type AtlassianSyncFetchOutcome =
  | {
      readonly status: "completed";
      readonly applicable: true;
      readonly items: readonly AtlassianSyncItem[];
      readonly enumeratedItemKeys: readonly string[];
      readonly failures: readonly AtlassianSyncItemFailure[];
      readonly progress: AtlassianSyncProgressCounts;
    }
  | {
      readonly status: "truncated";
      readonly applicable: false;
      readonly reason: AtlassianSyncFailureReason;
      readonly progress: AtlassianSyncProgressCounts;
    }
  | {
      readonly status: "cancelled";
      readonly applicable: false;
      readonly progress: AtlassianSyncProgressCounts;
    }
  | {
      readonly status: "failed";
      readonly applicable: false;
      readonly reason: AtlassianSyncFailureReason;
      readonly progress: AtlassianSyncProgressCounts;
    };

export interface RunAtlassianSyncFetchDeps<
  TRef extends AtlassianSyncItemRef = AtlassianSyncItemRef,
> {
  readonly source: AtlassianSyncSource<TRef>;
  readonly http: AtlassianHttpBodyPort;
  readonly bounds: AtlassianSyncBounds;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => number) | undefined;
  // Injected backoff sleep (real timer in production, recorded no-op in tests).
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly onProgress?: ((progress: AtlassianSyncProgressCounts) => void) | undefined;
}

// ─── Budgeted, deadline-aware, retrying transport wrapper ─────────────────────
// Thrown when the cumulative byte budget or the run deadline is exhausted mid-flight; carries the
// closed reason the run terminates with. Caught inside the lane, and by the bounded single-action
// consumers of `createAtlassianBudgetedRetryingPort` (the live JQL search, #2248) — never
// propagated past a lane entry point.
export class AtlassianSyncBudgetExhausted extends Error {
  readonly reason: AtlassianSyncFailureReason;
  constructor(reason: AtlassianSyncFailureReason) {
    super("atlassian sync run budget exhausted");
    this.name = "AtlassianSyncBudgetExhausted";
    this.reason = reason;
  }
}

interface MutableRunBudget {
  remainingBytes: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(Math.trunc(retryAfterMs), ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS);
  }
  const exponential =
    ATLASSIAN_SYNC_RETRY_BASE_DELAY_MS * ATLASSIAN_SYNC_RETRY_FACTOR ** (attempt - 1);
  return Math.min(exponential, ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

interface BudgetedPortDeps {
  readonly http: AtlassianHttpBodyPort;
  readonly budget: MutableRunBudget;
  readonly deadlineAt: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal | undefined;
}

function assertWithinRunBudget(deps: BudgetedPortDeps): void {
  if (deps.now() > deps.deadlineAt) throw new AtlassianSyncBudgetExhausted("timeout");
  if (deps.budget.remainingBytes < 1) throw new AtlassianSyncBudgetExhausted("bounds-exceeded");
}

async function requestOnce(
  deps: BudgetedPortDeps,
  request: AtlassianHttpBodyRequest,
): Promise<AtlassianHttpBodyResult> {
  assertWithinRunBudget(deps);
  // Clamp every request's body cap to the remaining cumulative budget (continuous enforcement)
  // and thread the run's cancellation signal so an abort tears down in-flight requests.
  const cappedRequest: AtlassianHttpBodyRequest = {
    ...request,
    maxBodyBytes: Math.min(request.maxBodyBytes, deps.budget.remainingBytes),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  };
  const result = await deps.http(cappedRequest);
  if (result.kind === "response") {
    deps.budget.remainingBytes -= result.bodyBytes;
  }
  return result;
}

// A backoff wait never overshoots the run deadline: when the required delay would cross it, the
// run gives up immediately with the retry reason (a hostile Retry-After cannot stall the run).
async function sleepWithinDeadline(deps: BudgetedPortDeps, delayMs: number): Promise<boolean> {
  if (deps.now() + delayMs > deps.deadlineAt) return false;
  await deps.sleep(delayMs);
  return true;
}

// The uniform ADR-0128 D3 retry loop shared by every provider adapter: 429/5xx retries with
// exponential backoff (Retry-After honored + capped); every other outcome returns immediately.
function createBudgetedRetryingPort(deps: BudgetedPortDeps): AtlassianHttpBodyPort {
  return async (request: AtlassianHttpBodyRequest): Promise<AtlassianHttpBodyResult> => {
    let result = await requestOnce(deps, request);
    for (let attempt = 1; attempt < ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS; attempt += 1) {
      if (result.kind !== "response" || !isRetryableStatus(result.status)) return result;
      const retryAfterMs = result.retryAfterMs;
      if (!(await sleepWithinDeadline(deps, retryDelayMs(attempt, retryAfterMs)))) return result;
      result = await requestOnce(deps, request);
    }
    return result;
  };
}

// ─── Standalone bounded transport for single-action lanes (Issue #2248) ───────
// The EXACT budget-, deadline-, and retry-aware wrapper the sync lane builds per run, surfaced
// for bounded single-action reads (the live JQL search): same D3 backoff with capped Retry-After,
// same backoff-never-overshoots-the-deadline rule, same continuous byte accounting that clamps
// every request's body cap to the remaining budget. Exhaustion throws
// `AtlassianSyncBudgetExhausted` exactly as inside the lane; the consuming executor catches it
// and maps the closed reason onto its typed failure — never a silent partial result.
export interface AtlassianBudgetedRetryingPortOptions {
  readonly http: AtlassianHttpBodyPort;
  readonly maxBytes: number;
  readonly deadlineAt: number;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export function createAtlassianBudgetedRetryingPort(
  options: AtlassianBudgetedRetryingPortOptions,
): AtlassianHttpBodyPort {
  return createBudgetedRetryingPort({
    http: options.http,
    budget: { remainingBytes: options.maxBytes },
    deadlineAt: options.deadlineAt,
    now: options.now ?? ((): number => Date.now()),
    sleep: options.sleep ?? defaultSleep,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

// ─── Progress accounting ───────────────────────────────────────────────────────
interface MutableProgress {
  enumeratedItems: number;
  fetchedItems: number;
  indexedItems: number;
  skippedItems: number;
  failedItems: number;
}

function snapshotProgress(progress: MutableProgress): AtlassianSyncProgressCounts {
  return {
    enumeratedItems: progress.enumeratedItems,
    fetchedItems: progress.fetchedItems,
    indexedItems: progress.indexedItems,
    skippedItems: progress.skippedItems,
    failedItems: progress.failedItems,
  };
}

// ─── Run state ─────────────────────────────────────────────────────────────────
interface FetchRunState<TRef extends AtlassianSyncItemRef> {
  readonly deps: RunAtlassianSyncFetchDeps<TRef>;
  readonly context: AtlassianSyncFetchContext;
  readonly now: () => number;
  readonly progress: MutableProgress;
  readonly items: AtlassianSyncItem[];
  readonly failures: AtlassianSyncItemFailure[];
  readonly enumeratedItemKeys: string[];
  fatalReason: AtlassianSyncFailureReason | undefined;
}

function emitProgress<TRef extends AtlassianSyncItemRef>(state: FetchRunState<TRef>): void {
  state.deps.onProgress?.(snapshotProgress(state.progress));
}

function cancelled<TRef extends AtlassianSyncItemRef>(state: FetchRunState<TRef>): boolean {
  return state.deps.signal?.aborted === true;
}

function applyItemOutcome<TRef extends AtlassianSyncItemRef>(
  state: FetchRunState<TRef>,
  ref: TRef,
  outcome: AtlassianSyncItemFetchOutcome,
): void {
  if (outcome.kind === "item") {
    state.items.push(outcome.item);
    state.progress.fetchedItems += 1;
  } else if (outcome.kind === "skipped") {
    state.failures.push({ itemKey: ref.itemKey, reason: outcome.reason });
    state.progress.skippedItems += 1;
    state.progress.failedItems += 1;
  } else if (outcome.kind === "missing") {
    // Vanished upstream between enumeration and fetch (404): drop it from the enumerated set so
    // the downstream diff reports it removed — a natural deletion, not a failure.
    const index = state.enumeratedItemKeys.indexOf(ref.itemKey);
    if (index !== -1) state.enumeratedItemKeys.splice(index, 1);
    state.progress.skippedItems += 1;
  } else {
    state.fatalReason ??= outcome.reason;
  }
  emitProgress(state);
}

async function fetchOne<TRef extends AtlassianSyncItemRef>(
  state: FetchRunState<TRef>,
  ref: TRef,
): Promise<void> {
  const outcome = await state.deps.source.fetchItem(ref, state.context);
  applyItemOutcome(state, ref, outcome);
}

// Bounded worker pool: at most `maxConcurrency` fetches in flight; stops dispatching on
// cancellation, fatal classification, or budget exhaustion (the shared cursor makes each worker
// pull the next undispatched ref).
async function fetchAllItems<TRef extends AtlassianSyncItemRef>(
  state: FetchRunState<TRef>,
  refs: readonly TRef[],
): Promise<void> {
  const concurrency = Math.max(1, Math.min(state.deps.bounds.maxConcurrency, refs.length));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < refs.length) {
      if (cancelled(state) || state.fatalReason !== undefined) return;
      const ref = refs[cursor];
      cursor += 1;
      if (ref === undefined) return;
      await fetchOne(state, ref);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function truncatedOutcome<TRef extends AtlassianSyncItemRef>(
  state: FetchRunState<TRef>,
  reason: AtlassianSyncFailureReason,
): AtlassianSyncFetchOutcome {
  return {
    status: "truncated",
    applicable: false,
    reason,
    progress: snapshotProgress(state.progress),
  };
}

function terminalOutcome<TRef extends AtlassianSyncItemRef>(
  state: FetchRunState<TRef>,
  dispatchedAll: boolean,
): AtlassianSyncFetchOutcome {
  if (cancelled(state)) {
    return { status: "cancelled", applicable: false, progress: snapshotProgress(state.progress) };
  }
  if (state.fatalReason !== undefined) {
    return {
      status: "failed",
      applicable: false,
      reason: state.fatalReason,
      progress: snapshotProgress(state.progress),
    };
  }
  if (!dispatchedAll) return truncatedOutcome(state, "bounds-exceeded");
  return {
    status: "completed",
    applicable: true,
    items: [...state.items],
    enumeratedItemKeys: [...state.enumeratedItemKeys],
    failures: [...state.failures],
    progress: snapshotProgress(state.progress),
  };
}

function buildRunState<TRef extends AtlassianSyncItemRef>(
  deps: RunAtlassianSyncFetchDeps<TRef>,
): FetchRunState<TRef> {
  const now = deps.now ?? ((): number => Date.now());
  const deadlineAt = now() + deps.bounds.maxDurationMs;
  const budget: MutableRunBudget = { remainingBytes: deps.bounds.maxBytes };
  const http = createBudgetedRetryingPort({
    http: deps.http,
    budget,
    deadlineAt,
    now,
    sleep: deps.sleep ?? defaultSleep,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  return {
    deps,
    context: {
      http,
      signal: deps.signal,
      deadlineExceeded: (): boolean => now() > deadlineAt,
      maxItems: deps.bounds.maxItems,
    },
    now,
    progress: {
      enumeratedItems: 0,
      fetchedItems: 0,
      indexedItems: 0,
      skippedItems: 0,
      failedItems: 0,
    },
    items: [],
    failures: [],
    enumeratedItemKeys: [],
    fatalReason: undefined,
  };
}

type EnumerationStep<TRef extends AtlassianSyncItemRef> =
  | { readonly kind: "refs"; readonly refs: readonly TRef[] }
  | { readonly kind: "terminal"; readonly outcome: AtlassianSyncFetchOutcome };

async function enumerateWithinBounds<TRef extends AtlassianSyncItemRef>(
  state: FetchRunState<TRef>,
): Promise<EnumerationStep<TRef>> {
  const enumeration = await state.deps.source.enumerate(state.context);
  if (!enumeration.ok) {
    return {
      kind: "terminal",
      outcome: {
        status: "failed",
        applicable: false,
        reason: enumeration.reason,
        progress: snapshotProgress(state.progress),
      },
    };
  }
  // Fail closed on truncated coverage: more items than the run budget admits (either the adapter
  // stopped early or the ref list overflows maxItems) means the run cannot represent the full
  // approved scope, so it must not be applied.
  state.progress.enumeratedItems = enumeration.refs.length;
  emitProgress(state);
  if (!enumeration.complete || enumeration.refs.length > state.deps.bounds.maxItems) {
    return { kind: "terminal", outcome: truncatedOutcome(state, "bounds-exceeded") };
  }
  state.enumeratedItemKeys.push(...enumeration.refs.map((ref) => ref.itemKey));
  return { kind: "refs", refs: enumeration.refs };
}

// ─── Entry point ───────────────────────────────────────────────────────────────
// One bounded enumerate→fetch→normalize pass. Cancellation is honored between page boundaries;
// budget/deadline exhaustion mid-run terminates with a truncated (not applicable) outcome.
export async function runAtlassianSyncFetch<TRef extends AtlassianSyncItemRef>(
  deps: RunAtlassianSyncFetchDeps<TRef>,
): Promise<AtlassianSyncFetchOutcome> {
  const state = buildRunState(deps);
  try {
    if (cancelled(state)) return terminalOutcome(state, false);
    const enumerated = await enumerateWithinBounds(state);
    if (enumerated.kind === "terminal") {
      // An abort tears down the in-flight request, which then classifies as a transport failure;
      // the cancellation verdict must win over that secondary classification.
      return cancelled(state)
        ? { status: "cancelled", applicable: false, progress: snapshotProgress(state.progress) }
        : enumerated.outcome;
    }
    const refs = enumerated.refs;
    const dispatchedBefore = state.progress.fetchedItems + state.progress.skippedItems;
    await fetchAllItems(state, refs);
    const terminalPerItemOutcomes =
      state.progress.fetchedItems + state.progress.skippedItems - dispatchedBefore;
    return terminalOutcome(state, terminalPerItemOutcomes >= refs.length);
  } catch (error) {
    if (error instanceof AtlassianSyncBudgetExhausted) {
      return cancelled(state)
        ? { status: "cancelled", applicable: false, progress: snapshotProgress(state.progress) }
        : truncatedOutcome(state, error.reason);
    }
    throw error;
  }
}
