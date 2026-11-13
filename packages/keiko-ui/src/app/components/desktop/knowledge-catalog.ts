import type {
  OptionalWidgetTranslate as I18nTranslate,
  WidgetMessageKey as MessageKey,
} from "@/lib/optional-widget-i18n";
// The Knowledge Pod / Pod Set catalog behind the chat scope header (grounding picker + the pills
// naming each bound source). One module owns the shared cache, the refresh policy and the
// body-free diagnostics so the chat cannot drift from what the Knowledge Pods panel shows.
//
// Contract, in the order a customer hits it (1.1.13, Knowledge Pod "Indexed" in the panel but
// "unavailable" in a chat bound to it):
//  - The snapshot keeps EVERY Knowledge Pod the BFF lists, in every lifecycle state. A bound pod that
//    is still indexing, failed, or stale therefore still shows its name and its real state; only the
//    picker's selectable options are narrowed to `ready`.
//  - A window that stays open never keeps a stale answer: every picker open refreshes (the one
//    exception is the first open within seconds of the mount-time load, which that load already
//    answered), a window that regains focus/visibility refreshes once the snapshot is older than the
//    TTL, and while a bound source is not ready the catalog is re-read on a bounded backoff (never a
//    tight loop).
//  - A failed load is a failed load: it is surfaced as an error the caller can retry, never as an
//    empty "no ready pods" catalog, and it is reported through the client diagnostic sink.
//  - Every diagnostic is body-free: counts and closed identifiers, never a pod name or a path.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityLogErrorKind, CapsuleLifecycleState } from "@oscharko-dev/keiko-contracts";
import type { ClientKnowledgeCatalogRefresh } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { newClientCorrelationId, responseCorrelationIdOf } from "@/lib/bff-correlation";
import { useCodingAppSessionRedemptions } from "@/lib/coding-app-session-client";
import { bffRequestErrorKind } from "@/lib/http";

import {
  capsulesForKnowledgePodUi,
  capsuleSetsForKnowledgePodUi,
  fetchCapsules,
  fetchCapsuleSets,
  type CapsuleListEntry,
  type CapsuleSetListEntry,
} from "@/lib/local-knowledge-api";
import type { ChatLocalKnowledgeScope } from "@/lib/types";

export interface KnowledgeCatalogSnapshot {
  /** Every listed Knowledge Pod, in every lifecycle state (names and states, not just options). */
  readonly capsules: readonly CapsuleListEntry[];
  readonly capsuleSets: readonly CapsuleSetListEntry[];
  /** `null` when both lists loaded. */
  readonly loadError: unknown;
  /** Epoch milliseconds the request settled; `0` for the placeholder before any load. */
  readonly loadedAt: number;
}

export interface KnowledgeCatalog {
  readonly capsules: readonly CapsuleListEntry[];
  readonly capsuleSets: readonly CapsuleSetListEntry[];
  /** A deliberate (foreground) refresh is resolving. */
  readonly loading: boolean;
  /**
   * `loading`, while the last good snapshot is still being served: the known pods stay listed and
   * selectable, and only a refresh with nothing to show (first load, or after a failure) hides them.
   */
  readonly refreshing: boolean;
  /** The last foreground load's failure, `null` when it succeeded or a refresh is resolving. */
  readonly loadError: unknown;
  /** A deliberate refresh (the retry action). */
  readonly refresh: () => void;
  /** The grounding picker opened: refreshes, unless the mount-time load only just answered. */
  readonly refreshOnPickerOpen: () => void;
}

export interface BoundScopeAvailability {
  readonly bound: number;
  /** Bound sources the catalog does not list at all. */
  readonly missing: number;
  /** Bound Knowledge Pods that are listed but not `ready`. */
  readonly notReady: number;
}

const EMPTY_KNOWLEDGE_CATALOG: KnowledgeCatalogSnapshot = {
  capsules: [],
  capsuleSets: [],
  loadError: null,
  loadedAt: 0,
};
const NO_BOUND_SCOPES: BoundScopeAvailability = { bound: 0, missing: 0, notReady: 0 };

