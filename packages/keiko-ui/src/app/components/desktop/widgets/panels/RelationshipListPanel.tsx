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
// Filter input focused with / key. Shortcuts are panel-scoped — they fire only while
// focus is inside the panel container (WCAG 2.1.4 Character Key Shortcuts).
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
import {
  listRelationships,
  RelationshipApiError,
  BACKEND_UNREACHABLE_MESSAGE,
} from "../../../../relationships/api";
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

  // Panel root — keyboard shortcuts are bound here, NOT on window (WCAG 2.1.4)
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Filter input
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>(filters.relType ?? "");

  // Debounce timer for URL writes (visual-density-rules.md: ≥250 ms)
  const filterDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Density change ──────────────────────────────────────────────────────

  const changeDensity = useCallback(
    (mode: DensityMode) => {
      setDensity(mode);
      // uiux-fix F046 C395: propagate the mode to the parent view so the inspector
      // (densityMode → transitionCap) follows the same switch — the labelled control
      // previously changed only the list half of the surface.
      onFilterChange({ relDensity: mode });
      // Persist the explicit user choice. The forbidden pattern in
      // visual-density-rules.md is *silently* persisting a read override — but the
      // click itself now sets relDensity, so the old `=== undefined` guard would have
      // blocked every persist after the first click.
      writeDensityToStorage(mode);
    },
    [onFilterChange],
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
    } catch (err) {
      const msg = err instanceof RelationshipApiError ? err.message : BACKEND_UNREACHABLE_MESSAGE;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [filters, density]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  // ─── Panel-scoped keyboard shortcuts ──────────────────────────────────────
  // `F` toggles focus mode; `Escape` clears (ui-blueprint.md §"Focus mode"); `/`
  // focuses the filter input. Bound to the panel root, NOT window: single-character
  // shortcuts must only be active while focus is inside the panel (WCAG 2.1.4
  // Character Key Shortcuts) — a window listener fired across the entire desktop
  // while the Relationships window was merely open in the background.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    function onKey(e: globalThis.KeyboardEvent): void {
      if (hasModalDialogOpen()) return;
      // Only handle when no input is focused (incl. contentEditable surfaces)
      const target = e.target;
      const isInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (isInput) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        setFocusMode((prev) => !prev);
      } else if (e.key === "Escape") {
        setFocusMode(false);
      } else if (e.key === "/") {
        e.preventDefault();
        filterInputRef.current?.focus();
      }
    }
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
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
    // The API filters only on a single exact enum value; partial input, typos and
    // comma-separated multi-values previously fell through to the UNFILTERED list with
    // no feedback (the filter looked broken). Apply the raw input as a case-insensitive
    // substring match client-side so every input visibly narrows the list — unmatched
    // input now yields the empty state instead of silently showing everything.
    const rawTypeTokens = (filters.relType ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0);
    const typeFiltered =
      rawTypeTokens.length === 0
        ? items
        : items.filter((item) =>
            rawTypeTokens.some((token) => item.type.toLowerCase().includes(token)),
          );
    const activityFiltered =
      parsed.activities.length === 0
        ? typeFiltered
        : typeFiltered.filter((item) =>
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
  // aria-live="polite" on a visually-hidden region (ui-blueprint.md §"Filtering").
  // No fabricated total: the API reports truncation but not how many entries exist
  // beyond the cap, so the copy must not invent one (was "of N" with N = visible + 1).
  const filterAnnouncement = truncated
    ? `Showing first ${String(visibleItems.length)} relationships — more available.`
    : `Showing ${String(visibleItems.length)} relationship${visibleItems.length !== 1 ? "s" : ""}.`;

  // User-visible filters (beyond the implicit lifecycle=active scope) — drives the
  // empty-state copy: a virgin graph must not blame a "current filter" the user never set.
  const hasUserFilter =
    (filters.relType ?? "").trim().length > 0 ||
    (filters.relActivity ?? "").trim().length > 0 ||
    (filters.relSrcKind ?? "").trim().length > 0 ||
    (filters.relTgtKind ?? "").trim().length > 0 ||
    ((filters.relLifecycle ?? "").trim().length > 0 && filters.relLifecycle !== "active");

  // Lifecycle scope — must mirror the fetch default exactly (fetchItems pins
  // lifecycle=active when no single valid value is set). Surfacing it as a select makes
  // the previously invisible active-only scope visible AND changeable (draft/blocked/
  // stale/archived/... were unreachable through the UI before).
  const parsedLifecycles = splitFilter(filters.relLifecycle, RELATIONSHIP_LIFECYCLE_STATES);
  const lifecycleValue: RelationshipLifecycleState =
    parsedLifecycles.length === 1 ? (parsedLifecycles[0] ?? "active") : "active";

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
      ref={containerRef}
      className="tw-pad"
      data-testid="relationship-list-panel"
      // Focus mode (visual-density-rules.md §"Focus mode"): non-incident rows are dimmed
      // inline (opacity 0.4); the focused row carries data-incident and is highlighted via
      // the globals.css hook scoped under this attribute (uiux-fix F046 C397).
      data-relationship-focus={focusMode ? "true" : undefined}
    >
      {/* Density switcher — uiux-fix F018 C042: the four buttons need ~296px but the
          list column offers ~254px; wrapping keeps the labels inside their buttons. */}
      <div
        role="group"
        aria-label="Relationship density"
        style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}
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
        {/* uiux-fix F046 C288: .rb-row-k only sets color — without an explicit size the
            label rendered at the 16px UA default, larger than the 13px input below it.
            11px/600 matches the app's micro-label scale (.tw-label). */}
        <label
          htmlFor="rel-type-filter"
          className="rb-row-k"
          style={{ display: "block", marginBottom: 2, fontSize: 11, fontWeight: 600 }}
        >
          Filter by type (press / to focus)
        </label>
        <input
          id="rel-type-filter"
          ref={filterInputRef}
          type="text"
          list="rel-type-filter-options"
          value={typeFilter}
          onChange={handleTypeFilterChange}
          placeholder="e.g. reads-context"
          aria-label="Filter relationships by type"
          style={{
            width: "100%",
            background: "var(--inset)",
            border: "1px solid var(--line)",
            // 9px / 13px match the app input scale (.srch-box / .srch-box input);
            // 4px / 12px sat below every radius and input size used elsewhere.
            borderRadius: 9,
            padding: "4px 8px",
            minHeight: 24,
            color: "var(--fg)",
            fontSize: 13,
          }}
        />
        {/* Valid relationship types as autocomplete — the field only filters on these */}
        <datalist id="rel-type-filter-options">
          {RELATIONSHIP_TYPES.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>

      {/* Lifecycle scope — the API requires a selective filter; the list used to pin
          lifecycle=active invisibly, making every other lifecycle unreachable. */}
      <div style={{ marginBottom: 8 }}>
        <label
          htmlFor="rel-lifecycle-filter"
          className="rb-row-k"
          // Same micro-label scale as the type-filter label above (uiux-fix F046 C288).
          style={{ display: "block", marginBottom: 2, fontSize: 11, fontWeight: 600 }}
        >
          Lifecycle
        </label>
        <select
          id="rel-lifecycle-filter"
          value={lifecycleValue}
          onChange={(e) => onFilterChange({ relLifecycle: e.target.value })}
          aria-label="Filter relationships by lifecycle"
          style={{
            width: "100%",
            background: "var(--inset)",
            border: "1px solid var(--line)",
            borderRadius: 9,
            padding: "4px 8px",
            minHeight: 24,
            color: "var(--fg)",
            fontSize: 13,
          }}
        >
          {RELATIONSHIP_LIFECYCLE_STATES.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </div>

      {/* Accessible live announcement of filter result (ui-blueprint.md §"Filtering") */}
      <div aria-live="polite" aria-atomic="true" className="visually-hidden">
        {filterAnnouncement}
      </div>

      {/* Visible truncation note (error-and-denial-ux.md §"Bounded-query-exceeded UX").
          No className="footer" — that is the app-shell footer (46px surface bar) and
          rendered this one-liner as a massive colored band; no aria-live either, the
          visually-hidden region above already announces the same text (was doubled). */}
      {truncated && (
        <div
          data-testid="list-truncation-note"
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

      {/* Loading state (uiux-fix F046 C289/C392) — rendered only while there is nothing
          to keep on screen (initial load). Refetches keep the stale list mounted below
          (aria-busy + dim) instead of swapping the whole panel for a "Loading…" row on
          every debounced keystroke and density click, which jumped the layout height and
          lost the scroll position. role="status" (live region) so the visible text is
          announced; the previous aria-label sat on a generic div, where ARIA naming is
          prohibited and ignored. .insp-empty aligns the typography with the empty state. */}
      {loading && items.length === 0 && (
        <div role="status" className="insp-empty">
          Loading…
        </div>
      )}

      {/* Empty state — two cases: a virgin graph must not blame a "current filter" the
          user never set; it should point at the next step instead. During a refetch it
          only renders when stale items exist and the client-side filter narrowed them to
          zero (synchronous truth); otherwise the loading row above covers the gap. */}
      {(!loading || items.length > 0) && error === null && visibleItems.length === 0 && (
        <div className="insp-empty" data-testid="list-empty">
          {hasUserFilter
            ? "No relationships match the current filter."
            : 'No active relationships yet. Create one with "+ New relationship", or connect a source — connections appear here automatically.'}
        </div>
      )}

      {/* Relationship list — stays mounted during refetches (stale-while-revalidate);
          aria-busy + reduced opacity signal the in-flight update without unmounting. */}
      {visibleItems.length > 0 && (
        <div
          role="list"
          aria-label="Relationships"
          aria-busy={loading || undefined}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            opacity: loading ? 0.6 : 1,
            transition: "opacity 0.15s ease",
          }}
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
                  aria-label={`${item.type} relationship from ${item.source.kind} ${item.source.id} to ${item.target.kind} ${item.target.id}, lifecycle: ${item.lifecycle}`}
                  title={`${item.source.id} → ${item.target.id}`}
                  onClick={() => onSelect(item.id)}
                  onKeyDown={(e) => onRowKeyDown(e, item.id)}
                  data-incident={isFocusedNeighbour ? "true" : undefined}
                  // .rel-row replaces dead Tailwind utilities (project has no Tailwind):
                  // real hover background, app-conventional accent focus ring, and the
                  // selected state via [aria-pressed="true"] (was inline background).
                  className="rel-row"
                >
                  <RelationshipEdgeBadge
                    type={item.type as RelationshipType}
                    lifecycle={item.lifecycle}
                    activity={activity}
                    throughputCount={throughputMap.get(item.id)}
                    animateOverride={animateBadges}
                    highContrast={highContrast}
                  />
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--fg)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.source.kind} → {item.target.kind}
                    </span>
                    {/* Distinguishing line — without it, rows with the same kinds were
                        byte-identical and only resolvable by clicking through them. */}
                    <span
                      style={{
                        fontSize: 10.5,
                        color: "var(--fg-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.summary ?? `${item.source.id} → ${item.target.id}`}
                    </span>
                  </span>
                  {/* --fg-muted: --fg-faint measured 2.52:1 dark / 2.91:1 light (AA fail)
                      on this meaning-bearing status label (globals.css #527 note). */}
                  <span style={{ fontSize: 11, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>
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
