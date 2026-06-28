"use client";

import { useCallback, useId, useState } from "react";
import type { ChangeEvent, WheelEvent } from "react";
import type { ReactNode } from "react";
import { NumberControlStepper } from "@/app/components/desktop/NumberControlStepper";
import { useConversationMemorySettings } from "@/app/components/desktop/hooks/memorySettings";
import { Toggle } from "@/app/components/desktop/widgets/shared/Toggle";
import type { fetchMemories } from "@/lib/memory-api";
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

function MemoriaVivaRequestSettings(): ReactNode {
  const { memoryEnabled, setMemoryEnabled, memoryBudgetTokens, setMemoryBudgetTokens } =
    useConversationMemorySettings();
  const generatedId = useId();
  const budgetInputId = `${generatedId}-memoriaviva-budget`;
  const budgetHelpId = `${generatedId}-memoriaviva-budget-help`;
  const budgetHelp = "Limits the MemoriaViva memory context attached to the next chat request.";

  const stepMemoryBudget = useCallback(
    (delta: number): void => {
      setMemoryBudgetTokens(Math.max(0, memoryBudgetTokens + delta));
    },
    [memoryBudgetTokens, setMemoryBudgetTokens],
  );

  const handleBudgetChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      setMemoryBudgetTokens(Math.max(0, Number(event.target.value) || 0));
    },
    [setMemoryBudgetTokens],
  );

  const handleBudgetWheel = useCallback(
    (event: WheelEvent<HTMLInputElement>): void => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      stepMemoryBudget(event.deltaY < 0 ? 100 : -100);
    },
    [stepMemoryBudget],
  );

  return (
    <section className="mv-settings" aria-label="MemoriaViva request settings">
      <div className="mv-settings-main">
        <div>
          <h2 className="mv-settings-title">Request settings</h2>
          <p className="mv-settings-copy">
            Controls how MemoriaViva contributes memory context to chat requests.
          </p>
        </div>
        <span className="mv-settings-status" data-enabled={memoryEnabled ? "true" : "false"}>
          {memoryEnabled ? "Enabled for chat" : "Disabled for chat"}
        </span>
      </div>

      <div className="mv-settings-grid">
        <div className="mv-setting-toggle">
          <span>
            <strong>Use in chat</strong>
            <span>Attach relevant memories when the next request is sent.</span>
          </span>
          <Toggle
            on={memoryEnabled}
            onChange={setMemoryEnabled}
            label="Use MemoriaViva in chat requests"
          />
        </div>

        <div className="mv-setting-budget">
          <label htmlFor={budgetInputId}>Memory context budget</label>
          <div className="mv-budget-control">
            <span className="number-control number-control-pill">
              <input
                id={budgetInputId}
                type="number"
                className="number-control-input"
                min={0}
                step={100}
                value={memoryBudgetTokens}
                aria-label="MemoriaViva context budget"
                aria-describedby={budgetHelpId}
                onChange={handleBudgetChange}
                onWheel={handleBudgetWheel}
              />
              <NumberControlStepper
                label="MemoriaViva context budget"
                onStepUp={() => stepMemoryBudget(100)}
                onStepDown={() => stepMemoryBudget(-100)}
              />
            </span>
            <span className="mv-budget-unit">tokens</span>
          </div>
          <p id={budgetHelpId} className="mv-setting-help">
            {budgetHelp}
          </p>
        </div>
      </div>
    </section>
  );
}

interface MemoriaVivaWindowProps {
  readonly fetchMemoriesImpl?: typeof fetchMemories;
}

export function MemoriaVivaWindow({ fetchMemoriesImpl }: MemoriaVivaWindowProps = {}): ReactNode {
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
          {...(fetchMemoriesImpl === undefined ? {} : { fetchMemoriesImpl })}
          settingsSlot={<MemoriaVivaRequestSettings />}
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