export const KNOWLEDGE_CATALOG_TTL_MS = 30_000;
const KNOWLEDGE_CATALOG_ERROR_TTL_MS = 5_000;
// The first picker open reuses a mount-time answer this young instead of asking again.
const FIRST_OPEN_REUSE_MS = 5_000;
// Bounded backoff while a bound source is not ready: at most six re-reads, at most one a minute.
// Focus/visibility and a picker open start a fresh bounded sequence; nothing polls forever.
export const KNOWLEDGE_CATALOG_RECOVERY_DELAYS_MS: readonly number[] = [
  5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
];

// A catalog read that outlasts this is aborted and ends as a retryable timeout: the picker never waits
// on a request nobody answers, and no later load joins one older than the bound (#4371).
export const KNOWLEDGE_CATALOG_REQUEST_TIMEOUT_MS = 10_000;

let cachedSnapshot: KnowledgeCatalogSnapshot | undefined;
// The newest snapshot that loaded without error, whatever its age: a new chat seeds its picker from
// it instead of starting empty while the refresh runs.
let lastGoodSnapshot: KnowledgeCatalogSnapshot | undefined;
let pendingLoad:
  { readonly promise: Promise<KnowledgeCatalogSnapshot>; readonly startedAt: number } | undefined;
// A cleared cache must not be repopulated by a request that started before the clear.
let cacheEpoch = 0;

function freshnessMs(snapshot: KnowledgeCatalogSnapshot): number {
  return snapshot.loadError === null ? KNOWLEDGE_CATALOG_TTL_MS : KNOWLEDGE_CATALOG_ERROR_TTL_MS;
}

function reusableSnapshot(now: number, maxAgeMs: number): KnowledgeCatalogSnapshot | undefined {
  if (cachedSnapshot === undefined) return undefined;
  const age = now - cachedSnapshot.loadedAt;
  return age < Math.min(freshnessMs(cachedSnapshot), maxAgeMs) ? cachedSnapshot : undefined;
}

// `catalog` is a failure that escaped the per-list handling (a request that could not even be made).
type CatalogList = "capsules" | "capsule-sets" | "catalog";

function reportCatalogLoadFailure(
  list: CatalogList,
  reason: unknown,
  errorKind: ActivityLogErrorKind = bffRequestErrorKind(reason),
  correlationId: string | undefined = correlationIdOf(reason),
): void {
  reportClientDiagnostic(`Keiko knowledge catalog load failed (list=${list}).`, {
    correlationId,
    errorKind,
    errorEvidence: clientErrorEvidence(reason),
  });
}

// One list of the catalog: its entries, or the failure that kept them out. A request that failed
// and a 200 whose body does not have the listed shape are both failures the caller can retry; the
// second used to throw out of the mapping and leave the picker loading with no error.
type CatalogListOutcome<T> =
  | { readonly failed: false; readonly entries: readonly T[] }
  | { readonly failed: true; readonly reason: unknown };

function settleCatalogList<Response, Entry>(
  list: CatalogList,
  result: PromiseSettledResult<Response>,
  toEntries: (response: Response) => readonly Entry[],
): CatalogListOutcome<Entry> {
  if (result.status !== "fulfilled") {
    reportCatalogLoadFailure(list, result.reason);
    return { failed: true, reason: result.reason };
  }
  try {
    return { failed: false, entries: toEntries(result.value) };
  } catch (error_) {
    // The mapping error carries no correlation of its own; the response it failed on does, so the
    // report still names the request whose body was error_ (PR #3678 review).
    const correlationId = responseCorrelationIdOf(result.value);
    reportCatalogLoadFailure(list, error_, "validation-failed", correlationId);
    return { failed: true, reason: error_ };
  }
}

