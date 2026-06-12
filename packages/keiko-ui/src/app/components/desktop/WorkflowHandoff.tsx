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
import { createPortal } from "react-dom";
import { Icons } from "./Icons";
import { CHAT_WORKFLOW_CATALOG, findChatWorkflow } from "@/lib/chat-workflow-catalog";
import { isWorkflowEligibleModel } from "@/lib/workflow-eligibility";
import type {
  ChatMessage,
  ExpectedCheck,
  GroundedAnswer,
  ModelCapability,
  WorkflowKind,
} from "@/lib/types";
import type {
  LaunchGroundedWorkflowHandoffInput,
  LaunchGroundedWorkflowHandoffResult,
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

  // Focus the dialog container on mount AND on every step transition (list → form via a workflow
  // choice, form → list via Back), so keyboard/screen-reader users land inside the new view instead
  // of on <body> when the previously-focused choice/Back button unmounts (WCAG 2.4.3). The first
  // focusable child receives focus on the next Tab.
  useEffect(() => {
    dialogRef.current?.focus();
  }, [workflowId]);

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

  // Like GatewaySetupDialog (issue #422): ancestors include `.ws-scene`, whose
  // transform/zoom makes it the containing block for `position: fixed`
  // descendants, so the overlay would collapse to the 0x0 scene origin instead
  // of covering the viewport. Portalling to document.body keeps the backdrop
  // viewport-fixed. The focus trap is window-level and dialogRef-based, so it
  // is portal-safe.
  const dialogTree = (
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
  if (typeof document === "undefined") return dialogTree;
  return createPortal(dialogTree, document.body);
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

const GROUNDED_WORKFLOW_CHOICES: ReadonlyArray<{
  readonly workflowKind: WorkflowKind;
  readonly label: string;
  readonly description: string;
}> = [
  {
    workflowKind: "unit-test-generation",
    label: "Generate unit tests",
    description:
      "Use the grounded evidence as read-only context and propose in-scope test changes.",
  },
  {
    workflowKind: "bug-investigation",
    label: "Investigate bug",
    description:
      "Investigate a bug against the grounded evidence and keep writes inside approved paths.",
  },
  {
    workflowKind: "verification",
    label: "Run verification",
    description:
      "Run verification against the grounded workspace context without granting write access.",
  },
] as const;

const GROUNDED_CHECK_CHOICES: readonly ExpectedCheck[] = [
  "verify",
  "lint",
  "typecheck",
  "tests",
  "manual",
] as const;

function defaultChecks(workflowKind: WorkflowKind): readonly ExpectedCheck[] {
  return workflowKind === "unit-test-generation" ? ["tests"] : ["verify"];
}

function splitLines(value: string): readonly string[] {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function groundedHumanReason(outcome: LaunchGroundedWorkflowHandoffResult): string {
  if (outcome.ok) return "";
  if (outcome.message !== undefined && outcome.message.length > 0) return outcome.message;
  switch (outcome.reason) {
    case "missing-chat":
      return "Open a chat with the grounded answer you want to hand off.";
    case "missing-model":
      return "Pick a model before launching the grounded workflow.";
    default:
      return "Could not launch the grounded workflow.";
  }
}

function buildGroundedInput(
  workflowKind: WorkflowKind,
  unitTargetMode: "file" | "module" | "changedFiles",
  unitTargetValue: string,
  bugDescription: string,
  bugTargetFiles: string,
  verifyTargetFiles: string,
):
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  if (workflowKind === "unit-test-generation") {
    if (unitTargetMode === "changedFiles") {
      const filePaths = splitLines(unitTargetValue);
      return filePaths.length === 0
        ? { ok: false, message: "Provide at least one changed file." }
        : { ok: true, input: { target: { kind: "changedFiles", filePaths } } };
    }
    const trimmed = unitTargetValue.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        message:
          unitTargetMode === "module" ? "Provide a module directory." : "Provide a target file.",
      };
    }
    return unitTargetMode === "module"
      ? { ok: true, input: { target: { kind: "module", moduleDir: trimmed } } }
      : { ok: true, input: { target: { kind: "file", filePath: trimmed } } };
  }
  if (workflowKind === "bug-investigation") {
    const targetFiles = splitLines(bugTargetFiles);
    const description = bugDescription.trim();
    if (description.length === 0 && targetFiles.length === 0) {
      return {
        ok: false,
        message: "Provide at least a bug description or one suspected target file.",
      };
    }
    return {
      ok: true,
      input: {
        report: {
          ...(description.length === 0 ? {} : { description }),
          ...(targetFiles.length === 0 ? {} : { targetFiles }),
        },
      },
    };
  }
  const targetFiles = splitLines(verifyTargetFiles);
  return {
    ok: true,
    input: targetFiles.length === 0 ? {} : { targetFiles },
  };
}

export interface LaunchGroundedWorkflowButtonProps {
  readonly answer: GroundedAnswer | undefined;
  readonly modelId: string | undefined;
  readonly busy?: boolean | undefined;
  readonly launch: (
    input: LaunchGroundedWorkflowHandoffInput,
  ) => Promise<LaunchGroundedWorkflowHandoffResult>;
}

