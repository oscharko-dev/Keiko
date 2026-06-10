// Issue #541 (Epic #532) — Activity-state stream hook.
//
// Exposes a Map<relationshipId, RelationshipActivityState> derived from the
// `GET /api/relationships/events` SSE stream (relationship-handlers.ts route 11).
// Falls back to polling when EventSource is unavailable or errors out.
//
// Privacy invariants (retention-and-privacy.md §3.4 / §5.1):
//   • Activity state is NEVER persisted — Map is in-memory only.
//   • Every inbound SSE message is stripped to the allowlist: kind, id, state, timestamp, count.
//   • Forbidden keys (RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS) cause the message
//     to be dropped entirely if they appear in any key at any depth.
//   • No fetch, no write, no node:sqlite — presentation only.
//
// Bounded fan-in (activity-state.md §5.3):
//   N_VISIBLE = 25 concurrent animated states max.
//   Beyond 25 the caller receives animate=false for the excess entries; the Map still has
//   all states so the list panel can render the "+N more" aggregate.
//
// Motion (activity-visualization.md §"Motion rules"):
//   • Reads window.matchMedia("(prefers-reduced-motion: reduce)") on mount.
//   • Exposes `animate: boolean` — callers gate animation on this flag.
//   • `disable()` clears the animate flag (user-level opt-out; used by tests).
//
// Cleanup: SSE connection closed and all timers cleared on unmount.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RelationshipActivityState } from "@oscharko-dev/keiko-contracts";
import { RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS } from "@oscharko-dev/keiko-contracts";

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Max concurrent animated badges (activity-state.md §5.3). */
export const N_VISIBLE = 25;

/** Activity window length in ms (activity-state.md §5.2). */
export const ACTIVITY_WINDOW_MS = 60_000;

/** High-throughput threshold (activity-state.md §5.4). */
export const N_THROUGHPUT = 50;

/** Minimum ms between state changes per badge (activity-visualization.md §"No flashing"). */
const MIN_STATE_INTERVAL_MS = 2_000;

/** SSE endpoint served by relationship-handlers.ts route 11. */
const EVENTS_URL = "/api/relationships/events";

/** Polling fallback interval in ms. */
const POLL_INTERVAL_MS = 5_000;

/** Hard cap for in-memory activity tracking. */
const MAX_TRACKED_RELATIONSHIPS = 512;

// ─── SSE event payload allowlist ───────────────────────────────────────────────
// Only these keys are accepted from inbound SSE data. Everything else is dropped.
// (activity-state.md §4 / retention-and-privacy.md §5.1)

const ALLOWED_PAYLOAD_KEYS = new Set<string>(["kind", "id", "state", "timestamp", "count"]);

// ─── Forbidden-key rejector ────────────────────────────────────────────────────
// Reuses RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS from keiko-contracts.
// Returns true when a key (lowercased) contains any forbidden substring.

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return RELATIONSHIP_FORBIDDEN_METADATA_KEY_SUBSTRINGS.some((sub: string) => lower.includes(sub));
}

