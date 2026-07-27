"use client";

// Commit composer (Issue #1575, Epic #1571 — "Git Window" redesign). Pinned beneath the changed-file
// list: a summary line, an optional description body, a live but secondary commit-policy preview, the
// commit action, and the PR/Merge flow row. All execution runs through the existing governed commit
// preview/execute routes via the injected seam.
//
// The commit button is gated by the single hard signal `messageValidation.ok` (a content-free,
// server-resolved policy result); quality warnings are advisory and never block. Visible product text
// says "Git" only (contract §7); styles compose existing globals.css tokens (ADR-0051). AI-suggestion
// affordances from the redesign render only when a genuine suggestion exists — never fabricated.
// See ADR-0098 for the git-client window conventions.

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { GitDeliveryCommitPreviewResponse } from "@/lib/api";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import { Icons } from "../../../Icons";
import type { GitMutationOutcome } from "./git-client-seam";
import { CodeList, MutationOutcome, StatusPill } from "./git-client-ui";
import {
  COMMIT_PANEL_STYLE,
  DESCRIPTION_FIELD_STYLE,
  disabledStyle,
  FLOW_ROW_STYLE,
  MONO_INLINE_STYLE,
  PREVIEW_STYLE,
  PRIMARY_BTN,
  SECONDARY_BTN,
  SUBTLE_TEXT_STYLE,
  summaryFieldStyle,
} from "./git-client-styles";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const PullRequestIcon = Icons.pullRequest;
const MergeIcon = Icons.merge;
const CommitIcon = Icons.commit;

const PREVIEW_DEBOUNCE_MS = 400;
const InfoIcon = Icons.info;
const CheckIcon = Icons.check;

interface CommitComposerProps {
  /** Non-empty when a repository is selected; the composer is inert otherwise. */
  readonly projectId: string | null;
  readonly branchName?: string | undefined;
  readonly stagedFileCount: number;
  readonly busy: boolean;
  readonly outcome: GitMutationOutcome | null;
  readonly error: string | null;
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly previewDraft: string | null;
  readonly previewError: string | null;
  readonly onPreview: (messageDraft: string) => void;
  readonly onCommit: (message: string) => void;
  readonly onCreatePullRequest?: (() => void) | undefined;
  readonly onMerge?: (() => void) | undefined;
}

/** Compose the git commit message from the subject line and the optional body. */
export function composeCommitMessage(summary: string, body: string): string {
  const subject = summary.trim();
  const detail = body.trim();
  return detail === "" ? subject : `${subject}\n\n${detail}`;
}

function commitHint(
  hasRepository: boolean,
  hasStaged: boolean,
  subjectEmpty: boolean,
  missingFreshPreview: boolean,
  policyBlocked: boolean,
  t: OptionalWidgetTranslate,
): string {
  if (!hasRepository) return t("commitComposer.hint.selectRepository");
  if (!hasStaged) return t("commitComposer.hint.stageChanges");
  if (subjectEmpty) return t("commitComposer.hint.enterSummary");
  if (missingFreshPreview) return t("commitComposer.hint.waitPreview");
  if (policyBlocked) return t("commitComposer.hint.resolvePolicy");
  return t("commitComposer.hint.commitsStaged");
}

interface CommitFlowActionsProps {
  readonly hasRepository: boolean;
  readonly onCreatePullRequest: (() => void) | undefined;
  readonly onMerge: (() => void) | undefined;
  readonly t: OptionalWidgetTranslate;
}

function CommitFlowActions({
  hasRepository,
  onCreatePullRequest,
  onMerge,
  t,
}: CommitFlowActionsProps): ReactNode {
  if (onCreatePullRequest === undefined && onMerge === undefined) return null;
  return (
    <div style={FLOW_ROW_STYLE}>
      {onCreatePullRequest !== undefined ? (
        <button
          type="button"
          style={{ ...SECONDARY_BTN, flex: 1, ...disabledStyle(!hasRepository) }}
          disabled={!hasRepository}
          onClick={onCreatePullRequest}
        >
          <span style={{ color: "var(--fg-dim)" }}>
            <PullRequestIcon size={16} />
          </span>
          {t("commitComposer.action.createPullRequest")}
        </button>
      ) : null}
      {onMerge !== undefined ? (
        <button
          type="button"
          style={{ ...SECONDARY_BTN, flex: 1, ...disabledStyle(!hasRepository) }}
          disabled={!hasRepository}
          onClick={onMerge}
        >
          <span style={{ color: "var(--fg-dim)" }}>
            <MergeIcon size={16} />
          </span>
          {t("commitComposer.action.merge")}
        </button>
      ) : null}
    </div>
  );
}

