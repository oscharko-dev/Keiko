"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useAutonomyModePolicy } from "@/app/components/desktop/hooks/useAutonomyModePolicy";
import {
  loadMemoryAutonomyMode,
  persistMemoryAutonomyMode,
  type acceptMemoryProposal,
  type fetchMemories,
  type fetchRecentCaptures,
  type forgetMemory,
} from "@/lib/memory-api";
import { useTranslate } from "@/lib/i18n";
import { HealthScanFindings } from "./HealthScanFindings";
import { MemoryConsolidation } from "./MemoryConsolidation";
import { MemoryDetail } from "./MemoryDetail";
import { MemoryListContent } from "./MemoryList";
import { MemoryJournal } from "./MemoryJournal";
import { MemoryAutonomyControl } from "./MemoryAutonomyControl";
import type { MemoryFilterState } from "./MemoryFilters";
import { ReviewQueue } from "./ReviewQueue";

type MemoriaVivaWindowView =
  | { readonly kind: "list" }
  | { readonly kind: "detail"; readonly id: string }
  | { readonly kind: "consolidation" }
  | { readonly kind: "journal" }
  | { readonly kind: "reviewQueue" }
  | { readonly kind: "healthScan" };

const EMPTY_FILTERS: MemoryFilterState = {
  query: "",
  scope: [],
  type: [],
  status: [],
  sensitivity: [],
};

interface MemoriaVivaRequestSettingsProps {
  readonly loadMemoryAutonomyModeImpl: typeof loadMemoryAutonomyMode;
  readonly persistMemoryAutonomyModeImpl: typeof persistMemoryAutonomyMode;
}

function MemoriaVivaRequestSettings({
  loadMemoryAutonomyModeImpl,
  persistMemoryAutonomyModeImpl,
}: MemoriaVivaRequestSettingsProps): ReactNode {
  const t = useTranslate();
  const policy = useAutonomyModePolicy({
    load: loadMemoryAutonomyModeImpl,
    persist: persistMemoryAutonomyModeImpl,
  });
  return (
    <section className="mv-settings" aria-label={t("memoria.settings.region")}>
      <div className="mv-settings-main">
        <div>
          <h2 className="mv-settings-title">{t("memoria.settings.title")}</h2>
          <p className="mv-settings-copy">{t("memoria.settings.description")}</p>
        </div>
      </div>

      <div className="mv-settings-grid">
        <MemoryAutonomyControl
          mode={policy.requestedMode}
          effectiveMode={policy.effectiveMode}
          disabled={policy.pending}
          error={policy.error}
          onChange={policy.change}
        />
      </div>
    </section>
  );
}

interface MemoriaVivaWindowProps {
  readonly fetchMemoriesImpl?: typeof fetchMemories;
  readonly fetchRecentCapturesImpl?: typeof fetchRecentCaptures;
  readonly forgetMemoryImpl?: typeof forgetMemory;
  readonly acceptMemoryProposalImpl?: typeof acceptMemoryProposal;
  readonly loadMemoryAutonomyModeImpl?: typeof loadMemoryAutonomyMode;
  readonly persistMemoryAutonomyModeImpl?: typeof persistMemoryAutonomyMode;
}

interface MemoriaVivaViewRenderProps extends MemoriaVivaWindowProps {
  readonly view: MemoriaVivaWindowView;
  readonly filters: MemoryFilterState;
  readonly setFilters: (next: MemoryFilterState) => void;
  readonly openList: () => void;
  readonly openDetail: (id: string) => void;
  readonly openConsolidation: () => void;
  readonly openReviewQueue: () => void;
  readonly openHealthScan: () => void;
  readonly openJournal: () => void;
  readonly loadMemoryAutonomyModeImpl: typeof loadMemoryAutonomyMode;
  readonly persistMemoryAutonomyModeImpl: typeof persistMemoryAutonomyMode;
}

