// Issue #540 (Epic #532) — Relationships workspace surface.
//
// Rendered as the body of the singleton `relationships` Workspace window (registered in
// widgets/index.tsx, mirroring the Quality Intelligence hub from Epic #270). It is NOT a
// page route: the relationship surface lives inside the governed desktop like every other
// window, so it keeps the workspace context instead of navigating away.
//
// Filter / focus / density state is component-local (useState) — a window has no URL of its
// own, so the previous useSearchParams()/useRouter() URL model is replaced by in-memory
// state. Selection and filters survive while the window is open; closing the window resets
// them, which matches the singleton-tool lifecycle of QI, Settings, Inspector, etc.
//
// Layout:
//   • Compact toolbar: "+ New relationship" action (does not stretch — see button style)
//   • Left column: RelationshipListPanel (density-capped, filterable)
//   • Right column: RelationshipInspectorPanel (10 sections + impact/health surfaces)
//
// Keyboard shortcuts (window-scoped, ignored while typing in a field):
//   Escape → clear focus
//
// No new third-party dependency. No new @keyframes. No new CSS variables.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { RelationshipFilters } from "../components/desktop/widgets/panels/RelationshipListPanel";
import { RelationshipListPanel } from "../components/desktop/widgets/panels/RelationshipListPanel";
import { RelationshipInspectorPanel } from "../components/desktop/widgets/panels/RelationshipInspectorPanel";
import type { DensityMode } from "../components/desktop/widgets/panels/RelationshipListPanel";
import { useRelationshipActivityStream } from "../components/desktop/widgets/panels/useRelationshipActivityStream";
import { RelationshipHealthPanel } from "../components/desktop/widgets/panels/RelationshipHealthPanel";
import { RelationshipCreateDialog } from "../components/desktop/modals/RelationshipCreateDialog";
import type { ApiRelationship } from "./api";

const EMPTY_FILTERS: RelationshipFilters = {};

// ─── Component ─────────────────────────────────────────────────────────────────

export function RelationshipsView(): ReactNode {
  const { activityMap, throughputMap, animate } = useRelationshipActivityStream();
  const [highContrast, setHighContrast] = useState(false);

  // ─── Component-local view state (no URL; this is a Workspace window) ──────
  const [filters, setFilters] = useState<RelationshipFilters>(EMPTY_FILTERS);
  const selectedId = filters.relFocus;
  const densityMode: DensityMode = (filters.relDensity as DensityMode | undefined) ?? "standard";

  // ─── Create dialog ───────────────────────────────────────────────────────
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreCreateButtonFocusRef = useRef(false);

  // ─── Graph health view (#542) — replaces the inspector pane while active. ──
  const [showHealth, setShowHealth] = useState(false);

  // ─── State writes ────────────────────────────────────────────────────────

  const applyFilters = useCallback((newParams: Partial<RelationshipFilters>) => {
    setFilters((prev) => {
      // Merge immutably (RelationshipFilters is readonly), then drop empty/undefined keys so the
      // panels treat "no filter" identically to the prior URL-absent state.
      const merged: Record<string, string | undefined> = { ...prev, ...newParams };
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(merged)) {
        if (v !== undefined && v !== "") next[k] = v;
      }
      return next as RelationshipFilters;
    });
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      applyFilters({ relFocus: id });
    },
    [applyFilters],
  );

  const handleClearFocus = useCallback(() => {
    applyFilters({ relFocus: undefined });
  }, [applyFilters]);

  const handleViewImpact = useCallback(
    (id: string) => {
      applyFilters({ relFocus: id });
    },
    [applyFilters],
  );

  const handleCreateClose = useCallback(
    (created: ApiRelationship | null) => {
      restoreCreateButtonFocusRef.current = true;
      setCreateDialogOpen(false);
      if (created !== null) {
        // Select the newly created relationship in the inspector.
        applyFilters({ relFocus: created.id });
      }
    },
    [applyFilters],
  );

  useEffect(() => {
    if (createDialogOpen || !restoreCreateButtonFocusRef.current) return;
    restoreCreateButtonFocusRef.current = false;
    createButtonRef.current?.focus();
  }, [createDialogOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(prefers-contrast: more)");
    const syncHighContrast = (matches: boolean) => {
      setHighContrast(matches);
    };
    syncHighContrast(mediaQuery.matches);
    const handleChange = (event: MediaQueryListEvent) => {
      syncHighContrast(event.matches);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // ─── Window-scoped keyboard shortcuts ─────────────────────────────────────
  // Escape clears focus. The filter-input '/' shortcut is handled inside
  // RelationshipListPanel. Shortcuts are suppressed while a field is focused.

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable;
      if (inInput) return;
      if (e.key === "Escape") {
        if (createDialogOpen) return; // let the dialog handle it
        handleClearFocus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createDialogOpen, handleClearFocus]);

  return (
    <>
      {createDialogOpen && <RelationshipCreateDialog onClose={handleCreateClose} />}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        {/* Compact toolbar — the window frame already shows the "Relationships" title. */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            className="arun-btn"
            onClick={() => setShowHealth((v) => !v)}
            aria-pressed={showHealth}
            aria-label="Toggle the graph health view"
            style={{ flex: "0 0 auto", minHeight: 24, marginRight: "auto" }}
          >
            {showHealth ? "Hide health" : "Graph health"}
          </button>
          <button
            ref={createButtonRef}
            type="button"
            className="arun-btn primary"
            onClick={() => setCreateDialogOpen(true)}
            aria-label="Create new relationship"
            // Override .arun-btn.primary { flex: 1 } so the action stays compact in this toolbar.
            style={{ flex: "0 0 auto", minWidth: 24, minHeight: 24 }}
          >
            + New relationship
          </button>
        </header>

        {/* Two-column body */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <div
            style={{
              flex: "0 0 280px",
              borderRight: "1px solid var(--border)",
              overflowY: "auto",
            }}
          >
            <RelationshipListPanel
              filters={filters}
              selectedId={selectedId}
              onSelect={handleSelect}
              onFilterChange={applyFilters}
              activityMap={activityMap}
              throughputMap={throughputMap}
              animateBadges={animate}
              highContrast={highContrast}
            />
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {showHealth ? (
              <RelationshipHealthPanel
                onSelectRelationship={(id) => {
                  setShowHealth(false);
                  handleSelect(id);
                }}
              />
            ) : (
              <RelationshipInspectorPanel
                relationshipId={selectedId ?? null}
                densityMode={densityMode}
                onClearFocus={handleClearFocus}
                onViewImpact={handleViewImpact}
                activityMap={activityMap}
                throughputMap={throughputMap}
                animateBadges={animate}
                highContrast={highContrast}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