// Recursively checks every key at every depth in an object.
function containsForbiddenKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (isForbiddenKey(key)) return true;
    if (containsForbiddenKey((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

// ─── Parsed activity event (post-strip) ───────────────────────────────────────

interface ActivityEvent {
  readonly kind: string;
  readonly id: string;
  readonly state: RelationshipActivityState;
  readonly timestamp: number;
  readonly count?: number | undefined;
}

function isValidActivityState(v: unknown): v is RelationshipActivityState {
  return (
    v === "inactive" ||
    v === "queued" ||
    v === "active" ||
    v === "processing" ||
    v === "completed" ||
    v === "failed" ||
    v === "blocked" ||
    v === "degraded" ||
    v === "high-throughput"
  );
}

/**
 * Strip inbound SSE data to the allowlist and validate shape.
 * Returns null if the message is malformed or contains any forbidden key.
 */
function parseActivityEvent(raw: unknown): ActivityEvent | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // Forbidden-key check at every depth before doing anything else.
  if (containsForbiddenKey(raw)) return null;

  // Strip to allowlist.
  const stripped: Record<string, unknown> = {};
  for (const key of ALLOWED_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      stripped[key] = obj[key];
    }
  }

  if (typeof stripped["id"] !== "string" || stripped["id"].length === 0) return null;
  if (!isValidActivityState(stripped["state"])) return null;
  if (typeof stripped["timestamp"] !== "number") return null;

  return {
    kind: typeof stripped["kind"] === "string" ? stripped["kind"] : "relationship:activity",
    id: stripped["id"],
    state: stripped["state"],
    timestamp: stripped["timestamp"],
    count: typeof stripped["count"] === "number" ? stripped["count"] : undefined,
  };
}

// ─── Hook state ────────────────────────────────────────────────────────────────

export interface RelationshipActivityStreamState {
  /** Current activity state per relationship id. */
  readonly activityMap: ReadonlyMap<string, RelationshipActivityState>;
  /**
   * Throughput count per relationship id (for high-throughput badges).
   * Only populated for relationships in state "high-throughput".
   */
  readonly throughputMap: ReadonlyMap<string, number>;
  /**
   * True when animations are permitted (prefers-reduced-motion is false AND
   * disable() has not been called). Consumers MUST gate all CSS animations on
   * this flag.
   */
  readonly animate: boolean;
  /** Disable all animations (user-level opt-out; also used by tests). */
  disable(): void;
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Subscribe to the relationship activity SSE stream and expose a bounded
 * in-memory state map.
 *
 * @param workspaceId  Scope filter — only events matching this workspace are
 *   applied. Pass undefined to accept all events (e.g. in tests).
 */
export function useRelationshipActivityStream(
  workspaceId?: string,
): RelationshipActivityStreamState {
  // Mutable ref map for last-seen timestamp per id (for MIN_STATE_INTERVAL_MS debounce).
  const lastUpdateRef = useRef<Map<string, number>>(new Map());
  const visibleRef = useRef<boolean>(typeof document === "undefined" || document.visibilityState === "visible");

  // React state: activity map (id → state) and throughput counts.
  const [activityMap, setActivityMap] = useState<ReadonlyMap<string, RelationshipActivityState>>(
    new Map(),
  );
  const [throughputMap, setThroughputMap] = useState<ReadonlyMap<string, number>>(new Map());
  const activityMapRef = useRef<ReadonlyMap<string, RelationshipActivityState>>(new Map());
  const throughputMapRef = useRef<ReadonlyMap<string, number>>(new Map());

  // animate: true when reduced-motion is NOT requested and disable() has not been called.
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  const [userDisabled, setUserDisabled] = useState(false);

  const animate = !reducedMotion && !userDisabled;

  const disable = useCallback((): void => {
    setUserDisabled(true);
  }, []);

  const pruneState = useCallback((now: number, keepInactive: boolean): void => {
    const nextActivityMap = new Map(activityMapRef.current);
    const deletedIds = new Set<string>();
    const throughputIdsToClear = new Set<string>();
    let activityChanged = false;

    for (const [id, state] of nextActivityMap) {
      const last = lastUpdateRef.current.get(id) ?? 0;
      const age = now - last;

      if (age >= ACTIVITY_WINDOW_MS && state !== "inactive") {
        nextActivityMap.set(id, "inactive");
        throughputIdsToClear.add(id);
        activityChanged = true;
      }

      if (!keepInactive && age >= ACTIVITY_WINDOW_MS * 2) {
        nextActivityMap.delete(id);
        deletedIds.add(id);
        throughputIdsToClear.add(id);
        activityChanged = true;
      }
    }

    if (nextActivityMap.size > MAX_TRACKED_RELATIONSHIPS) {
      const evictionCandidates = Array.from(nextActivityMap.keys())
        .sort((left, right) => {
          const leftState = nextActivityMap.get(left);
          const rightState = nextActivityMap.get(right);
          if (leftState === "inactive" && rightState !== "inactive") return -1;
          if (leftState !== "inactive" && rightState === "inactive") return 1;
          return (lastUpdateRef.current.get(left) ?? 0) - (lastUpdateRef.current.get(right) ?? 0);
        })
        .slice(0, nextActivityMap.size - MAX_TRACKED_RELATIONSHIPS);

      for (const id of evictionCandidates) {
        nextActivityMap.delete(id);
        deletedIds.add(id);
        throughputIdsToClear.add(id);
        activityChanged = true;
      }
    }

    if (activityChanged) {
      activityMapRef.current = nextActivityMap;
      setActivityMap(nextActivityMap);
    }

    if (deletedIds.size > 0) {
      for (const id of deletedIds) {
        lastUpdateRef.current.delete(id);
      }
    }

    if (throughputIdsToClear.size > 0) {
      let throughputChanged = false;
      const nextThroughputMap = new Map(throughputMapRef.current);
      for (const id of throughputIdsToClear) {
        if (nextThroughputMap.delete(id)) throughputChanged = true;
      }
      if (throughputChanged) {
        throughputMapRef.current = nextThroughputMap;
        setThroughputMap(nextThroughputMap);
      }
    }
  }, []);

  // Track the MediaQueryList so we can remove the listener on cleanup.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent): void => {
      setReducedMotion(e.matches);
    };
    mql.addEventListener("change", handler);
    return (): void => {
      mql.removeEventListener("change", handler);
    };
  }, []);

  // ── Apply a parsed activity event ─────────────────────────────────────────
  const applyEvent = useCallback((event: ActivityEvent): void => {
    if (!visibleRef.current) return;

    const now = Date.now();
    const last = lastUpdateRef.current.get(event.id) ?? 0;

    // Per-badge minimum interval to avoid screen-reader thrashing
    // (activity-visualization.md §"No flashing thresholds").
    if (now - last < MIN_STATE_INTERVAL_MS) return;
    lastUpdateRef.current.set(event.id, now);

    setActivityMap((prev) => {
      const next = new Map(prev);
      next.set(event.id, event.state);
      activityMapRef.current = next;
      return next;
    });

    if (event.state === "high-throughput" && event.count !== undefined) {
      setThroughputMap((prev) => {
        const next = new Map(prev);
        next.set(event.id, event.count as number);
        throughputMapRef.current = next;
        return next;
      });
    } else {
      // Clear throughput count for non-high-throughput states.
      setThroughputMap((prev) => {
        if (!prev.has(event.id)) return prev;
        const next = new Map(prev);
        next.delete(event.id);
        throughputMapRef.current = next;
        return next;
      });
    }
  }, []);

  // ── Activity window expiry ─────────────────────────────────────────────────
  // Every T=60s, entries that have not been refreshed in that window revert to
  // "inactive" (activity-state.md §5.2 — idle relationships return to inactive).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const timer = setInterval(() => {
      if (!visibleRef.current) return;
      pruneState(Date.now(), false);
    }, ACTIVITY_WINDOW_MS / 4);

    return (): void => {
      clearInterval(timer);
    };
  }, [pruneState]);

  // ── Page visibility pause (activity-state.md §5.5) ────────────────────────
  // When the page is hidden, mark the epoch so window expiry works on resume.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = (): void => {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) {
        pruneState(Date.now(), true);
      }
    };
    visibleRef.current = document.visibilityState === "visible";
    document.addEventListener("visibilitychange", handler);
    return (): void => {
      document.removeEventListener("visibilitychange", handler);
    };
  }, [pruneState]);

  // ── SSE + polling fallback ─────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    let closed = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function handleRawData(data: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const event = parseActivityEvent(parsed);
      if (event === null) return;
      applyEvent(event);
    }

    function clearReconnectTimer(): void {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function closeStream(): void {
      es?.close();
      es = null;
    }

    function scheduleReconnect(): void {
      if (closed || reconnectTimer !== null || !visibleRef.current) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startSSE();
      }, POLL_INTERVAL_MS);
    }

    function startSSE(): void {
      if (closed || !visibleRef.current) return;

      const url =
        workspaceId !== undefined
          ? `${EVENTS_URL}?workspaceId=${encodeURIComponent(workspaceId)}`
          : EVENTS_URL;

      try {
        es = new EventSource(url);
      } catch {
        scheduleReconnect();
        return;
      }

      es.addEventListener("relationship:activity", (ev: MessageEvent<string>) => {
        handleRawData(ev.data);
      });

      // Generic message fallback (BFF may send as default event type)
      es.onmessage = (ev: MessageEvent<string>): void => {
        handleRawData(ev.data);
      };

      es.onerror = (): void => {
        if (closed) return;
        closeStream();
        scheduleReconnect();
      };
    }

    startSSE();

    const onVisibilityChange = (): void => {
      visibleRef.current = document.visibilityState === "visible";
      if (!visibleRef.current) {
        clearReconnectTimer();
        closeStream();
        return;
      }
      pruneState(Date.now(), true);
      if (es === null) startSSE();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    return (): void => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearReconnectTimer();
      closeStream();
    };
  }, [workspaceId, applyEvent, pruneState]);

  return {
    activityMap,
    throughputMap,
    animate,
    disable,
  };
}