// Extracted from MemoriaVivaWindow to keep the component's own cognitive complexity low and to
// avoid a deeply nested ternary chain for a discriminated-union render switch (a switch statement
// reads and lints better than N-way ternary chaining for this shape).
function renderMemoriaVivaView(props: MemoriaVivaViewRenderProps): ReactNode {
  switch (props.view.kind) {
    case "list":
      return (
        <MemoryListContent
          filters={props.filters}
          onFilterChange={props.setFilters}
          onOpenDetail={props.openDetail}
          onOpenConsolidation={props.openConsolidation}
          onOpenReviewQueue={props.openReviewQueue}
          onOpenHealthScan={props.openHealthScan}
          onOpenJournal={props.openJournal}
          showWorkspaceBackLink={false}
          {...(props.fetchMemoriesImpl === undefined
            ? {}
            : { fetchMemoriesImpl: props.fetchMemoriesImpl })}
          settingsSlot={
            <MemoriaVivaRequestSettings
              loadMemoryAutonomyModeImpl={props.loadMemoryAutonomyModeImpl}
              persistMemoryAutonomyModeImpl={props.persistMemoryAutonomyModeImpl}
            />
          }
        />
      );
    case "detail":
      return <MemoryDetail id={props.view.id} onBack={props.openList} />;
    case "journal":
      return (
        <MemoryJournal
          onBack={props.openList}
          {...(props.fetchRecentCapturesImpl === undefined
            ? {}
            : { fetchRecentCapturesImpl: props.fetchRecentCapturesImpl })}
          {...(props.forgetMemoryImpl === undefined
            ? {}
            : { forgetMemoryImpl: props.forgetMemoryImpl })}
          {...(props.acceptMemoryProposalImpl === undefined
            ? {}
            : { acceptMemoryProposalImpl: props.acceptMemoryProposalImpl })}
        />
      );
    case "consolidation":
      return <MemoryConsolidation onBack={props.openList} onOpenDetail={props.openDetail} />;
    case "reviewQueue":
      return <ReviewQueue onBack={props.openList} onOpenDetail={props.openDetail} />;
    case "healthScan":
      return <HealthScanFindings onBack={props.openList} onOpenDetail={props.openDetail} />;
  }
}

export function MemoriaVivaWindow({
  fetchMemoriesImpl,
  fetchRecentCapturesImpl,
  forgetMemoryImpl,
  acceptMemoryProposalImpl,
  loadMemoryAutonomyModeImpl = loadMemoryAutonomyMode,
  persistMemoryAutonomyModeImpl = persistMemoryAutonomyMode,
}: MemoriaVivaWindowProps = {}): ReactNode {
  const [view, setView] = useState<MemoriaVivaWindowView>({ kind: "list" });
  const [filters, setFilters] = useState<MemoryFilterState>(EMPTY_FILTERS);

  const openList = useCallback((): void => {
    setView({ kind: "list" });
  }, []);

  const openDetail = useCallback((id: string): void => {
    setView({ kind: "detail", id });
  }, []);
  const openConsolidation = useCallback((): void => setView({ kind: "consolidation" }), []);
  const openReviewQueue = useCallback((): void => setView({ kind: "reviewQueue" }), []);
  const openHealthScan = useCallback((): void => setView({ kind: "healthScan" }), []);
  const openJournal = useCallback((): void => setView({ kind: "journal" }), []);

  return (
    <div className="memoria-window">
      {renderMemoriaVivaView({
        view,
        filters,
        setFilters,
        openList,
        openDetail,
        openConsolidation,
        openReviewQueue,
        openHealthScan,
        openJournal,
        loadMemoryAutonomyModeImpl,
        persistMemoryAutonomyModeImpl,
        ...(fetchMemoriesImpl === undefined ? {} : { fetchMemoriesImpl }),
        ...(fetchRecentCapturesImpl === undefined ? {} : { fetchRecentCapturesImpl }),
        ...(forgetMemoryImpl === undefined ? {} : { forgetMemoryImpl }),
        ...(acceptMemoryProposalImpl === undefined ? {} : { acceptMemoryProposalImpl }),
      })}
    </div>
  );
}
