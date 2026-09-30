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
import type { CapsuleLifecycleState } from "@oscharko-dev/keiko-contracts";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import type { I18nTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
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
  /** A deliberate (foreground) refresh is resolving; options must not read as current meanwhile. */
  readonly loading: boolean;
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

let cachedSnapshot: KnowledgeCatalogSnapshot | undefined;
let pendingLoad: Promise<KnowledgeCatalogSnapshot> | undefined;
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

function reportCatalogLoadFailure(list: "capsules" | "capsule-sets", reason: unknown): void {
  reportClientDiagnostic(`Keiko knowledge catalog load failed (list=${list}).`, {
    correlationId: correlationIdOf(reason),
    errorKind: bffRequestErrorKind(reason),
    errorEvidence: clientErrorEvidence(reason),
  });
}

async function fetchKnowledgeCatalogSnapshot(): Promise<KnowledgeCatalogSnapshot> {
  const [capsuleResult, capsuleSetResult] = await Promise.allSettled([
    fetchCapsules({ includeKnowledgePods: true }),
    fetchCapsuleSets({ includeKnowledgePods: true }),
  ]);
  const loadedAt = Date.now();
  if (capsuleResult.status !== "fulfilled") {
    reportCatalogLoadFailure("capsules", capsuleResult.reason);
    return { ...EMPTY_KNOWLEDGE_CATALOG, loadError: capsuleResult.reason, loadedAt };
  }
  if (capsuleSetResult.status !== "fulfilled") {
    reportCatalogLoadFailure("capsule-sets", capsuleSetResult.reason);
  }
  return {
    capsules: capsulesForKnowledgePodUi(capsuleResult.value),
    capsuleSets:
      capsuleSetResult.status === "fulfilled"
        ? capsuleSetsForKnowledgePodUi(capsuleSetResult.value)
        : [],
    loadError: capsuleSetResult.status === "fulfilled" ? null : capsuleSetResult.reason,
    loadedAt,
  };
}

/**
 * Loads the shared catalog. A snapshot younger than `maxAgeMs` (and than its own freshness window)
 * is reused; otherwise one request is made and every simultaneous caller joins it, so several chat
 * windows never multiply the request.
 */
export function loadKnowledgeCatalog(
  maxAgeMs: number = KNOWLEDGE_CATALOG_TTL_MS,
): Promise<KnowledgeCatalogSnapshot> {
  const cached = reusableSnapshot(Date.now(), maxAgeMs);
  if (cached !== undefined) return Promise.resolve(cached);
  if (pendingLoad !== undefined) return pendingLoad;
  const epoch = cacheEpoch;
  const request = fetchKnowledgeCatalogSnapshot()
    .then((snapshot) => {
      if (epoch === cacheEpoch) cachedSnapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      if (epoch === cacheEpoch) pendingLoad = undefined;
    });
  pendingLoad = request;
  return request;
}

// A grounding-picker open is a deliberate catalog lifecycle event, distinct from gateway
// configuration changes. It bypasses the read-only catalog's TTL; simultaneous chat windows still
// share the in-flight request.
function reloadKnowledgeCatalog(): Promise<KnowledgeCatalogSnapshot> {
  return loadKnowledgeCatalog(0);
}

export function clearKnowledgeCatalogCacheForTests(): void {
  cacheEpoch += 1;
  cachedSnapshot = undefined;
  pendingLoad = undefined;
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
  readonly refresh: () => void;
  readonly refreshOnPickerOpen: () => void;
  readonly refreshInBackground: (maxAgeMs: number) => void;
}

function useCatalogSnapshotState(): CatalogSnapshotState {
  const initialSnapshotRef = useRef<KnowledgeCatalogSnapshot | undefined>(
    reusableSnapshot(Date.now(), KNOWLEDGE_CATALOG_TTL_MS),
  );
  const mountedRef = useRef(true);
  const requestGenerationRef = useRef(0);
  const [snapshot, setSnapshot] = useState<KnowledgeCatalogSnapshot>(
    initialSnapshotRef.current ?? EMPTY_KNOWLEDGE_CATALOG,
  );
  const [loading, setLoading] = useState(initialSnapshotRef.current === undefined);

  const applyForeground = useCallback((load: () => Promise<KnowledgeCatalogSnapshot>): void => {
    requestGenerationRef.current += 1;
    const requestGeneration = requestGenerationRef.current;
    setLoading(true);
    void load().then((next) => {
      if (!mountedRef.current || requestGeneration !== requestGenerationRef.current) return;
      setSnapshot(next);
      setLoading(false);
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
    if (initialSnapshotRef.current !== undefined) return;
    applyForeground(loadKnowledgeCatalog);
  }, [applyForeground]);

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

  return { snapshot, loading, refresh, refreshOnPickerOpen, refreshInBackground };
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

// One body-free line per distinct availability picture: counts only, never a name, path or id.
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
    if (!loaded || !(boundUnavailable || noReadyPod)) return;
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
  const { snapshot, loading, refresh, refreshOnPickerOpen, refreshInBackground } =
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
    // A refresh in flight clears the previous failure, exactly as it clears the previous options.
    loadError: loading ? null : snapshot.loadError,
    refresh,
    refreshOnPickerOpen,
  };
}