async function fetchKnowledgeCatalogSnapshot(
  signal: AbortSignal,
): Promise<KnowledgeCatalogSnapshot> {
  const [capsuleResult, capsuleSetResult] = await Promise.allSettled([
    fetchCapsules({ includeKnowledgePods: true, signal }),
    fetchCapsuleSets({ includeKnowledgePods: true, signal }),
  ]);
  const loadedAt = Date.now();
  // The timeout already reported this load and ended it: the aborted requests add nothing.
  if (signal.aborted) return { ...EMPTY_KNOWLEDGE_CATALOG, loadError: signal.reason, loadedAt };
  // Both lists are settled and reported before either failure decides the snapshot, so a capsule
  // failure no longer hides a set-list failure.
  const capsules = settleCatalogList("capsules", capsuleResult, capsulesForKnowledgePodUi);
  const capsuleSets = settleCatalogList(
    "capsule-sets",
    capsuleSetResult,
    capsuleSetsForKnowledgePodUi,
  );
  if (capsules.failed) {
    return { ...EMPTY_KNOWLEDGE_CATALOG, loadError: capsules.reason, loadedAt };
  }
  return {
    capsules: capsules.entries,
    capsuleSets: capsuleSets.failed ? [] : capsuleSets.entries,
    loadError: capsuleSets.failed ? capsuleSets.reason : null,
    loadedAt,
  };
}

// The load never rejects: whatever escapes the per-list handling is reported and still ends as a
// retryable error snapshot, so a caller's `loading` always settles.
function failedCatalogSnapshot(reason: unknown): KnowledgeCatalogSnapshot {
  reportCatalogLoadFailure("catalog", reason);
  return { ...EMPTY_KNOWLEDGE_CATALOG, loadError: reason, loadedAt: Date.now() };
}

function timeoutError(): DOMException {
  return new DOMException("The Knowledge Pod catalog did not answer in time.", "TimeoutError");
}

// One bounded request: the fetches carry an abort signal, and the load itself settles at the bound
// even when a transport ignores that signal, so a pending load can never outlive it.
function boundedCatalogLoad(): Promise<KnowledgeCatalogSnapshot> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<KnowledgeCatalogSnapshot>((resolve) => {
    timer = setTimeout(() => {
      const reason = timeoutError();
      controller.abort(reason);
      resolve(failedCatalogSnapshot(reason));
    }, KNOWLEDGE_CATALOG_REQUEST_TIMEOUT_MS);
  });
  return Promise.race([fetchKnowledgeCatalogSnapshot(controller.signal), timedOut])
    .catch(failedCatalogSnapshot)
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
}

function cacheSnapshot(snapshot: KnowledgeCatalogSnapshot): void {
  if (cachedSnapshot === undefined || snapshot.loadedAt >= cachedSnapshot.loadedAt) {
    cachedSnapshot = snapshot;
  }
  if (snapshot.loadError === null) lastGoodSnapshot = snapshot;
}

/**
 * Loads the shared catalog. A snapshot younger than `maxAgeMs` (and than its own freshness window)
 * is reused; otherwise one request is made and every simultaneous caller joins it, so several chat
 * windows never multiply the request. A pending load older than the request bound is never joined.
 */
export function loadKnowledgeCatalog(
  maxAgeMs: number = KNOWLEDGE_CATALOG_TTL_MS,
): Promise<KnowledgeCatalogSnapshot> {
  const cached = reusableSnapshot(Date.now(), maxAgeMs);
  if (cached !== undefined) return Promise.resolve(cached);
  if (
    pendingLoad !== undefined &&
    Date.now() - pendingLoad.startedAt < KNOWLEDGE_CATALOG_REQUEST_TIMEOUT_MS
  ) {
    return pendingLoad.promise;
  }
  const epoch = cacheEpoch;
  const promise: Promise<KnowledgeCatalogSnapshot> = boundedCatalogLoad()
    .then((snapshot) => {
      if (epoch === cacheEpoch) cacheSnapshot(snapshot);
      return snapshot;
    })
    .finally(() => {
      if (epoch === cacheEpoch && pendingLoad?.promise === promise) pendingLoad = undefined;
    });
  pendingLoad = { promise, startedAt: Date.now() };
  return promise;
}

