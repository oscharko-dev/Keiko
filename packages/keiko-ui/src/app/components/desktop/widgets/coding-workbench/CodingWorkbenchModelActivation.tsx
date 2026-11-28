"use client";

import type { ReactNode } from "react";

import type { ModelActivation } from "@/lib/useModelActivation";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { WorkbenchModelReadiness } from "./codingWorkbenchModelReadiness";
import windowStyles from "./CodingWorkbenchWindow.module.css";

// The one in-place action for a model nobody activated in this server process (ADR-0171 D2, amended
// 2026-11-16; U-12). The alert above names the fact; this offers the person's own activation, which
// is the same readiness check Settings > Models runs. A check that failed is never retried here: it
// points to Settings > Models for the details instead.

export function CodingWorkbenchModelActivation({
  readiness,
  activation,
  onOpenSettings,
}: {
  readonly readiness: WorkbenchModelReadiness | null;
  readonly activation: ModelActivation;
  readonly onOpenSettings: (() => void) | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (activation.state.status === "running") {
    return (
      <output
        className={windowStyles.cmpStreamNotice}
        data-testid="coding-workbench-model-activation-checking"
      >
        {t("codingWorkbench.source.unavailableReason.model-verification-pending")}
      </output>
    );
  }
  if (readiness === null) return null;
  if (readiness.kind === "not-activated") {
    return (
      <div className={windowStyles.modelActivation} data-testid="coding-workbench-model-activation">
        <button
          className={`${windowStyles.button} ${windowStyles.buttonPrimary}`}
          type="button"
          onClick={(): void => activation.activate(readiness.modelId)}
        >
          {t("codingWorkbench.modelActivation.action", { model: readiness.modelId })}
        </button>
      </div>
    );
  }
  return (
    <div
      className={windowStyles.modelActivation}
      data-testid="coding-workbench-model-activation-failed"
    >
      <button className={windowStyles.button} type="button" onClick={onOpenSettings}>
        {t("codingWorkbench.modelActivation.settings")}
      </button>
    </div>
  );
}