function isMultiSourceConnectedAnswer(
  answer: Extract<GroundedAnswer, { readonly groundingKind: "connected-context" }>,
): boolean {
  return answer.citations.some((citation) => citation.source !== undefined);
}

export function LaunchGroundedWorkflowButton({
  answer,
  modelId,
  busy,
  launch,
}: LaunchGroundedWorkflowButtonProps): ReactNode {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const busyHintId = useId();
  if (
    answer === undefined ||
    answer.groundingKind !== "connected-context" ||
    modelId === undefined ||
    isMultiSourceConnectedAnswer(answer)
  ) {
    return null;
  }
  // WCAG 4.1.2: when a run is in flight the trigger stays in the tab order (aria-disabled, not the
  // native `disabled` attribute) and points at an sr-only hint, so a keyboard/screen-reader user can
  // reach it and hear WHY it is unavailable instead of a silent "dimmed" button. The onClick guard
  // enforces the blocked state.
  const isBusy = busy === true;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="cmp-mode"
        title="Launch a governed workflow from this grounded answer"
        aria-haspopup="dialog"
        aria-disabled={isBusy || undefined}
        aria-describedby={isBusy ? busyHintId : undefined}
        onClick={() => {
          if (isBusy) return;
          setOpen(true);
        }}
      >
        <Icons.spark size={14} style={{ color: "var(--accent)" }} /> Launch grounded workflow
        <Icons.chevron size={12} />
      </button>
      {isBusy ? (
        <span className="sr-only" id={busyHintId}>
          A run is in progress. Wait for it to complete before launching another grounded workflow.
        </span>
      ) : null}
      {open ? (
        <GroundedWorkflowDialog
          answer={answer}
          modelId={modelId}
          launch={launch}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

interface GroundedWorkflowDialogProps {
  readonly answer: Extract<GroundedAnswer, { readonly groundingKind: "connected-context" }>;
  readonly modelId: string;
  readonly launch: (
    input: LaunchGroundedWorkflowHandoffInput,
  ) => Promise<LaunchGroundedWorkflowHandoffResult>;
  readonly onClose: () => void;
}

function GroundedWorkflowDialog({
  answer,
  modelId,
  launch,
  onClose,
}: GroundedWorkflowDialogProps): ReactNode {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [workflowKind, setWorkflowKind] = useState<WorkflowKind | undefined>();
  const [unitTargetMode, setUnitTargetMode] = useState<"file" | "module" | "changedFiles">("file");
  const [unitTargetValue, setUnitTargetValue] = useState("");
  const [bugDescription, setBugDescription] = useState("");
  const [bugTargetFiles, setBugTargetFiles] = useState("");
  const [verifyTargetFiles, setVerifyTargetFiles] = useState("");
  const [editablePaths, setEditablePaths] = useState("");
  const [unknowns, setUnknowns] = useState("");
  const [expectedChecks, setExpectedChecks] = useState<readonly ExpectedCheck[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Focus the dialog container on mount AND on every step transition (choice → form, Back → choice)
  // so focus is never dropped onto <body> when the previously-focused control unmounts (WCAG 2.4.3).
  useEffect(() => {
    dialogRef.current?.focus();
  }, [workflowKind]);

  useEffect(() => {
    if (workflowKind !== undefined) {
      setExpectedChecks(defaultChecks(workflowKind));
    }
  }, [workflowKind]);

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

  function toggleCheck(check: ExpectedCheck): void {
    setExpectedChecks((current) =>
      current.includes(check) ? current.filter((entry) => entry !== check) : [...current, check],
    );
  }

  async function handleSubmit(): Promise<void> {
    if (workflowKind === undefined) return;
    const built = buildGroundedInput(
      workflowKind,
      unitTargetMode,
      unitTargetValue,
      bugDescription,
      bugTargetFiles,
      verifyTargetFiles,
    );
    if (!built.ok) {
      setError(built.message);
      return;
    }
    if (expectedChecks.length === 0) {
      setError("Select at least one expected check.");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    const outcome = await launch({
      assistantMessageId: answer.assistantMessageId,
      modelId,
      workflowKind,
      input: built.input,
      editablePaths: splitLines(editablePaths),
      expectedChecks,
      unknowns: splitLines(unknowns),
    });
    setSubmitting(false);
    if (outcome.ok) {
      onClose();
      return;
    }
    setError(groundedHumanReason(outcome));
  }

  const choice = GROUNDED_WORKFLOW_CHOICES.find((entry) => entry.workflowKind === workflowKind);

  // Portal to document.body for the same reason as WorkflowPickerDialog above
  // (transformed `.ws-scene` ancestor breaks `position: fixed`).
  const dialogTree = (
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
          Grounded workflow handoff
        </h2>
        {choice === undefined ? (
          <ul className="wf-dialog-list" aria-label="Available grounded workflows">
            {GROUNDED_WORKFLOW_CHOICES.map((entry) => (
              <li key={entry.workflowKind}>
                <button
                  type="button"
                  className="wf-dialog-choice"
                  onClick={() => setWorkflowKind(entry.workflowKind)}
                >
                  <span className="wf-dialog-choice-label">{entry.label}</span>
                  <span className="wf-dialog-choice-desc">{entry.description}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="wf-dialog-form">
            <p className="wf-dialog-form-desc">{choice.description}</p>
            {workflowKind === "unit-test-generation" ? (
              <>
                <label className="wf-dialog-field">
                  Target mode
                  <select
                    className="wf-dialog-input mono"
                    value={unitTargetMode}
                    onChange={(event) =>
                      setUnitTargetMode(event.target.value as "file" | "module" | "changedFiles")
                    }
                  >
                    <option value="file">File</option>
                    <option value="module">Module</option>
                    <option value="changedFiles">Changed files</option>
                  </select>
                </label>
                <label className="wf-dialog-field">
                  {unitTargetMode === "module"
                    ? "Module directory"
                    : unitTargetMode === "changedFiles"
                      ? "Changed files (one per line)"
                      : "Target file"}
                  <textarea
                    className="wf-dialog-input mono"
                    rows={unitTargetMode === "changedFiles" ? 3 : 2}
                    value={unitTargetValue}
                    onChange={(event) => setUnitTargetValue(event.target.value)}
                    placeholder={
                      unitTargetMode === "module"
                        ? "src/components"
                        : unitTargetMode === "changedFiles"
                          ? "src/a.ts\nsrc/b.ts"
                          : "src/example.ts"
                    }
                  />
                </label>
              </>
            ) : null}
            {workflowKind === "bug-investigation" ? (
              <>
                <label className="wf-dialog-field">
                  Bug description
                  <textarea
                    className="wf-dialog-input mono"
                    rows={3}
                    value={bugDescription}
                    onChange={(event) => setBugDescription(event.target.value)}
                    placeholder="Describe the failing behavior or regression."
                  />
                </label>
                <label className="wf-dialog-field">
                  Suspected target files (one per line)
                  <textarea
                    className="wf-dialog-input mono"
                    rows={2}
                    value={bugTargetFiles}
                    onChange={(event) => setBugTargetFiles(event.target.value)}
                    placeholder="src/app.ts\nsrc/lib/foo.ts"
                  />
                </label>
              </>
            ) : null}
            {workflowKind === "verification" ? (
              <label className="wf-dialog-field">
                Target files (optional, one per line)
                <textarea
                  className="wf-dialog-input mono"
                  rows={2}
                  value={verifyTargetFiles}
                  onChange={(event) => setVerifyTargetFiles(event.target.value)}
                  placeholder="src/app.ts\nsrc/lib/foo.ts"
                />
              </label>
            ) : null}
            <label className="wf-dialog-field">
              Editable paths (explicit, workspace-relative, one per line)
              <textarea
                className="wf-dialog-input mono"
                rows={3}
                value={editablePaths}
                onChange={(event) => setEditablePaths(event.target.value)}
                placeholder="src/example.test.ts"
              />
            </label>
            <fieldset className="wf-dialog-field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>Expected checks</legend>
              <div className="wf-dialog-form" style={{ gap: 8 }}>
                {GROUNDED_CHECK_CHOICES.map((check) => (
                  <label
                    key={check}
                    className="wf-dialog-choice-desc"
                    style={{ display: "flex", gap: 8 }}
                  >
                    <input
                      type="checkbox"
                      checked={expectedChecks.includes(check)}
                      onChange={() => toggleCheck(check)}
                    />
                    <span>{check}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="wf-dialog-field">
              Unknowns (optional, one per line)
              <textarea
                className="wf-dialog-input mono"
                rows={2}
                value={unknowns}
                onChange={(event) => setUnknowns(event.target.value)}
                placeholder="Need confirmation on public API behavior"
              />
            </label>
            {error !== undefined ? (
              <div role="alert" className="wf-dialog-error">
                {error}
              </div>
            ) : null}
            <div className="wf-dialog-actions">
              <button
                type="button"
                className="wf-dialog-cancel"
                onClick={() => setWorkflowKind(undefined)}
              >
                Back
              </button>
              <button
                type="button"
                className="wf-dialog-launch"
                disabled={submitting}
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
          aria-label="Close grounded workflow handoff"
          onClick={onClose}
        >
          <Icons.close size={14} />
        </button>
      </div>
    </div>
  );
  if (typeof document === "undefined") return dialogTree;
  return createPortal(dialogTree, document.body);
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

  // WCAG 4.1.3: the card's aria-label changes when the run completes (running → succeeded/failed),
  // but AT does not re-read a static container on re-render, so a screen-reader user never hears the
  // run finish. An always-mounted polite live region carries the announcement. It stays EMPTY until
  // the status actually changes after mount, so loading a chat log full of historical cards does not
  // fire a burst of stale announcements (same gating idea as RunLauncher's progress region).
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
      </div>
      <p className="sr-only" role="status" aria-live="polite" data-testid="run-summary-card-sr">
        {announcement}
      </p>
    </article>
  );
}
