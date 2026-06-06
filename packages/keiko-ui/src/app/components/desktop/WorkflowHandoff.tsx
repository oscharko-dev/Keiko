"use client";

// Issue #153 — governed workflow handoff inside the Conversation Center.
//
// Three pieces:
//
//   1. LaunchWorkflowButton — composer affordance. Renders ONLY when the currently selected
//      model passes the stricter workflow-eligibility filter (chat + tool calling + structured
//      output). When the user clicks it, a picker dialog opens (AC#1 explicit action). The
//      button is hidden when there is no eligible model so the user is never tempted to launch
//      something that would fail at the BFF boundary.
//
//   2. WorkflowPickerDialog — modal picker that lists `CHAT_WORKFLOW_CATALOG` entries and, once
//      a workflow is chosen, shows a single free-text input matched to the chosen workflow's
//      prompt (target file for unit-tests, description for bug-investigation). Submitting calls
//      `launchWorkflowFromConversation` on the chat session, which POSTs to /api/chats/runs.
//
//   3. RunSummaryCard — inline rendering of a `role:"system"` chat message that carries
//      workflow run metadata (workflowId, status, runId, shortResult). This replaces the
//      previous behaviour of `visibleOnly` filtering systems out of the chat log, but only for
//      messages that DO carry a runId (so non-run system messages keep their hidden semantics).
//
// AC#4: this surface NEVER renders patch-apply or shell-exec affordances. Apply and command
// execution stay behind the existing workflow surfaces (NewWindowDialog → RunWindow).

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icons } from "./Icons";
import { CHAT_WORKFLOW_CATALOG, findChatWorkflow } from "@/lib/chat-workflow-catalog";
import { isWorkflowEligibleModel } from "@/lib/workflow-eligibility";
import type { ChatMessage, ModelCapability } from "@/lib/types";
import type {
  LaunchWorkflowFromConversationInput,
  LaunchWorkflowFromConversationResult,
} from "./hooks/useChatSession";

// ─── 1. Launch button + picker dialog ────────────────────────────────────────

export interface LaunchWorkflowButtonProps {
  readonly selectedModel: ModelCapability | undefined;
  readonly launch: (
    input: LaunchWorkflowFromConversationInput,
  ) => Promise<LaunchWorkflowFromConversationResult>;
}

