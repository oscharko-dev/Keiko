// Issue #540 (Epic #532) — Relationship list panel.
//
// Fetches /api/relationships via the BFF client and renders a bounded list.
// Per-density caps (visual-density-rules.md):
//   Minimal:  visible edges = focused window only, animated badges ≤ 5
//   Standard: visible edges ≤ 25, animated badges ≤ 25
//   Dense:    visible edges ≤ 512, animated badges ≤ 25
//
// URL state: ?relType=, ?relLifecycle=, ?relActivity=, ?relSrcKind=, ?relTgtKind=
//   (visual-density-rules.md §"URL-state model")
// localStorage key: keiko.relationships.density (#63 precedent)
//
// Focus mode: toggled with F key; Escape restores (ui-blueprint.md §"Focus mode").
// Filter input focused with / key.
//
// WCAG 2.2 AA: <button aria-pressed>, 24×24 min touch target, focus-visible ring.
// Suspense boundary wrapping required (visual-density-rules.md §"Suspense boundary").

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type {
  RelationshipActivityState,
  RelationshipLifecycleState,
  RelationshipObjectKind,
  RelationshipType,
} from "@oscharko-dev/keiko-contracts";
import {
  RELATIONSHIP_LIFECYCLE_STATES,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_OBJECT_KINDS,
} from "@oscharko-dev/keiko-contracts";
import { listRelationships, RelationshipApiError } from "../../../../relationships/api";
import type { ApiRelationship } from "../../../../relationships/api";
import { RelationshipEdgeBadge } from "./RelationshipEdgeBadge";

// ─── Density mode helpers ──────────────────────────────────────────────────────

export type DensityMode = "minimal" | "standard" | "dense";

const DENSITY_STORAGE_KEY = "keiko.relationships.density";

// Per-density visible-edge cap (visual-density-rules.md §"Per-density rendering caps")
const DENSITY_EDGE_CAP: Record<DensityMode, number> = {
  minimal: 5, // focused-window edges; 5 as conservative upper bound per blueprint
  standard: 25,
  dense: 512,
};

// Concurrent animated-badge cap is 25 in ALL modes (visual-density-rules.md §"Why N_VISIBLE = 25")
const ANIMATION_CAP = 25;

function readDensityFromStorage(): DensityMode {
  if (typeof window === "undefined") return "minimal";
  try {
    const v = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    if (v === "minimal" || v === "standard" || v === "dense") return v;
  } catch {
    // localStorage unavailable — use default
  }
  return "minimal";
}

function writeDensityToStorage(mode: DensityMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, mode);
  } catch {
    // localStorage unavailable
  }
}

function hasModalDialogOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

// ─── Filter state (from URL params, caller-supplied) ──────────────────────────

export interface RelationshipFilters {
  readonly relType?: string | undefined;
  readonly relLifecycle?: string | undefined;
  readonly relActivity?: string | undefined;
  readonly relSrcKind?: string | undefined;
  readonly relTgtKind?: string | undefined;
  readonly relDensity?: string | undefined;
  readonly relFocus?: string | undefined;
}

// Parse comma-separated multi-value filter param (visual-density-rules.md §"URL serialization")
function splitFilter<T extends string>(raw: string | undefined, valid: readonly T[]): T[] {
  if (raw === undefined || raw.length === 0) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v): v is T => (valid as readonly string[]).includes(v));
}

function parseFilters(params: RelationshipFilters): {
  types: RelationshipType[];
  lifecycles: RelationshipLifecycleState[];
  activities: RelationshipActivityState[];
  srcKinds: RelationshipObjectKind[];
  tgtKinds: RelationshipObjectKind[];
} {
  const ACTIVITY_STATES = [
    "inactive",
    "queued",
    "active",
    "processing",
    "completed",
    "failed",
    "blocked",
    "degraded",
    "high-throughput",
  ] as const satisfies readonly RelationshipActivityState[];

  return {
    types: splitFilter(params.relType, RELATIONSHIP_TYPES),
    lifecycles: splitFilter(params.relLifecycle, RELATIONSHIP_LIFECYCLE_STATES),
    activities: splitFilter(params.relActivity, ACTIVITY_STATES),
    srcKinds: splitFilter(params.relSrcKind, RELATIONSHIP_OBJECT_KINDS),
    tgtKinds: splitFilter(params.relTgtKind, RELATIONSHIP_OBJECT_KINDS),
  };
}