// A grounding-picker open is a deliberate catalog lifecycle event, distinct from gateway
// configuration changes. It bypasses the read-only catalog's TTL; simultaneous chat windows still
// share the in-flight request.
function reloadKnowledgeCatalog(): Promise<KnowledgeCatalogSnapshot> {
  return loadKnowledgeCatalog(0);
}

// The previous server's pods must not be offered to a person on a new session or a new server
// process: the cache, the last good snapshot and any pending load are dropped together.
function discardKnowledgeCatalogCache(): void {
  cacheEpoch += 1;
  cachedSnapshot = undefined;
  lastGoodSnapshot = undefined;
  pendingLoad = undefined;
}

export function clearKnowledgeCatalogCacheForTests(): void {
  discardKnowledgeCatalogCache();
}

export function isReadyCapsule(capsule: CapsuleListEntry): boolean {
  return capsule.lifecycleState === "ready";
}

// A ready pod is named bare, so it has no state label.
const CAPSULE_STATE_LABEL_KEYS: Readonly<
  Record<Exclude<CapsuleLifecycleState, "ready">, MessageKey>
> = {
  draft: "chat.grounding.state.draft",
  indexing: "chat.grounding.state.indexing",
  stale: "chat.grounding.state.stale",
  deleting: "chat.grounding.state.deleting",
  error: "chat.grounding.state.error",
};

/**
 * The name a bound Knowledge Pod carries in the chat: the bare name while it is ready, otherwise
 * the name plus its real state ("test (indexing)"), so a pod that exists never shows as an id.
 */
export function capsuleNameWithState(
  capsule: CapsuleListEntry,
  t: I18nTranslate,
  prefix?: (name: string) => string,
): string {
  const label = prefix === undefined ? capsule.displayName : prefix(capsule.displayName);
  const state = capsule.lifecycleState;
  if (state === "ready") return label;
  return t("chat.grounding.withState", { label, state: t(CAPSULE_STATE_LABEL_KEYS[state]) });
}

function scopeKey(scope: ChatLocalKnowledgeScope): string {
  return scope.kind === "capsule" ? `capsule:${scope.capsuleId}` : `set:${scope.capsuleSetId}`;
}

/** How the catalog answers for the sources a chat is bound to; never reads a name or a path. */
export function boundScopeAvailability(
  scopes: readonly ChatLocalKnowledgeScope[],
  snapshot: KnowledgeCatalogSnapshot,
): BoundScopeAvailability {
  if (scopes.length === 0 || snapshot.loadedAt === 0) return NO_BOUND_SCOPES;
  const states = new Map(snapshot.capsules.map((capsule) => [String(capsule.id), capsule]));
  const setIds = new Set(snapshot.capsuleSets.map((capsuleSet) => String(capsuleSet.id)));
  let missing = 0;
  let notReady = 0;
  for (const scope of scopes) {
    if (scope.kind === "capsule") {
      const capsule = states.get(String(scope.capsuleId));
      if (capsule === undefined) missing += 1;
      else if (!isReadyCapsule(capsule)) notReady += 1;
    } else if (!setIds.has(String(scope.capsuleSetId))) {
      missing += 1;
    }
  }
  return { bound: scopes.length, missing, notReady };
}

/** Whether the chat is bound to something the catalog cannot currently vouch for. */
export function boundScopesNeedRecovery(
  availability: BoundScopeAvailability,
  snapshot: KnowledgeCatalogSnapshot,
): boolean {
  if (availability.bound === 0) return false;
  return snapshot.loadError !== null || availability.missing + availability.notReady > 0;
}

function pageIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

// A refresh that outlasts this is reported (body-free, closed outcome and duration bucket): the
// picker no longer waits on it, but the time the BFF took to answer stays reconstructable, and so
// does a request a later refresh superseded.
const SLOW_REFRESH_REPORT_MS = 1_000;
const SLOW_REFRESH_BUCKETS_MS: readonly (readonly [
  number,
  ClientKnowledgeCatalogRefresh["duration"],
])[] = [
  [10_000, "10s-plus"],
  [5_000, "5s-10s"],
  [SLOW_REFRESH_REPORT_MS, "1s-5s"],
];