export function LaunchWorkflowButton({
  selectedModel,
  launch,
}: LaunchWorkflowButtonProps): ReactNode {
  const [pickerOpen, setPickerOpen] = useState(false);
  // WH-02 (WCAG 2.4.3): return focus to the trigger when the dialog closes.
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Hidden affordance when the selected model isn't workflow-eligible — AC#2 stricter filter.
  if (selectedModel === undefined || !isWorkflowEligibleModel(selectedModel)) {
    return null;
  }
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="cmp-mode"
        title="Launch a governed workflow with the current model"
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen(true)}
      >
        <Icons.spark size={14} style={{ color: "var(--accent)" }} /> Launch workflow
        <Icons.chevron size={12} />
      </button>
      {pickerOpen ? (
        <WorkflowPickerDialog
          modelId={selectedModel.id}
          launch={launch}
          onClose={() => {
            setPickerOpen(false);
            triggerRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

interface WorkflowPickerDialogProps {
  readonly modelId: string;
  readonly launch: (
    input: LaunchWorkflowFromConversationInput,
  ) => Promise<LaunchWorkflowFromConversationResult>;
  readonly onClose: () => void;
}

// WH-03: enabled, in-DOM-order focusable descendants used for the modal focus
// loop. Excludes the dialog container's own tabIndex={-1} and any disabled or
// explicitly-removed (tabindex="-1") controls.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): readonly HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

// Two-step dialog: pick a workflow, then provide the single free-text input the catalog entry
// declares. Submitting calls `launch` and closes on ok; on failure renders an inline alert
// without dismissing the dialog so the user can retry.
function WorkflowPickerDialog({ modelId, launch, onClose }: WorkflowPickerDialogProps): ReactNode {
  const titleId = useId();
  const inputId = useId();
  const [workflowId, setWorkflowId] = useState<string | undefined>();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const entry = workflowId === undefined ? undefined : findChatWorkflow(workflowId);

  // Focus the dialog container on mount so screen-reader users land inside the modal. The first
  // focusable child receives focus on tab.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Close on Escape (WCAG 2.1.2) and trap Tab focus within the dialog (WH-03,
  // WCAG 2.1.2 "No Keyboard Trap" applied as a modal focus loop): Tab past the
  // last focusable wraps to the first, Shift+Tab before the first wraps to the
  // last, so keyboard focus never escapes the modal to the obscured background.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusables = getFocusable(dialog);
      if (focusables.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSubmit(): Promise<void> {
    if (entry === undefined || text.trim().length === 0) return;
    setSubmitting(true);
    setError(undefined);
    const outcome = await launch({ workflowId: entry.workflowId, modelId, text });
    setSubmitting(false);
    if (outcome.ok) {
      onClose();
      return;
    }
    setError(humanReason(outcome));
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="wf-dialog-overlay"
    >
      <div className="wf-dialog">
        <h2 id={titleId} className="wf-dialog-title">
          Launch workflow
        </h2>
        {entry === undefined ? (
          <ul className="wf-dialog-list" aria-label="Available workflows">
            {CHAT_WORKFLOW_CATALOG.map((item) => (
              <li key={item.workflowId}>
                <button
                  type="button"
                  className="wf-dialog-choice"
                  onClick={() => setWorkflowId(item.workflowId)}
                >
                  <span className="wf-dialog-choice-label">{item.label}</span>
                  <span className="wf-dialog-choice-desc">{item.description}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="wf-dialog-form">
            <p className="wf-dialog-form-desc">{entry.description}</p>
            <label className="wf-dialog-field" htmlFor={inputId}>
              {entry.prompt}
            </label>
            <textarea
              id={inputId}
              className="wf-dialog-input mono"
              rows={3}
              placeholder={entry.placeholder}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            {error !== undefined ? (
              <div role="alert" className="wf-dialog-error">
                {error}
              </div>
            ) : null}
            <div className="wf-dialog-actions">
              <button
                type="button"
                className="wf-dialog-cancel"
                onClick={() => setWorkflowId(undefined)}
              >
                Back
              </button>
              <button
                type="button"
                className="wf-dialog-launch"
                disabled={submitting || text.trim().length === 0}
                onClick={() => {
                  void handleSubmit();
                }}
              >
                {submitting ? "Launching…" : "Launch"}
              </button>
            </div>
          </div>
        )}
        <button
          type="button"
          className="wf-dialog-close"
          aria-label="Close launch workflow"
          onClick={onClose}
        >
          <Icons.close size={14} />
        </button>
      </div>
    </div>
  );
}

function humanReason(outcome: { reason: string; message?: string | undefined }): string {
  if (outcome.message !== undefined && outcome.message.length > 0) return outcome.message;
  switch (outcome.reason) {
    case "not-workflow-eligible":
      return "The selected model does not support workflow runs. Pick a model with tool calling and structured output.";
    case "unknown-workflow":
      return "That workflow is no longer available.";
    case "missing-chat":
      return "Open or create a chat first, then launch the workflow.";
    case "missing-input":
      return "Provide an input before launching the workflow.";
    case "request-failed":
      return "Could not launch the workflow. Try again, or check the gateway logs.";
    default:
      return "Could not launch the workflow.";
  }
}

// ─── 3. Run summary card for system chat messages ────────────────────────────

export interface RunSummaryCardProps {
  readonly message: ChatMessage;
}

// A system message qualifies as a "run summary" when it carries a runId. Without one we keep
// the historical "system messages are filtered out" behaviour (handled by the caller).
export function isRunSummaryMessage(message: ChatMessage): boolean {
  return message.role === "system" && typeof message.runId === "string";
}

export function RunSummaryCard({ message }: RunSummaryCardProps): ReactNode {
  const status = message.workflowStatus ?? "queued";
  const workflowLabel = message.workflowId ?? message.taskType ?? "workflow";
  const runIdShort = message.runId === undefined ? "" : message.runId.slice(0, 8);
  return (
    <article
      className="run-summary-card"
      data-testid="run-summary-card"
      data-status={status}
      role="group"
      aria-label={`Workflow run ${workflowLabel} — ${status}`}
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
            run <span data-runid={message.runId}>{message.runId}</span>{" "}
            <span className="run-summary-card-runshort">({runIdShort})</span>
          </p>
        ) : null}
      </div>
    </article>
  );
}
