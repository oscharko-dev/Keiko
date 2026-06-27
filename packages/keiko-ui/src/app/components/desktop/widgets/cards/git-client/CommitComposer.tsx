"use client";

// Commit composer (Issue #1575, Epic #1571). Pinned beneath the changed-file list: a summary line,
// an optional description body, a live but secondary commit-policy preview, and the commit action —
// all executed through the existing governed commit preview/execute routes via the injected seam.
//
// The commit button is gated by the single hard signal `messageValidation.ok` (a content-free,
// server-resolved policy result); quality warnings are advisory and never block. Visible product
// text says "Git" only (contract §7); styles compose existing globals.css tokens (ADR-0051).

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { GitDeliveryCommitPreviewResponse } from "@/lib/api";
import { Icons } from "../../../Icons";
import { violationLabel, warningLabel } from "./git-client-seam";
import type { GitMutationOutcome } from "./git-client-seam";
import { CodeList, FieldLabel, MutationOutcome, StatusPill } from "./git-client-ui";
import {
  ACTION_ROW_STYLE,
  COMMIT_PANEL_STYLE,
  disabledStyle,
  INPUT_STYLE,
  MONO_INLINE_STYLE,
  PREVIEW_STYLE,
  PRIMARY_BTN,
  SUBTLE_TEXT_STYLE,
  TEXTAREA_STYLE,
} from "./git-client-styles";

const PREVIEW_DEBOUNCE_MS = 400;

interface CommitComposerProps {
  /** Non-empty when a repository is selected; the composer is inert otherwise. */
  readonly projectId: string | null;
  readonly stagedFileCount: number;
  readonly busy: boolean;
  readonly outcome: GitMutationOutcome | null;
  readonly error: string | null;
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly previewError: string | null;
  readonly onPreview: (messageDraft: string) => void;
  readonly onCommit: (message: string) => void;
}

/** Compose the git commit message from the subject line and the optional body. */
export function composeCommitMessage(summary: string, body: string): string {
  const subject = summary.trim();
  const detail = body.trim();
  return detail === "" ? subject : `${subject}\n\n${detail}`;
}

export function CommitComposer({
  projectId,
  stagedFileCount,
  busy,
  outcome,
  error,
  preview,
  previewError,
  onPreview,
  onCommit,
}: CommitComposerProps): ReactNode {
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const baseId = useId();
  const summaryId = `${baseId}-summary`;
  const bodyId = `${baseId}-body`;
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;

  const hasRepository = projectId !== null && projectId !== "";
  const hasStaged = stagedFileCount > 0;
  const message = composeCommitMessage(summary, body);
  const subjectEmpty = summary.trim() === "";

  // Live, secondary policy preview: re-validate the draft against the current staged set, debounced.
  useEffect(() => {
    if (!hasRepository || !hasStaged) return;
    const handle = setTimeout(() => onPreviewRef.current(message), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [hasRepository, hasStaged, message, stagedFileCount]);

  // The single hard gate. Warnings never disable; an unmet policy (validation.ok === false) does.
  const policyBlocked = preview !== null && !preview.messageValidation.ok;
  const commitDisabled = busy || !hasRepository || !hasStaged || subjectEmpty || policyBlocked;

  let hint: string;
  if (!hasRepository) hint = "Select a repository to commit.";
  else if (!hasStaged) hint = "Stage changes to commit them to the current branch.";
  else if (subjectEmpty) hint = "Enter a commit summary.";
  else if (policyBlocked) hint = "Resolve the commit-policy issues below to commit.";
  else hint = "Commits the staged changes to the current branch.";

  return (
    <section style={COMMIT_PANEL_STYLE} aria-label="Commit">
      <FieldLabel label="Summary" htmlFor={summaryId}>
        <input
          id={summaryId}
          type="text"
          style={INPUT_STYLE}
          value={summary}
          disabled={!hasRepository}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Concise summary of the change"
        />
      </FieldLabel>
      <FieldLabel label="Description" htmlFor={bodyId}>
        <textarea
          id={bodyId}
          style={TEXTAREA_STYLE}
          value={body}
          disabled={!hasRepository}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Optional — explain the intent and verification"
        />
      </FieldLabel>
      <div style={ACTION_ROW_STYLE}>
        <p style={{ ...SUBTLE_TEXT_STYLE, flex: 1, minWidth: 0 }}>{hint}</p>
        <button
          type="button"
          style={{ ...PRIMARY_BTN, ...disabledStyle(commitDisabled) }}
          disabled={commitDisabled}
          onClick={() => onCommit(message)}
        >
          <Icons.check size={12} /> Commit
          {hasStaged ? ` ${stagedFileCount.toString()}` : ""}
        </button>
      </div>
      {previewError !== null ? (
        <div role="alert" style={{ ...PREVIEW_STYLE, borderColor: "var(--feedback-danger)" }}>
          <StatusPill tone="danger">
            <Icons.info size={11} /> Preview unavailable
          </StatusPill>
          <p style={SUBTLE_TEXT_STYLE}>{previewError}</p>
        </div>
      ) : null}
      {preview !== null ? <CommitPolicyPreview preview={preview} /> : null}
      <MutationOutcome outcome={outcome} error={error} testid="git-commit-outcome" />
    </section>
  );
}

// Secondary policy preview: the change summary, optional scaffolding suggestion, soft quality
// warnings, hard message-policy violations, and preflight findings — present but subordinate to
// the commit flow. All inputs are content-free typed codes/counts.
function CommitPolicyPreview({
  preview,
}: {
  readonly preview: GitDeliveryCommitPreviewResponse;
}): ReactNode {
  const violations = preview.messageValidation.ok ? [] : preview.messageValidation.violations;
  const blocked = !preview.messageValidation.ok;
  const { summary, intent } = preview;
  return (
    <div data-testid="git-commit-preview" style={PREVIEW_STYLE}>
      <div
        style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}
      >
        <StatusPill tone={blocked ? "danger" : "success"}>
          <Icons.check size={11} /> {blocked ? "Policy: action needed" : "Meets commit policy"}
        </StatusPill>
        <p style={{ ...SUBTLE_TEXT_STYLE, color: "var(--text-primary)" }}>
          {summary.stagedFileCount.toString()} staged file
          {summary.stagedFileCount === 1 ? "" : "s"} across {summary.areaCount.toString()} area
          {summary.areaCount === 1 ? "" : "s"}
          {summary.touchesTests ? " · touches tests" : ""}
        </p>
      </div>
      {intent.suggestedSubjectPrefix !== undefined ? (
        <p style={{ ...SUBTLE_TEXT_STYLE, color: "var(--text-primary)" }}>
          Suggested prefix: <code style={MONO_INLINE_STYLE}>{intent.suggestedSubjectPrefix}</code>
        </p>
      ) : null}
      <CodeList
        label="Message-policy violations"
        testid="git-commit-violations"
        items={violations.map((v) => ({ key: v, text: violationLabel(v) }))}
      />
      <CodeList
        label="Quality warnings"
        testid="git-commit-warnings"
        items={intent.warnings.map((w) => ({ key: w, text: warningLabel(w) }))}
      />
      <CodeList
        label="Preflight findings"
        testid="git-commit-findings"
        items={preview.preflightFindingCodes.map((c) => ({ key: c, text: c }))}
      />
    </div>
  );
}