function reportSlowRefresh(
  startedAt: number,
  outcome: ClientKnowledgeCatalogRefresh["outcome"],
): void {
  const elapsed = Date.now() - startedAt;
  const duration = SLOW_REFRESH_BUCKETS_MS.find(([floor]) => elapsed >= floor)?.[1];
  if (duration === undefined) return;
  reportClientDiagnostic("Keiko knowledge catalog refresh settled.", {
    correlationId: newClientCorrelationId(),
    knowledgeCatalogRefresh: { outcome, duration },
  });
}

// A transient background failure must not blank a catalog the person is already using.
function keepLastGoodSnapshot(
  previous: KnowledgeCatalogSnapshot,
  next: KnowledgeCatalogSnapshot,
): KnowledgeCatalogSnapshot {
  if (next.loadError !== null && previous.loadError === null && previous.loadedAt > 0) {
    return previous;
  }
  return next;
}

// A refresh that timed out says nothing about the pods the person already has: the last good
// snapshot stays on offer and the next open retries. Any other failure is shown as a failure.
function keepSnapshotOnTimeout(
  previous: KnowledgeCatalogSnapshot,
  next: KnowledgeCatalogSnapshot,
): KnowledgeCatalogSnapshot {
  const timedOut = next.loadError instanceof DOMException && next.loadError.name === "TimeoutError";
  return timedOut ? keepLastGoodSnapshot(previous, next) : next;
}

// Every open refreshes, except the first one within seconds of the mount-time load that already
// answered it: a deliberate reopen is a catalog lifecycle event and always asks again.
function usePickerOpenRefresh(loadedAt: number, refresh: () => void): () => void {
  const pickerOpenedRef = useRef(false);
  return useCallback((): void => {
    const firstOpen = !pickerOpenedRef.current;
    pickerOpenedRef.current = true;
    if (firstOpen && loadedAt > 0 && Date.now() - loadedAt < FIRST_OPEN_REUSE_MS) return;
    refresh();
  }, [loadedAt, refresh]);
}

interface CatalogSnapshotState {
  readonly snapshot: KnowledgeCatalogSnapshot;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly refresh: () => void;
  readonly refreshOnPickerOpen: () => void;
  readonly refreshInBackground: (maxAgeMs: number) => void;
}

// What a mounting hook starts from, and how it then refreshes. Known pods win: a cache too old to
// reuse, or a failed one, still seeds the picker with the newest good snapshot, so its pods are
// offered at once instead of an empty, disabled picker or an error (#4371). A failed cache is shown
// as the refresh state: the retry runs in the foreground over the pods the person already has.
type CatalogSeed =
  | { readonly snapshot: undefined; readonly refresh: "foreground" }
  | {
      readonly snapshot: KnowledgeCatalogSnapshot;
      readonly refresh: "none" | "background" | "foreground";
    };

function catalogSeed(): CatalogSeed {
  const cached = reusableSnapshot(Date.now(), KNOWLEDGE_CATALOG_TTL_MS);
  if (cached?.loadError === null) {
    return { snapshot: cached, refresh: "none" };
  }
  if (lastGoodSnapshot !== undefined) {
    return {
      snapshot: lastGoodSnapshot,
      refresh: cached === undefined ? "background" : "foreground",
    };
  }
  return cached === undefined
    ? { snapshot: undefined, refresh: "foreground" }
    : { snapshot: cached, refresh: "none" };
}

function refreshOutcome(
  current: boolean,
  next: KnowledgeCatalogSnapshot,
): ClientKnowledgeCatalogRefresh["outcome"] {
  if (!current) return "superseded";
  return next.loadError === null ? "ok" : "failed";
}