export function CommitComposer({
  projectId,
  branchName,
  stagedFileCount,
  busy,
  outcome,
  error,
  preview,
  previewDraft,
  previewError,
  onPreview,
  onCommit,
  onCreatePullRequest,
  onMerge,
}: CommitComposerProps): ReactNode {
  const t = useOptionalWidgetTranslate();
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const baseId = useId();
  const hintId = `${baseId}-hint`;
  const previewId = `${baseId}-preview`;
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;

  const hasRepository = projectId !== null && projectId !== "";
  const hasStaged = stagedFileCount > 0;
  const message = composeCommitMessage(summary, body);
  const subjectEmpty = summary.trim() === "";

  // Live, secondary policy preview: re-validate the draft against the current staged set, debounced.
  useEffect(() => {
    if (!hasRepository || !hasStaged || subjectEmpty) return;
    const handle = setTimeout(() => onPreviewRef.current(message), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [hasRepository, hasStaged, message, stagedFileCount, subjectEmpty]);

  const visiblePreview = preview !== null && previewDraft === message ? preview : null;
  // The single hard gate. Warnings never disable; an unmet policy (validation.ok === false) does.
  // A matching successful preview is required before execute so a stale or missing preview cannot
  // drive the commit button for the wrong draft.
  const policyBlocked = visiblePreview !== null && !visiblePreview.messageValidation.ok;
  const missingFreshPreview = !subjectEmpty && visiblePreview === null;
  const commitDisabled =
    busy || !hasRepository || !hasStaged || subjectEmpty || missingFreshPreview || policyBlocked;

  const hint = commitHint(
    hasRepository,
    hasStaged,
    subjectEmpty,
    missingFreshPreview,
    policyBlocked,
    t,
  );

  const commitLabel =
    branchName !== undefined && branchName !== ""
      ? t("commitComposer.action.commitTo", { branch: branchName })
      : t("commitComposer.action.commit");

  return (
    <section style={COMMIT_PANEL_STYLE} aria-label={t("commitComposer.action.commit")}>
      <input
        type="text"
        aria-label={t("commitComposer.field.summary")}
        style={summaryFieldStyle(false)}
        value={summary}
        disabled={!hasRepository}
        aria-invalid={policyBlocked ? "true" : undefined}
        aria-describedby={policyBlocked ? previewId : hintId}
        onChange={(e) => setSummary(e.target.value)}
        placeholder={t("commitComposer.field.summaryPlaceholder")}
      />
      <textarea
        aria-label={t("commitComposer.field.description")}
        style={DESCRIPTION_FIELD_STYLE}
        value={body}
        disabled={!hasRepository}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t("commitComposer.field.descriptionPlaceholder")}
      />
      <p
        id={hintId}
        role="status"
        aria-live="polite"
        style={{ ...SUBTLE_TEXT_STYLE, fontSize: 11.5, color: "var(--fg-faint)" }}
      >
        {hint}
      </p>
      <button
        type="button"
        style={{ ...PRIMARY_BTN, width: "100%", ...disabledStyle(commitDisabled) }}
        disabled={commitDisabled}
        aria-describedby={hintId}
        onClick={() => onCommit(message)}
      >
        <CommitIcon size={16} /> {commitLabel}
      </button>
      <CommitFlowActions
        hasRepository={hasRepository}
        onCreatePullRequest={onCreatePullRequest}
        onMerge={onMerge}
        t={t}
      />
      {previewError !== null ? (
        <div
          role="alert"
          style={{
            ...PREVIEW_STYLE,
            boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--danger) 48%, var(--line))",
          }}
        >
          <StatusPill tone="danger">
            <InfoIcon size={11} /> {t("commitComposer.preview.unavailable")}
          </StatusPill>
          <p style={SUBTLE_TEXT_STYLE}>{previewError}</p>
        </div>
      ) : null}
      {visiblePreview !== null ? (
        <CommitPolicyPreview id={previewId} preview={visiblePreview} t={t} />
      ) : null}
      <MutationOutcome outcome={outcome} error={error} testid="git-commit-outcome" />
    </section>
  );
}

// Secondary policy preview: the change summary, optional scaffolding suggestion, soft quality
// warnings, hard message-policy violations, and preflight findings — present but subordinate to
// the commit flow. All inputs are content-free typed codes/counts.
function CommitPolicyPreview({
  id,
  preview,
  t,
}: {
  readonly id: string;
  readonly preview: GitDeliveryCommitPreviewResponse;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  const violations = preview.messageValidation.ok ? [] : preview.messageValidation.violations;
  const blocked = !preview.messageValidation.ok;
  const { summary, intent } = preview;
  return (
    <div
      id={id}
      data-testid="git-commit-preview"
      role={blocked ? "alert" : "status"}
      aria-live={blocked ? undefined : "polite"}
      style={PREVIEW_STYLE}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <StatusPill tone={blocked ? "danger" : "success"}>
          <CheckIcon size={11} />{" "}
          {blocked
            ? t("commitComposer.preview.policyActionNeeded")
            : t("commitComposer.preview.meetsPolicy")}
        </StatusPill>
        <p style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12, color: "var(--fg)" }}>
          {t("commitComposer.preview.summary", {
            files: summary.stagedFileCount,
            fileNoun:
              summary.stagedFileCount === 1
                ? t("commitComposer.preview.fileSingular")
                : t("commitComposer.preview.filePlural"),
            areas: summary.areaCount,
            areaNoun:
              summary.areaCount === 1
                ? t("commitComposer.preview.areaSingular")
                : t("commitComposer.preview.areaPlural"),
            tests: summary.touchesTests ? t("commitComposer.preview.touchesTestsSuffix") : "",
          })}
        </p>
      </div>
      {intent.suggestedSubjectPrefix !== undefined ? (
        <p style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12, color: "var(--fg)" }}>
          {t("commitComposer.preview.suggestedPrefix")}{" "}
          <code style={MONO_INLINE_STYLE}>{intent.suggestedSubjectPrefix}</code>
        </p>
      ) : null}
      <CodeList
        label={t("commitComposer.preview.messageViolations")}
        testid="git-commit-violations"
        items={violations.map((v) => ({ key: v, text: t(`commitComposer.violation.${v}`) }))}
      />
      <CodeList
        label={t("commitComposer.preview.qualityWarnings")}
        testid="git-commit-warnings"
        items={intent.warnings.map((w) => ({ key: w, text: t(`commitComposer.warning.${w}`) }))}
      />
      <CodeList
        label={t("commitComposer.preview.preflightFindings")}
        testid="git-commit-findings"
        items={preview.preflightFindingCodes.map((c) => ({ key: c, text: c }))}
      />
    </div>
  );
}
