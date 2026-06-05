"use client";

// Issue #151 / Epic #142 — Conversation Center context-pressure indicator.
//
// AC#1: indicate context pressure before send when the selected model has
//       known limits.
// AC#4: let users start a clean context or reduce included history without
//       deleting the conversation.
// AC#3: when pressure is "exceeded", render an actionable warning and the
//       composer must block submission.
//
// Engineering note: token counts are APPROXIMATE (bytes/4). The UI says so
// explicitly via the leading "Approximate context:" prefix and the info icon
// tooltip — we never present byte estimates as exact tokens.

import type { ReactNode } from "react";
import type { ConversationBudgetEstimate, ConversationBudgetPressure } from "@/lib/types";

// Stable id so the composer's send button can chain aria-describedby when
// pressure is "exceeded" and submission is blocked.
export const BUDGET_EXCEEDED_ALERT_ID = "cmp-budget-exceeded-alert";

const PRESSURE_LABEL: Readonly<Record<ConversationBudgetPressure, string>> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  exceeded: "Exceeded",
};

// Tailwind/CSS class hooks (existing CSS-in-CSS surface). We use data-* so the
// stylesheet can target without colliding with the composer's existing classes.
const PRESSURE_CLASS: Readonly<Record<ConversationBudgetPressure, string>> = {
  low: "cmp-budget-badge cmp-budget-badge-low",
  moderate: "cmp-budget-badge cmp-budget-badge-moderate",
  high: "cmp-budget-badge cmp-budget-badge-high",
  exceeded: "cmp-budget-badge cmp-budget-badge-exceeded",
};

// Friendly "k tokens" for readability above 1k. Below that, show the raw count.
function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

interface BudgetIndicatorProps {
  readonly budget: ConversationBudgetEstimate | undefined;
  readonly onClearHistory: () => void;
  readonly disabled?: boolean | undefined;
}

export function BudgetIndicator({
  budget,
  onClearHistory,
  disabled,
}: BudgetIndicatorProps): ReactNode {
  // When the model has no known limits, the indicator is intentionally hidden
  // (AC#1: "when a selected model has known limits"). undefined budget covers
  // both bootstrap and missing-capability states.
  if (budget === undefined) return null;
  if (budget.contextWindowTokens <= 0) return null;

  const tokensLabel = formatTokens(budget.approximateTokens);
  const windowLabel = formatTokens(budget.contextWindowTokens);
  const pressure = budget.pressure;
  const exceeded = pressure === "exceeded";

  return (
    <div className="cmp-budget" data-pressure={pressure}>
      <div className="cmp-budget-row">
        <span className="cmp-budget-count">
          Approximate context: {tokensLabel} / {windowLabel} tokens
        </span>
        <span
          className={PRESSURE_CLASS[pressure]}
          aria-label={`Context pressure: ${PRESSURE_LABEL[pressure]}`}
        >
          {PRESSURE_LABEL[pressure]}
        </span>
        <span
          className="cmp-budget-info"
          role="img"
          aria-label="Token counts are approximate. Actual model usage may vary."
          title="Token counts are approximate. Actual model usage may vary."
        >
          i
        </span>
        <button
          type="button"
          className="cmp-budget-clear"
          aria-label="Clear conversation history for next prompt"
          onClick={onClearHistory}
          disabled={disabled === true}
        >
          Clear history
        </button>
      </div>
      {exceeded ? (
        <div id={BUDGET_EXCEEDED_ALERT_ID} role="alert" className="cmp-budget-alert gw-error">
          Context exceeds the selected model&apos;s window. Clear history or pick a model with a
          larger context.
        </div>
      ) : null}
    </div>
  );
}
