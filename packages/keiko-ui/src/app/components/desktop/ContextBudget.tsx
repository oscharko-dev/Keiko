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

import { useEffect, useRef, useState, type ReactNode } from "react";
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

const APPROXIMATE_HINT = "Token counts are approximate. Actual model usage may vary.";

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
  // uiux-fix F010 (C175): "Clear history" empties the visible conversation with a
  // single click — destructive-looking on a core path. Inline two-step confirm plus
  // a role="status" note explaining the reset is NOT persisted (useChatSession's
  // clearHistory only resets in-memory messages; reloads re-fetch the turns).
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const clearRef = useRef<HTMLButtonElement | null>(null);

  // Focus management for the inline confirm: entering it moves focus to the
  // confirm button; leaving it returns focus to the Clear-history trigger.
  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
    }
  }, [confirming]);

  // When the model has no known limits, the indicator is intentionally hidden
  // (AC#1: "when a selected model has known limits"). undefined budget covers
  // both bootstrap and missing-capability states.
  if (budget === undefined) return null;

  // uiux-fix F010 (C204): contextWindow 0 (unknown limits) previously hid the
  // indicator entirely — live, ALL runtime-configured chat models report 0, so
  // users got no context feedback at all. Render a count-only fallback: no
  // "/ window" limit, no pressure badge and no exceeded alert (the estimator's
  // pressure is meaningless without a real window, see isBudgetExceeded CB-F1).
  const hasKnownWindow = budget.contextWindowTokens > 0;

  const tokensLabel = formatTokens(budget.approximateTokens);
  const windowLabel = formatTokens(budget.contextWindowTokens);
  const pressure = budget.pressure;
  const exceeded = hasKnownWindow && pressure === "exceeded";

  function handleClearConfirmed(): void {
    onClearHistory();
    setConfirming(false);
    setCleared(true);
    // The confirm controls unmount; hand focus back to the re-rendered trigger.
    requestAnimationFrame(() => clearRef.current?.focus());
  }

  function handleCancel(): void {
    setConfirming(false);
    requestAnimationFrame(() => clearRef.current?.focus());
  }

  return (
    <div className="cmp-budget" data-pressure={hasKnownWindow ? pressure : "unknown"}>
      <div className="cmp-budget-row">
        <span className="cmp-budget-count">
          {hasKnownWindow
            ? `Approximate context: ${tokensLabel} / ${windowLabel} tokens`
            : `Approximate context: ${tokensLabel} tokens`}
        </span>
        {hasKnownWindow ? (
          <span
            className={PRESSURE_CLASS[pressure]}
            aria-label={`Context pressure: ${PRESSURE_LABEL[pressure]}`}
          >
            {PRESSURE_LABEL[pressure]}
          </span>
        ) : null}
        {/* uiux-fix F010 (C321): focusable hint with a CSS data-tip tooltip on hover AND
            focus — the previous title-attribute tooltip was mouse-only (WCAG 1.4.13). */}
        {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- the hint must be keyboard-focusable so its data-tip tooltip is reachable without a mouse */}
        <span
          className="cmp-budget-info"
          role="img"
          tabIndex={0}
          aria-label={APPROXIMATE_HINT}
          data-tip={APPROXIMATE_HINT}
        >
          i
        </span>
        {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
        {confirming ? (
          <span className="cmp-budget-confirm">
            <span className="cmp-budget-confirm-label" id="cmp-budget-confirm-label">
              Clear history?
            </span>
            <button
              type="button"
              ref={confirmRef}
              className="cmp-budget-clear"
              aria-describedby="cmp-budget-confirm-label"
              onClick={handleClearConfirmed}
            >
              Clear
            </button>
            <button type="button" className="cmp-budget-clear" onClick={handleCancel}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            ref={clearRef}
            className="cmp-budget-clear"
            aria-label="Clear conversation history for next prompt"
            onClick={() => {
              setCleared(false);
              setConfirming(true);
            }}
            disabled={disabled === true}
          >
            Clear history
          </button>
        )}
        {cleared ? (
          <span role="status" className="cmp-budget-cleared">
            History cleared for the next prompt — messages remain saved.
          </span>
        ) : null}
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