// A foreground refresh settled: report a slow one, and apply it unless a later one replaced it.
function settleForegroundRefresh(
  startedAt: number,
  next: KnowledgeCatalogSnapshot,
  current: boolean,
  apply: (snapshot: (previous: KnowledgeCatalogSnapshot) => KnowledgeCatalogSnapshot) => void,
): boolean {
  reportSlowRefresh(startedAt, refreshOutcome(current, next));
  if (current) apply((previous) => keepSnapshotOnTimeout(previous, next));
  return current;
}

// A pairing, a restore or a re-inspection of the app session (the page's own signal for a lost or
// replaced session, and so for a restarted server) drops what the previous server answered. Every
// window reacts to the same change, but only the first one drops and re-reads.
let discardedForRedemption = 0;
function useDiscardOnSessionChange(
  applyForeground: (load: () => Promise<KnowledgeCatalogSnapshot>) => void,
  setSnapshot: (snapshot: KnowledgeCatalogSnapshot) => void,
): void {
  const redemptions = useCodingAppSessionRedemptions();
  const seenRef = useRef(redemptions);
  useEffect(() => {
    if (seenRef.current === redemptions) return;
    seenRef.current = redemptions;
    if (discardedForRedemption !== redemptions) {
      discardedForRedemption = redemptions;
      discardKnowledgeCatalogCache();
    }
    setSnapshot(EMPTY_KNOWLEDGE_CATALOG);
    applyForeground(loadKnowledgeCatalog);
  }, [redemptions, applyForeground, setSnapshot]);
}

function useCatalogSnapshotState(): CatalogSnapshotState {
  const seed = useRef(catalogSeed()).current;
  const mountedRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const [snapshot, setSnapshot] = useState<KnowledgeCatalogSnapshot>(
    seed.snapshot ?? EMPTY_KNOWLEDGE_CATALOG,
  );
  const [loading, setLoading] = useState(seed.refresh === "foreground");

  const applyForeground = useCallback((load: () => Promise<KnowledgeCatalogSnapshot>): void => {
    requestGenerationRef.current += 1;
    const requestGeneration = requestGenerationRef.current;
    setLoading(true);
    const startedAt = Date.now();
    void load().then((next) => {
      const current = mountedRef.current && requestGeneration === requestGenerationRef.current;
      if (settleForegroundRefresh(startedAt, next, current, setSnapshot)) setLoading(false);
    });
  }, []);

  const refreshInBackground = useCallback((maxAgeMs: number): void => {
    // A foreground request that starts later supersedes this one.
    const requestGeneration = requestGenerationRef.current;
    void loadKnowledgeCatalog(maxAgeMs).then((next) => {
      if (!mountedRef.current || requestGeneration !== requestGenerationRef.current) return;
      setSnapshot((previous) => keepLastGoodSnapshot(previous, next));
    });
  }, []);

  useEffect(() => {
    if (seed.refresh === "foreground") applyForeground(reloadKnowledgeCatalog);
    else if (seed.refresh === "background") refreshInBackground(KNOWLEDGE_CATALOG_TTL_MS);
  }, [applyForeground, refreshInBackground, seed]);

  useDiscardOnSessionChange(applyForeground, setSnapshot);

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  const refresh = useCallback((): void => {
    applyForeground(reloadKnowledgeCatalog);
  }, [applyForeground]);

  const refreshOnPickerOpen = usePickerOpenRefresh(snapshot.loadedAt, refresh);

  // Only a good snapshot may keep standing in for the refresh: a failed one lists nothing.
  const refreshing = loading && snapshot.loadedAt > 0 && snapshot.loadError === null;
  return { snapshot, loading, refreshing, refresh, refreshOnPickerOpen, refreshInBackground };
}

function scheduleRecoveryRefreshes(refresh: (maxAgeMs: number) => void): () => void {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const delay = KNOWLEDGE_CATALOG_RECOVERY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    timer = setTimeout(() => {
      // A hidden page waits: regaining visibility starts a fresh bounded sequence.
      if (!pageIsVisible()) return;
      attempt += 1;
      refresh(KNOWLEDGE_CATALOG_ERROR_TTL_MS);
      arm();
    }, delay);
  };
  arm();
  return (): void => {
    if (timer !== undefined) clearTimeout(timer);
  };
}

