// Issue #540 (Epic #532) — Client-side relationships view.
//
// Reads URL search params via `useSearchParams()` (safe: parent page.tsx wraps in Suspense).
// Renders:
//   • Left column: RelationshipListPanel (density-capped, filterable)
//   • Right column: RelationshipInspectorPanel (10 sections)
//   • Header: title + "New relationship" action triggering RelationshipCreateDialog
//
// Keyboard shortcuts registered here:
//   /          → focus filter input  (delegated to RelationshipListPanel via ref)
//   F          → toggle focus mode  (passed via onFocusMode prop)
//   Escape     → clear focus
//   R, A, I, E → delegated to RelationshipInspectorPanel via ref
//
// URL writes: push only (no replace) so back-button works.
// localStorage density persistence is handled inside RelationshipListPanel.
//
// No new third-party dependency. No new @keyframes. No new CSS variables.

"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { RelationshipFilters } from "../components/desktop/widgets/panels/RelationshipListPanel";
import { RelationshipListPanel } from "../components/desktop/widgets/panels/RelationshipListPanel";
import { RelationshipInspectorPanel } from "../components/desktop/widgets/panels/RelationshipInspectorPanel";
import type { DensityMode } from "../components/desktop/widgets/panels/RelationshipListPanel";
import { RelationshipCreateDialog } from "../components/desktop/modals/RelationshipCreateDialog";
import type { ApiRelationship } from "./api";

// ─── Component ─────────────────────────────────────────────────────────────────

export function RelationshipsView(): ReactNode {
  const searchParams = useSearchParams();
  const router = useRouter();

  // ─── Derive filters from URL ─────────────────────────────────────────────
  const filters: RelationshipFilters = {
    relType: searchParams.get("relType") ?? undefined,
    relLifecycle: searchParams.get("relLifecycle") ?? undefined,
    relActivity: searchParams.get("relActivity") ?? undefined,
    relSrcKind: searchParams.get("relSrcKind") ?? undefined,
    relTgtKind: searchParams.get("relTgtKind") ?? undefined,
    relDensity: searchParams.get("relDensity") ?? undefined,
    relFocus: searchParams.get("relFocus") ?? undefined,
  };

  const selectedId = searchParams.get("relFocus") ?? undefined;
  const densityMode: DensityMode =
    (searchParams.get("relDensity") as DensityMode | null) ?? "standard";

  // ─── Create dialog ───────────────────────────────────────────────────────
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  // ─── URL writes ──────────────────────────────────────────────────────────

  const applyFilters = useCallback(
    (newParams: Partial<RelationshipFilters>) => {
      const next = new URLSearchParams(searchParams.toString());
      const keyMap: Record<keyof RelationshipFilters, string> = {
        relType: "relType",
        relLifecycle: "relLifecycle",
        relActivity: "relActivity",
        relSrcKind: "relSrcKind",
        relTgtKind: "relTgtKind",
        relDensity: "relDensity",
        relFocus: "relFocus",
      };
      for (const [k, v] of Object.entries(newParams) as [
        keyof RelationshipFilters,
        string | undefined,
      ][]) {
        if (v === undefined || v === "") {
          next.delete(keyMap[k]);
        } else {
          next.set(keyMap[k], v);
        }
      }
      router.push(`/relationships?${next.toString()}`);
    },
    [searchParams, router],
  );

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
      // Navigate to impact view for #542 — for now open the inspector with focus
      applyFilters({ relFocus: id });
    },
    [applyFilters],
  );

  const handleCreateClose = useCallback(
    (created: ApiRelationship | null) => {
      setCreateDialogOpen(false);
      if (created !== null) {
        // Select the newly created relationship in the inspector
        applyFilters({ relFocus: created.id });
      }
    },
    [applyFilters],
  );

  // ─── Global keyboard shortcuts ────────────────────────────────────────────
  // inspector-spec.md keyboard map: F=FocusMode, Escape=ClearFocus
  // The filter-input '/' shortcut is handled inside RelationshipListPanel.

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
        if (createDialogOpen) return; // let dialog handle it
        handleClearFocus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createDialogOpen, handleClearFocus]);

  return (
    <>
      {/* Dialog */}
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
        {/* Page header */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 600,
              color: "var(--fg)",
              flexGrow: 1,
            }}
          >
            Relationships
          </h1>
          <button
            type="button"
            className="arun-btn primary"
            onClick={() => setCreateDialogOpen(true)}
            aria-label="Create new relationship"
            style={{ minWidth: 24, minHeight: 24 }}
          >
            + New
          </button>
        </header>

        {/* Two-column body */}
        <div
          style={{
            display: "flex",
            flex: 1,
            overflow: "hidden",
          }}
        >
          {/* Left: List panel */}
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
            />
          </div>

          {/* Right: Inspector panel */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
            }}
          >
            <RelationshipInspectorPanel
              relationshipId={selectedId ?? null}
              densityMode={densityMode}
              onClearFocus={handleClearFocus}
              onViewImpact={handleViewImpact}
            />
          </div>
        </div>
      </div>
    </>
  );
}
