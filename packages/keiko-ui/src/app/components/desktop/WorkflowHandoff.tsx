"use client";

// Issue #153 — governed workflow evidence inside the Conversation Center.
//
// RunSummaryCard renders historical workflow run metadata that already exists in the chat log.
// Workflow launches themselves live exclusively in the Agent widget surface.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icons } from "./Icons";
import type { ChatMessage } from "@/lib/types";

export interface RunSummaryCardProps {
  readonly message: ChatMessage;
  readonly onOpenResult?: ((message: ChatMessage) => void) | undefined;
}

// A system message qualifies as a "run summary" when it carries a runId. Without one we keep
// the historical "system messages are filtered out" behaviour (handled by the caller).
export function isRunSummaryMessage(message: ChatMessage): boolean {
  return message.role === "system" && typeof message.runId === "string";
}

export function RunSummaryCard({ message, onOpenResult }: RunSummaryCardProps): ReactNode {
  const status = message.workflowStatus ?? "queued";
  const workflowLabel = message.workflowId ?? message.taskType ?? "workflow";
  const runIdShort = message.runId === undefined ? "" : message.runId.slice(0, 8);
  const evidenceHref =
    message.runId === undefined ? undefined : `/api/evidence/${encodeURIComponent(message.runId)}`;

  // WCAG 4.1.3: the card's aria-label changes when the run completes (running -> succeeded/failed),
  // but AT does not re-read a static container on re-render, so a screen-reader user never hears the
  // run finish. An always-mounted polite live region carries the announcement. It stays empty until
  // the status actually changes after mount, so loading a chat log full of historical cards does not
  // fire a burst of stale announcements.
  const [announcement, setAnnouncement] = useState("");
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current !== status) {
      prevStatusRef.current = status;
      setAnnouncement(`Workflow ${workflowLabel}: ${status}`);
    }
  }, [status, workflowLabel]);

  return (
    <article
      className="run-summary-card"
      data-testid="run-summary-card"
      data-status={status}
      aria-label={`Workflow run ${workflowLabel} - ${status}`}
    >
      <header className="run-summary-card-head">
        <Icons.spark size={14} style={{ color: "var(--accent)" }} />
        <span className="run-summary-card-workflow mono">{workflowLabel}</span>
        <span className="run-summary-card-status" data-status={status}>
          {status}
        </span>
      </header>
      <div className="run-summary-card-body">
        <p className="run-summary-card-line">{message.content}</p>
        {message.shortResult !== undefined && message.shortResult.length > 0 ? (
          <p className="run-summary-card-result">{message.shortResult}</p>
        ) : null}
        {message.runId !== undefined ? (
          <p className="run-summary-card-meta mono">
            run{" "}
            <span
              className="run-summary-card-runshort"
              data-runid={message.runId}
              title={message.runId}
            >
              {runIdShort}
            </span>
          </p>
        ) : null}
        {message.runId !== undefined ? (
          <div className="run-summary-card-actions" aria-label="Workflow result actions">
            {onOpenResult !== undefined ? (
              <button
                type="button"
                className="run-summary-card-action"
                onClick={() => onOpenResult(message)}
              >
                Open result
              </button>
            ) : null}
            {evidenceHref !== undefined ? (
              <a
                className="run-summary-card-action run-summary-card-action-secondary"
                href={evidenceHref}
                target="_blank"
                rel="noreferrer"
              >
                Evidence
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite" data-testid="run-summary-card-sr">
        {announcement}
      </p>
    </article>
  );
}
