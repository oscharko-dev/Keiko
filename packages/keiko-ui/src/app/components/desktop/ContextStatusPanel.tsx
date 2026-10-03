"use client";

// ADR-0057 D2 — a quiet, collapsed-by-default aggregate "Context" panel for a grounded answer.
// It surfaces ONLY the path-free context-assembly aggregate: total estimated tokens, the budget
// pressure enum, per-lane SOURCE COUNTS (counts, never paths), and a compaction on/off indicator.
// Every value comes from `GroundedAnswerContextSummary`, a struct with no string-typed path field
// (numbers, a literal-union enum, a Record<ContextLaneId, number>, and a boolean), so the panel is
// structurally incapable of rendering a file path, scope id, score, or excerpt (ADR-0022 / D4).
// The native <details>/<summary> disclosure mirrors RankingRationale (GroundedAnswer.tsx): closed
// by default, keyboard-operable, no useState, complexity 1 per render function.

import type { ReactNode } from "react";
import { CONTEXT_LANE_IDS } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { formatTokens } from "@/lib/format";
import { useLocale, useTranslate, type I18nTranslate, type Locale } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
import { MetricRow } from "./GroundedAnswer";
import {
  DEFAULT_TOKEN_ESTIMATOR_ID,
  type ContextBudgetPressure,
  type ContextLaneId,
  type GroundedAnswerContextSummary,
} from "@/lib/types";

const LANE_LABELS: Readonly<Record<ContextLaneId, MessageKey>> = {
  "system-contract": "context.lane.system",
  "user-task": "context.lane.task",
  "active-plan": "context.lane.plan",
  "repo-evidence": "context.lane.repository",
  "tool-observations": "context.lane.tools",
  "working-memory": "context.lane.memory",
  "history-summary": "context.lane.history",
  "verification-evidence": "context.lane.verification",
};

function pressureLabel(pressure: ContextBudgetPressure, t: I18nTranslate): string {
  if (pressure === "low") return t("context.pressure.low");
  if (pressure === "moderate") return t("context.pressure.moderate");
  if (pressure === "high") return t("context.pressure.high");
  return t("context.pressure.exceeded");
}

function populatedLaneCount(laneCounts: GroundedAnswerContextSummary["laneCounts"]): number {
  return Object.values(laneCounts).filter((count) => count > 0).length;
}

function contextSummaryMeta(
  contextSummary: GroundedAnswerContextSummary,
  t: I18nTranslate,
  locale: Locale,
): string {
  const lanes = populatedLaneCount(contextSummary.laneCounts);
  return [
    t("context.meta.tokens", { tokens: formatTokens(contextSummary.totalEstimatedTokens) }),
    t("context.meta.pressure", { pressure: pressureLabel(contextSummary.budgetPressure, t) }),
    t("context.meta.lanes", { count: lanes.toLocaleString(locale) }),
    contextSummary.compactionActive
      ? t("context.compaction.active")
      : t("context.compaction.inactive"),
  ].join(" · ");
}

// Per-lane rows show populated item counts with localized labels. The repository lane counts
// excerpts, which can differ from both files read and citation references. Lane IDs are fixed
// contract vocabulary, never paths; the wire contains counts only.
function LaneRows({
  laneCounts,
  locale,
}: {
  readonly laneCounts: GroundedAnswerContextSummary["laneCounts"];
  readonly locale: Locale;
}): ReactNode {
  const t = useTranslate();
  const populated = CONTEXT_LANE_IDS.map((lane) => [lane, laneCounts[lane]] as const).filter(
    ([, count]) => count > 0,
  );
  return (
    <>
      {populated.map(([lane, count]) => (
        <MetricRow
          key={`lane-${lane}`}
          label={t(LANE_LABELS[lane])}
          value={count.toLocaleString(locale)}
        />
      ))}
    </>
  );
}

export function ContextStatusPanel({
  contextSummary,
}: {
  readonly contextSummary?: GroundedAnswerContextSummary | undefined;
}): ReactNode {
  const locale = useLocale();
  const t = useTranslate();
  if (contextSummary === undefined) {
    return null;
  }
  return (
    <details className="ctx-status grounded-evidence-disclosure">
      <summary
        className="ctx-status-summary grounded-evidence-summary"
        aria-label={t("context.details.aria")}
        title={t("context.details.hint", { estimator: DEFAULT_TOKEN_ESTIMATOR_ID })}
      >
        <span className="grounded-evidence-summary-title">{t("context.details.title")}</span>
        <span className="grounded-evidence-summary-meta">
          {contextSummaryMeta(contextSummary, t, locale)}
        </span>
      </summary>
      <div className="ctx-status-body grounded-evidence-body">
        <dl className="ctx-status-dl grounded-context-pack-dl">
          <MetricRow label={t("context.metric.estimator")} value={DEFAULT_TOKEN_ESTIMATOR_ID} />
          <MetricRow
            label={t("context.metric.assembledEstimate")}
            value={t("context.metric.tokensShort", {
              tokens: formatTokens(contextSummary.totalEstimatedTokens),
            })}
          />
          <MetricRow
            label={t("context.metric.budgetPressure")}
            value={pressureLabel(contextSummary.budgetPressure, t)}
          />
          <LaneRows laneCounts={contextSummary.laneCounts} locale={locale} />
          <MetricRow
            label={t("context.metric.compaction")}
            value={
              contextSummary.compactionActive
                ? t("context.compaction.active")
                : t("context.compaction.inactive")
            }
          />
        </dl>
      </div>
    </details>
  );
}
