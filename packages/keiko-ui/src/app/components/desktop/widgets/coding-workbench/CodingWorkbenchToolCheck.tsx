"use client";

import type { ReactNode } from "react";

import { reportCodingWorkbenchInteraction } from "@/lib/coding-workbench-interaction";
import type { CodingWorkbenchRuntimeState } from "@/lib/coding-workbench-live-state";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import windowStyles from "./CodingWorkbenchWindow.module.css";

// The one explicit action that checks an activated model's tool calling (ADR-0171 D2, amended
// 2026-11-19). After Gateway Setup, or after an activation whose tool-calling step ended without a
// verdict, nothing else would ever check the model: opening the Workbench never dispatches a check,
// only this person's own action does. The alert above names this button.

/** Whether the selected model waits for its explicit tool-calling check. */
function toolCheckOffered(state: CodingWorkbenchRuntimeState): boolean {
  return (
    state.runtimePreference === "managed-gateway" &&
    state.selectedModelId !== null &&
    state.source.value?.unavailableReason === "tool-calling-unverified"
  );
}

export function CodingWorkbenchToolCheck({
  state,
  onCheck,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  /** Asks the server for the check of the selected model, as a person's own pick does. */
  readonly onCheck: (modelId: string) => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const modelId = state.selectedModelId;
  if (modelId === null || !toolCheckOffered(state)) return null;
  return (
    <div data-testid="coding-workbench-tool-check">
      <button
        className={`${windowStyles.button} ${windowStyles.buttonPrimary}`}
        type="button"
        disabled={state.source.status === "loading"}
        onClick={(): void => {
          reportCodingWorkbenchInteraction({ interaction: "tool-check-requested" });
          onCheck(modelId);
        }}
      >
        {t("codingWorkbench.toolCheck.action")}
      </button>
    </div>
  );
}
