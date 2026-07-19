"use client";

import { useCallback, useEffect, useId, useState } from "react";
import type { ChangeEvent, WheelEvent } from "react";
import type { ReactNode } from "react";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { NumberControlStepper } from "@/app/components/desktop/NumberControlStepper";
import { useConversationMemorySettings } from "@/app/components/desktop/hooks/memorySettings";
import { Toggle } from "@/app/components/desktop/widgets/shared/Toggle";
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

interface MemoryModePolicyState {
  readonly pending: boolean;
  readonly error: "hydrate" | "persist" | null;
  readonly change: (mode: CodingWorkbenchMode) => void;
}

function useMemoryModePolicy({
  loadMemoryAutonomyModeImpl,
  persistMemoryAutonomyModeImpl,
  setMemoryMode,
}: MemoriaVivaRequestSettingsProps & {
  readonly setMemoryMode: (mode: CodingWorkbenchMode) => void;
}): MemoryModePolicyState {
  const [modePending, setModePending] = useState(true);
  const [modeError, setModeError] = useState<"hydrate" | "persist" | null>(null);
  useEffect(() => {
    let active = true;
    void loadMemoryAutonomyModeImpl()
      .then((policy) => {
        if (!active) return;
        setMemoryMode(policy.requestedMode);
        setModeError(null);
      })
      .catch(() => {
        if (!active) return;
        setMemoryMode("governed-assist");
        setModeError("hydrate");
      })
      .finally(() => {
        if (active) setModePending(false);
      });
    return () => {
      active = false;
    };
  }, [loadMemoryAutonomyModeImpl, setMemoryMode]);

  const handleModeChange = useCallback(
    (next: CodingWorkbenchMode): void => {
      setModePending(true);
      setModeError(null);
      void persistMemoryAutonomyModeImpl(next)
        .then((policy) => {
          setMemoryMode(policy.requestedMode);
        })
        .catch(() => {
          setModeError("persist");
        })
        .finally(() => {
          setModePending(false);
        });
    },
    [persistMemoryAutonomyModeImpl, setMemoryMode],
  );
  return { pending: modePending, error: modeError, change: handleModeChange };
}

function MemoryEnabledSetting({
  enabled,
  onChange,
}: {
  readonly enabled: boolean;
  readonly onChange: (next: boolean) => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className="mv-setting-toggle">
      <span>
        <strong>{t("memoria.settings.useInChat")}</strong>
        <span>{t("memoria.settings.useInChatHelp")}</span>
      </span>
      <Toggle on={enabled} onChange={onChange} label={t("memoria.settings.useInChatLabel")} />
    </div>
  );
}

function MemoryBudgetSetting({
  budgetTokens,
  setBudgetTokens,
}: {
  readonly budgetTokens: number;
  readonly setBudgetTokens: (next: number) => void;
}): ReactNode {
  const t = useTranslate();
  const generatedId = useId();
  const inputId = `${generatedId}-memoriaviva-budget`;
  const helpId = `${generatedId}-memoriaviva-budget-help`;
  const step = useCallback(
    (delta: number): void => setBudgetTokens(Math.max(0, budgetTokens + delta)),
    [budgetTokens, setBudgetTokens],
  );
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      setBudgetTokens(Math.max(0, Number(event.target.value) || 0));
    },
    [setBudgetTokens],
  );
  const wheel = useCallback(
    (event: WheelEvent<HTMLInputElement>): void => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      step(event.deltaY < 0 ? 100 : -100);
    },
    [step],
  );

  return (
    <div className="mv-setting-budget">
      <label htmlFor={inputId}>{t("memoria.settings.budget")}</label>
      <div className="mv-budget-control">
        <span className="number-control number-control-pill">
          <input
            id={inputId}
            type="number"
            className="number-control-input"
            min={0}
            step={100}
            value={budgetTokens}
            aria-label={t("memoria.settings.budget")}
            aria-describedby={helpId}
            onChange={change}
            onWheel={wheel}
          />
          <NumberControlStepper
            label={t("memoria.settings.budget")}
            onStepUp={() => step(100)}
            onStepDown={() => step(-100)}
          />
        </span>
        <span className="mv-budget-unit">{t("memoria.settings.budgetUnit")}</span>
      </div>
      <p id={helpId} className="mv-setting-help">
        {t("memoria.settings.budgetHelp")}
      </p>
    </div>
  );
}

function MemoriaVivaRequestSettings({
  loadMemoryAutonomyModeImpl,
  persistMemoryAutonomyModeImpl,
}: MemoriaVivaRequestSettingsProps): ReactNode {
  const t = useTranslate();
  const settings = useConversationMemorySettings();
  const policy = useMemoryModePolicy({
    loadMemoryAutonomyModeImpl,
    persistMemoryAutonomyModeImpl,
    setMemoryMode: settings.setMemoryMode,
  });
  return (
    <section className="mv-settings" aria-label={t("memoria.settings.region")}>
      <div className="mv-settings-main">
        <div>
          <h2 className="mv-settings-title">{t("memoria.settings.title")}</h2>
          <p className="mv-settings-copy">{t("memoria.settings.description")}</p>
        </div>
        <span
          className="mv-settings-status"
          data-enabled={settings.memoryEnabled ? "true" : "false"}
        >
          {settings.memoryEnabled ? t("memoria.settings.enabled") : t("memoria.settings.disabled")}
        </span>
      </div>

      <div className="mv-settings-grid">
        <MemoryEnabledSetting
          enabled={settings.memoryEnabled}
          onChange={settings.setMemoryEnabled}
        />
        <MemoryBudgetSetting
          budgetTokens={settings.memoryBudgetTokens}
          setBudgetTokens={settings.setMemoryBudgetTokens}
        />
        <MemoryAutonomyControl
          mode={settings.memoryMode}
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

  return (
    <div className="memoria-window">
      {view.kind === "list" ? (
        <MemoryListContent
          filters={filters}
          onFilterChange={setFilters}
          onOpenDetail={openDetail}
          onOpenConsolidation={() => setView({ kind: "consolidation" })}
          onOpenReviewQueue={() => setView({ kind: "reviewQueue" })}
          onOpenHealthScan={() => setView({ kind: "healthScan" })}
          onOpenJournal={() => setView({ kind: "journal" })}
          showWorkspaceBackLink={false}
          {...(fetchMemoriesImpl === undefined ? {} : { fetchMemoriesImpl })}
          settingsSlot={
            <MemoriaVivaRequestSettings
              loadMemoryAutonomyModeImpl={loadMemoryAutonomyModeImpl}
              persistMemoryAutonomyModeImpl={persistMemoryAutonomyModeImpl}
            />
          }
        />
      ) : view.kind === "detail" ? (
        <MemoryDetail id={view.id} onBack={openList} />
      ) : view.kind === "journal" ? (
        <MemoryJournal
          onBack={openList}
          {...(fetchRecentCapturesImpl === undefined ? {} : { fetchRecentCapturesImpl })}
          {...(forgetMemoryImpl === undefined ? {} : { forgetMemoryImpl })}
          {...(acceptMemoryProposalImpl === undefined ? {} : { acceptMemoryProposalImpl })}
        />
      ) : view.kind === "consolidation" ? (
        <MemoryConsolidation onBack={openList} onOpenDetail={openDetail} />
      ) : view.kind === "reviewQueue" ? (
        <ReviewQueue onBack={openList} onOpenDetail={openDetail} />
      ) : (
        <HealthScanFindings onBack={openList} onOpenDetail={openDetail} />
      )}
    </div>
  );
}
