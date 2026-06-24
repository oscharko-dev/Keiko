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
import { formatTokens } from "@/lib/format";
import { MetricRow, humanizeToken } from "./GroundedAnswer";
import type { ContextBudgetPressure, GroundedAnswerContextSummary } from "@/lib/types";

// Sentence-case the four-value pressure enum for the metric column (e.g. "moderate" → "Moderate").
function pressureLabel(pressure: ContextBudgetPressure): string {
  return pressure.charAt(0).toUpperCase() + pressure.slice(1);
}

// Per-lane rows: only lanes that actually carried items (count > 0), so the panel does not list
// eight zero rows for a small turn. ContextLaneId is a fixed literal union (humanized for display),
// never a path; the value is an integer count. Object.entries order follows the laneCounts map.
function LaneRows({
  laneCounts,
}: {
  readonly laneCounts: GroundedAnswerContextSummary["laneCounts"];
}): ReactNode {
  const populated = Object.entries(laneCounts).filter(([, count]) => count > 0);
  return (
    <>
      {populated.map(([lane, count]) => (
        <MetricRow
          key={`lane-${lane}`}
          label={humanizeToken(lane)}
          value={count.toLocaleString("en-US")}
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
  if (contextSummary === undefined) {
    return null;
  }
  return (
    <details className="ctx-status">
      <summary className="ctx-status-summary" aria-label="Why this context?">
        Why this context?
      </summary>
      <dl className="ctx-status-dl grounded-context-pack-dl">
        <MetricRow
          label="Estimated"
          value={`${formatTokens(contextSummary.totalEstimatedTokens)} tok`}
        />
        <MetricRow label="Budget pressure" value={pressureLabel(contextSummary.budgetPressure)} />
        <LaneRows laneCounts={contextSummary.laneCounts} />
        <MetricRow
          label="Compaction"
          value={contextSummary.compactionActive ? "Active" : "Inactive"}
        />
      </dl>
    </details>
  );
}