// ─── Lifecycle → activity fallback (when the live SSE stream has no entry) ─────
// Must mirror the server's activityStateFromLifecycle (relationship-handlers.ts): a durable
// lifecycle is NOT a transient activity. Only blocked/stale lifecycles imply a derived activity;
// active/draft/archived/superseded/revoked are "inactive" until a live event says otherwise.
// Mapping active→active previously made every committed relationship falsely read "a model call
// is in progress" even on a fully idle workspace.
function lifecycleToActivity(lc: RelationshipLifecycleState): RelationshipActivityState {
  switch (lc) {
    case "blocked":
      return "blocked";
    case "stale":
      return "degraded";
    default:
      return "inactive";
  }
}

const ACTIVITY_PRIORITY: Record<RelationshipActivityState, number> = {
  "high-throughput": 0,
  processing: 1,
  active: 2,
  blocked: 3,
  failed: 4,
  degraded: 5,
  queued: 6,
  completed: 7,
  inactive: 8,
};

function resolveRelationshipActivity(
  id: string,
  lifecycle: RelationshipLifecycleState,
  activityMap: ReadonlyMap<string, RelationshipActivityState>,
): RelationshipActivityState {
  return activityMap.get(id) ?? lifecycleToActivity(lifecycle);
}

function formatActivityLabel(activity: RelationshipActivityState, count: number): string {
  const relationshipNoun = count === 1 ? "relationship" : "relationships";
  switch (activity) {
    case "high-throughput":
      return `${count} high-throughput ${relationshipNoun}`;
    default:
      return `${count} ${activity} ${relationshipNoun}`;
  }
}