function useBoundScopeRecovery(
  needsRecovery: boolean,
  scopeSignature: string,
  refreshInBackground: (maxAgeMs: number) => void,
): void {
  const needsRecoveryRef = useRef(needsRecovery);
  const [resumeCount, setResumeCount] = useState(0);

  useEffect(() => {
    needsRecoveryRef.current = needsRecovery;
  }, [needsRecovery]);

  // Focus and visibility: a window left open for hours re-reads once its snapshot is stale, and
  // sooner while a bound source is not ready.
  useEffect(() => {
    const resume = (): void => {
      if (!pageIsVisible()) return;
      const pending = needsRecoveryRef.current;
      refreshInBackground(pending ? KNOWLEDGE_CATALOG_ERROR_TTL_MS : KNOWLEDGE_CATALOG_TTL_MS);
      if (pending) setResumeCount((count) => count + 1);
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return (): void => {
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refreshInBackground]);

  useEffect(() => {
    if (!needsRecovery) return undefined;
    return scheduleRecoveryRefreshes(refreshInBackground);
  }, [needsRecovery, scopeSignature, resumeCount, refreshInBackground]);
}

// One body-free line per availability episode: counts only, never a name, path or id. A distinct
// picture reports once; the same picture reports again only after a healthy interval between.
function useCatalogAvailabilityDiagnostic(
  snapshot: KnowledgeCatalogSnapshot,
  availability: BoundScopeAvailability,
): void {
  const reportedRef = useRef("");
  const podCount = snapshot.capsules.length;
  const readyCount = snapshot.capsules.filter(isReadyCapsule).length;
  const setCount = snapshot.capsuleSets.length;
  const { bound, missing, notReady } = availability;
  const loaded = snapshot.loadedAt > 0 && snapshot.loadError === null;
  useEffect(() => {
    const boundUnavailable = bound > 0 && missing + notReady > 0;
    const noReadyPod = podCount > 0 && readyCount === 0;
    if (!loaded) return;
    if (!(boundUnavailable || noReadyPod)) {
      // A healthy catalog ends the episode: the same counts recurring later are a new episode.
      reportedRef.current = "";
      return;
    }
    const knowledgeCatalog = {
      podCount,
      readyPodCount: readyCount,
      setCount,
      boundCount: bound,
      missingCount: missing,
      notReadyCount: notReady,
    };
    const picture = JSON.stringify(knowledgeCatalog);
    if (reportedRef.current === picture) return;
    reportedRef.current = picture;
    reportClientDiagnostic("Keiko knowledge catalog offers no usable pod.", { knowledgeCatalog });
  }, [loaded, podCount, readyCount, setCount, bound, missing, notReady]);
}

export function useKnowledgeCatalog(
  boundScopes: readonly ChatLocalKnowledgeScope[],
): KnowledgeCatalog {
  const { snapshot, loading, refreshing, refresh, refreshOnPickerOpen, refreshInBackground } =
    useCatalogSnapshotState();
  const availability = useMemo(
    () => boundScopeAvailability(boundScopes, snapshot),
    [boundScopes, snapshot],
  );
  const scopeSignature = boundScopes.map(scopeKey).join(" ");
  const needsRecovery = boundScopesNeedRecovery(availability, snapshot);
  useBoundScopeRecovery(needsRecovery, scopeSignature, refreshInBackground);
  useCatalogAvailabilityDiagnostic(snapshot, availability);
  return {
    capsules: snapshot.capsules,
    capsuleSets: snapshot.capsuleSets,
    loading,
    refreshing,
    // A refresh in flight clears the previous failure, exactly as it clears the previous options.
    loadError: loading ? null : snapshot.loadError,
    refresh,
    refreshOnPickerOpen,
  };
}
