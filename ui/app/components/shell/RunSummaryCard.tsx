"use client";

/**
 * Issue #66 — RunSummaryCard.
 *
 * Renders a system run-summary message: status badge + workflow/task label + truncated
 * runId + shortResult + links to the canonical run/evidence detail pages.
 *
 * The card is the only place in the chat that drives `useRunStatusSync`. The hook PATCHes
 * the row on terminal; this component re-renders from props once the parent threads the
 * updated message in via onPatched.
 *
 * Accessibility:
 *  - Status conveyed by icon, text label, and color (never color alone) — WCAG 1.4.1.
 *  - Live region `role="status"` `aria-live="polite"` announces status changes.
 *  - Icon-only links hit-area 24×24, with `aria-label` (WCAG 2.5.8).
 *  - "Unavailable" state disables links via `aria-disabled`+`tabIndex=-1`+`cursor-not-allowed`.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { ChatMessage, ChatWorkflowStatus } from "@/lib/types";
import { useRunStatusSync } from "./useRunStatusSync";

const WORKFLOW_LABELS: Record<string, string> = {
  "unit-test-generation": "Generate Tests",
  "bug-investigation": "Investigate Bug",
};

const TASK_LABELS: Record<string, string> = {
  verify: "Verify",
  "explain-plan": "Explain Plan",
};

function deriveLabel(message: ChatMessage): string {
  if (message.workflowId !== undefined) {
    const wl = WORKFLOW_LABELS[message.workflowId];
    if (wl !== undefined) return wl;
  }
  if (message.taskType !== undefined) {
    const tl = TASK_LABELS[message.taskType];
    if (tl !== undefined) return tl;
  }
  return "Workflow run";
}

interface BadgeStyle {
  readonly label: string;
  readonly icon: string;
  readonly wrapperClass: string;
  readonly spinning: boolean;
}

function badgeFor(status: ChatWorkflowStatus | undefined): BadgeStyle {
  if (status === "completed") {
    return { label: "Completed", icon: "✓", wrapperClass: "bg-accent text-ink-inverse", spinning: false };
  }
  if (status === "failed") {
    // bg-red-500 (#ef4444) on text-ink-inverse (#1a1e23) = 5.57:1, meets WCAG 1.4.3 AA 4.5:1.
    // bg-red-600 (#dc2626) here fails at 3.47:1 (a11y audit, issue #66).
    return { label: "Failed", icon: "✕", wrapperClass: "bg-red-500 text-ink-inverse", spinning: false };
  }
  if (status === "cancelled") {
    return { label: "Cancelled", icon: "⊘", wrapperClass: "bg-elevated text-ink", spinning: false };
  }
  // pending and running share the same spinner-ish visual; both indicate in-flight state.
  return { label: status === "pending" ? "Pending" : "Running", icon: "◐", wrapperClass: "bg-elevated text-ink", spinning: true };
}

interface RunSummaryCardProps {
  readonly message: ChatMessage;
  readonly onPatched: (m: ChatMessage) => void;
}

export function RunSummaryCard({ message, onPatched }: RunSummaryCardProps): ReactNode {
  const { unavailable } = useRunStatusSync(message, onPatched);
  const badge = badgeFor(message.workflowStatus);
  const label = deriveLabel(message);
  const runId = message.runId ?? "";
  const hasRunId = runId.length > 0;
  const shortId = runId.length > 8 ? runId.slice(0, 8) : runId;
  // A link with no runId points at a dead URL; disable it the same way as the unavailable
  // state so the user is not invited to navigate to a 404 (self-critique #12).
  const linksDisabled = unavailable || !hasRunId;

  // Links target the canonical detail pages; encodeURIComponent in the raw `?id=` template
  // is the established repo pattern (updateChat) and avoids the double-encoding trap
  // (memory #64 CP1).
  const runHref = `/run?id=${encodeURIComponent(runId)}`;
  const evidenceHref = `/evidence/detail?id=${encodeURIComponent(runId)}`;

  const linkBaseClass =
    "inline-flex h-6 w-6 items-center justify-center rounded text-xs text-ink hover:bg-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-focus";
  const linkDisabledClass = "pointer-events-none cursor-not-allowed opacity-50";

  return (
    // No explicit border: bg-panel + rounded corners + gap-3 list spacing match the user/assistant
    // message bubbles in ChatView. An explicit border-border on bg-panel was only 1.22:1
    // (WCAG 1.4.11 needs 3:1 — a11y audit, issue #66).
    <div
      role="status"
      aria-live="polite"
      className="max-w-[80%] rounded-lg bg-panel px-3 py-2 text-sm text-ink"
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${badge.wrapperClass}`}
        >
          <span aria-hidden="true" className={badge.spinning ? "inline-block motion-safe:animate-pulse" : undefined}>
            {badge.icon}
          </span>
          <span>{badge.label}</span>
        </span>
        <span className="text-xs font-medium text-ink">{label}</span>
        {shortId.length > 0 && (
          <span className="font-mono text-xs text-ink-muted" aria-label={`Run ${runId}`}>
            {shortId}
          </span>
        )}
      </div>

      {message.shortResult !== undefined && message.shortResult.length > 0 && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink">
          {message.shortResult}
        </p>
      )}

      {unavailable && (
        <p className="mt-1 text-xs text-ink-muted">Run details no longer available.</p>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Link
          href={runHref}
          aria-label="View run details"
          aria-disabled={linksDisabled ? "true" : undefined}
          tabIndex={linksDisabled ? -1 : undefined}
          className={`${linkBaseClass} ${linksDisabled ? linkDisabledClass : ""}`}
        >
          <span aria-hidden="true">▶</span>
        </Link>
        <Link
          href={evidenceHref}
          aria-label="View evidence manifest"
          aria-disabled={linksDisabled ? "true" : undefined}
          tabIndex={linksDisabled ? -1 : undefined}
          className={`${linkBaseClass} ${linksDisabled ? linkDisabledClass : ""}`}
        >
          <span aria-hidden="true">≡</span>
        </Link>
      </div>
    </div>
  );
}

export default RunSummaryCard;