function summarizeOverflowActivities(
  items: readonly ApiRelationship[],
  activityMap: ReadonlyMap<string, RelationshipActivityState>,
): string {
  const counts = new Map<RelationshipActivityState, number>();
  for (const item of items) {
    const activity = resolveRelationshipActivity(item.id, item.lifecycle, activityMap);
    counts.set(activity, (counts.get(activity) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const aPriority = ACTIVITY_PRIORITY[a[0]] ?? Number.MAX_SAFE_INTEGER;
      const bPriority = ACTIVITY_PRIORITY[b[0]] ?? Number.MAX_SAFE_INTEGER;
      return aPriority - bPriority;
    })
    .map(([activity, count]) => formatActivityLabel(activity, count))
    .join(", ");
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface RelationshipListPanelProps {
  /** Filter params from URL (from parent reading useSearchParams under Suspense). */
  readonly filters: RelationshipFilters;
  /** Currently selected relationship id. */
  readonly selectedId?: string | undefined;
  /** Called when a relationship row is selected. */
  readonly onSelect: (id: string) => void;
  /** Called when filter params change — parent updates URL. */
  readonly onFilterChange: (newParams: Partial<RelationshipFilters>) => void;
  /** Working directory / workspace scope for bounded queries. */
  readonly workspaceId?: string | undefined;
  /** Current transient activity state keyed by relationship id. */
  readonly activityMap?: ReadonlyMap<string, RelationshipActivityState>;
  /** Throughput counts for high-throughput badges. */
  readonly throughputMap?: ReadonlyMap<string, number>;
  /** True when motion is allowed for activity badges. */
  readonly animateBadges?: boolean;
  /** True when prefers-contrast: more is active. */
  readonly highContrast?: boolean;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function RelationshipListPanel({
  filters,
  selectedId,
  onSelect,
  onFilterChange,
  activityMap = new Map(),
  throughputMap = new Map(),
  animateBadges = true,
  highContrast = false,
}: RelationshipListPanelProps): ReactNode {
  // Density from localStorage; URL param ?relDensity= overrides for this session only
  const [density, setDensity] = useState<DensityMode>(() => {
    const urlOverride = filters.relDensity;
    if (urlOverride === "minimal" || urlOverride === "standard" || urlOverride === "dense") {
      return urlOverride;
    }
    return readDensityFromStorage();
  });

  // Focus mode
  const [focusMode, setFocusMode] = useState<boolean>(false);

  // Relationships
  const [items, setItems] = useState<readonly ApiRelationship[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [totalHint, setTotalHint] = useState<number | null>(null);

  // Filter input
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>(filters.relType ?? "");

  // Debounce timer for URL writes (visual-density-rules.md: ≥250 ms)
  const filterDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Density change ──────────────────────────────────────────────────────

  const changeDensity = useCallback(
    (mode: DensityMode) => {
      setDensity(mode);
      // URL override is NOT written to localStorage (visual-density-rules.md §"Forbidden patterns")
      if (filters.relDensity === undefined) {
        writeDensityToStorage(mode);
      }
    },
    [filters.relDensity],
  );

  useEffect(() => {
    const urlOverride = filters.relDensity;
    if (urlOverride === "minimal" || urlOverride === "standard" || urlOverride === "dense") {
      setDensity(urlOverride);
      return;
    }
    setDensity(readDensityFromStorage());
  }, [filters.relDensity]);

  useEffect(() => {
    setTypeFilter(filters.relType ?? "");
  }, [filters.relType]);

  // ─── Fetch relationships ─────────────────────────────────────────────────

  const fetchItems = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const parsed = parseFilters(filters);
      // API requires at least one selective filter (api-contract.md §4.3)
      const lifecycle =
        parsed.lifecycles.length === 1
          ? parsed.lifecycles[0]
          : ("active" as RelationshipLifecycleState);
      const type = parsed.types.length === 1 ? parsed.types[0] : undefined;
      const srcKind = parsed.srcKinds.length === 1 ? parsed.srcKinds[0] : undefined;
      const tgtKind = parsed.tgtKinds.length === 1 ? parsed.tgtKinds[0] : undefined;
      // At minimum pass lifecycle=active to satisfy selective-filter requirement
      const result = await listRelationships({
        lifecycle,
        type,
        sourceKind: srcKind,
        targetKind: tgtKind,
        limit: DENSITY_EDGE_CAP[density],
      });
      setItems(result.entries);
      setTruncated(result.truncated);
      setTotalHint(result.truncated ? result.entries.length + 1 : result.entries.length);
    } catch (err) {
      const msg =
        err instanceof RelationshipApiError
          ? err.message
          : "Unable to reach the local backend. Check that `keiko serve` is running.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [filters, density]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  // ─── Focus mode toggle ────────────────────────────────────────────────────
  // `F` toggles focus mode; `Escape` clears (ui-blueprint.md §"Focus mode").
  // We handle here rather than through useKeyboardShortcuts to avoid a global conflict
  // — the list panel is the owner of focus mode state.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent): void {
      if (hasModalDialogOpen()) return;
      // Only handle when no input is focused
      const active = document.activeElement;
      const isInput =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement;
      if (isInput) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        setFocusMode((prev) => !prev);
      }
      if (e.key === "Escape") {
        setFocusMode(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Filter input focused with `/` (ui-blueprint.md §"Filtering")
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent): void {
      if (hasModalDialogOpen()) return;
      const active = document.activeElement;
      const isInput =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement;
      if (!isInput && e.key === "/") {
        e.preventDefault();
        filterInputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ─── Filter input handler ─────────────────────────────────────────────────

  const handleTypeFilterChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setTypeFilter(val);
      if (filterDebounce.current !== null) clearTimeout(filterDebounce.current);
      filterDebounce.current = setTimeout(() => {
        onFilterChange({ relType: val.length > 0 ? val : undefined });
      }, 250);
    },
    [onFilterChange],
  );

  // ─── Derived rendering: apply focus-mode opacity dimming ─────────────────

  const visibleItems = useMemo(() => {
    const parsed = parseFilters(filters);
    const activityFiltered =
      parsed.activities.length === 0
        ? items
        : items.filter((item) =>
            parsed.activities.includes(
              resolveRelationshipActivity(item.id, item.lifecycle, activityMap),
            ),
          );
    // Density cap (visual-density-rules.md §"Per-density rendering caps")
    return activityFiltered.slice(0, DENSITY_EDGE_CAP[density]);
  }, [activityMap, density, filters, items]);

  // Animation cap: first 25 get animated badges; rest get static aggregate
  const animatedItems = visibleItems.slice(0, ANIMATION_CAP);
  const overflowItems = visibleItems.slice(ANIMATION_CAP);
  const extraAnimated = overflowItems.length;
  const overflowSummary =
    extraAnimated > 0 ? summarizeOverflowActivities(overflowItems, activityMap) : "";

  // ─── Accessible filter-change announcement ────────────────────────────────
  // aria-live="polite" on a visually-hidden region (ui-blueprint.md §"Filtering")
  const filterAnnouncement =
    truncated && totalHint !== null
      ? `Showing first ${String(visibleItems.length)} of ${String(totalHint)} relationships.`
      : `Showing ${String(visibleItems.length)} relationship${visibleItems.length !== 1 ? "s" : ""}.`;

  // ─── Row keyboard handler ─────────────────────────────────────────────────

  function onRowKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, id: string): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="tw-pad"
      data-testid="relationship-list-panel"
      // Focus mode adds data attribute for CSS opacity hook (visual-density-rules.md §"Focus mode")
      data-relationship-focus={focusMode ? "true" : undefined}
    >
      {/* Density switcher */}
      <div
        role="group"
        aria-label="Relationship density"
        style={{ display: "flex", gap: 4, marginBottom: 8 }}
      >
        {(["minimal", "standard", "dense"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className="arun-btn"
            aria-pressed={density === mode}
            onClick={() => changeDensity(mode)}
            style={{ textTransform: "capitalize", minWidth: 24, minHeight: 24 }}
          >
            {mode}
          </button>
        ))}
        <button
          type="button"
          className="arun-btn"
          aria-pressed={focusMode}
          onClick={() => setFocusMode((p) => !p)}
          title="Toggle focus mode (F)"
          aria-label={`Focus mode: ${focusMode ? "on" : "off"}`}
          style={{ minWidth: 24, minHeight: 24 }}
        >
          Focus
        </button>
      </div>

      {/* Filter input */}
      <div style={{ marginBottom: 8 }}>
        <label
          htmlFor="rel-type-filter"
          className="rb-row-k"
          style={{ display: "block", marginBottom: 2 }}
        >
          Filter by type (press / to focus)
        </label>
        <input
          id="rel-type-filter"
          ref={filterInputRef}
          type="text"
          value={typeFilter}
          onChange={handleTypeFilterChange}
          placeholder="e.g. reads-context"
          aria-label="Filter relationships by type"
          style={{
            width: "100%",
            background: "var(--inset)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "4px 8px",
            color: "var(--fg)",
            fontSize: 12,
          }}
        />
      </div>

      {/* Accessible live announcement of filter result (ui-blueprint.md §"Filtering") */}
      <div aria-live="polite" aria-atomic="true" className="visually-hidden">
        {filterAnnouncement}
      </div>

      {/* Visible footer line (error-and-denial-ux.md §"Bounded-query-exceeded UX") */}
      {truncated && (
        <div
          className="footer"
          aria-live="polite"
          style={{ fontSize: 11, color: "var(--fg-muted)", marginBottom: 6 }}
        >
          {filterAnnouncement}
        </div>
      )}

      {/* Error banner */}
      {error !== null && (
        <div className="lk-alert" role="alert" aria-live="assertive">
          <span>{error}</span>
          <button type="button" className="lk-alert-retry" onClick={() => void fetchItems()}>
            Retry
          </button>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div
          style={{ color: "var(--fg-muted)", fontSize: 12, padding: "8px 0" }}
          aria-label="Loading relationships"
        >
          Loading…
        </div>
      )}

      {/* Empty state */}
      {!loading && error === null && visibleItems.length === 0 && (
        <div className="insp-empty" data-testid="list-empty">
          No relationships found for the current filter.
        </div>
      )}

      {/* Relationship list */}
      {!loading && visibleItems.length > 0 && (
        <div
          role="list"
          aria-label="Relationships"
          style={{ display: "flex", flexDirection: "column", gap: 2 }}
        >
          {animatedItems.map((item) => {
            const isSelected = item.id === selectedId;
            const activity = resolveRelationshipActivity(item.id, item.lifecycle, activityMap);
            const isFocusedNeighbour = focusMode && isSelected;
            const dimmed = focusMode && !isSelected;
            return (
              <div key={item.id} role="listitem" style={{ opacity: dimmed ? 0.4 : 1 }}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`${item.type} relationship from ${item.source.kind} to ${item.target.kind}, lifecycle: ${item.lifecycle}`}
                  onClick={() => onSelect(item.id)}
                  onKeyDown={(e) => onRowKeyDown(e, item.id)}
                  data-incident={isFocusedNeighbour ? "true" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    minHeight: 32,
                    padding: "4px 6px",
                    background: isSelected ? "var(--accent-dim)" : "transparent",
                    border: "1px solid transparent",
                    borderColor: isSelected ? "var(--accent-line)" : "transparent",
                    borderRadius: 4,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                  className="focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                >
                  <RelationshipEdgeBadge
                    type={item.type as RelationshipType}
                    lifecycle={item.lifecycle}
                    activity={activity}
                    throughputCount={throughputMap.get(item.id)}
                    animateOverride={animateBadges}
                    highContrast={highContrast}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--fg)",
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.source.kind} → {item.target.kind}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--fg-faint)", whiteSpace: "nowrap" }}>
                    {item.lifecycle}
                  </span>
                </button>
              </div>
            );
          })}

          {/* Static aggregate for items beyond animation cap */}
          {extraAnimated > 0 && (
            <div
              role="listitem"
              aria-live="polite"
              style={{ fontSize: 12, color: "var(--fg-muted)", padding: "4px 6px" }}
              data-testid="animation-cap-aggregate"
            >
              +{String(extraAnimated)} more: {overflowSummary}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
