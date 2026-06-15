"use client";

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { MemoryConsolidation } from "./MemoryConsolidation";
import { MemoryDetail } from "./MemoryDetail";
import { MemoryListContent } from "./MemoryList";
import type { MemoryFilterState } from "./MemoryFilters";
import { ReviewQueue } from "./ReviewQueue";

type MemoriaVivaWindowView =
  | { readonly kind: "list" }
  | { readonly kind: "detail"; readonly id: string }
  | { readonly kind: "consolidation" }
  | { readonly kind: "reviewQueue" };

const EMPTY_FILTERS: MemoryFilterState = {
  scope: [],
  type: [],
  status: [],
  sensitivity: [],
};

export function MemoriaVivaWindow(): ReactNode {
  const [view, setView] = useState<MemoriaVivaWindowView>({ kind: "list" });
  const [filters, setFilters] = useState<MemoryFilterState>(EMPTY_FILTERS);
  const [policyEnabled, setPolicyEnabled] = useState(true);

  const openList = useCallback((): void => {
    setView({ kind: "list" });
  }, []);

  const openDetail = useCallback((id: string): void => {
    setView({ kind: "detail", id });
  }, []);

  return (
    <div className="memoria-window">
      {view.kind === "list" ? (
        <MemoryListContent
          filters={filters}
          onFilterChange={setFilters}
          onOpenDetail={openDetail}
          onOpenConsolidation={() => setView({ kind: "consolidation" })}
          onOpenReviewQueue={() => setView({ kind: "reviewQueue" })}
          policyEnabled={policyEnabled}
          onPolicyEnabledChange={setPolicyEnabled}
          showWorkspaceBackLink={false}
        />
      ) : view.kind === "detail" ? (
        <MemoryDetail id={view.id} onBack={openList} />
      ) : view.kind === "consolidation" ? (
        <MemoryConsolidation onBack={openList} onOpenDetail={openDetail} />
      ) : (
        <ReviewQueue onBack={openList} onOpenDetail={openDetail} />
      )}
    </div>
  );
}
