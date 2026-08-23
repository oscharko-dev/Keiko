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

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { GitCommitMessageViolationCode } from "@oscharko-dev/keiko-contracts";
import type { GitDeliveryCommitPreviewResponse } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import { Icons } from "../../../Icons";
import type { GitMutationOutcome } from "./git-client-seam";
import { CodeList, MutationOutcome, StatusPill } from "./git-client-ui";
import {
  COMMIT_HEADER_STYLE,
  COMMIT_PANEL_STYLE,
  COMMIT_WORKSPACE_DESCRIPTION_FIELD_STYLE,
  COMMIT_WORKSPACE_PANEL_STYLE,
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
const BranchIcon = Icons.branch;

const PREVIEW_DEBOUNCE_MS = 400;
const InfoIcon = Icons.info;
const CheckIcon = Icons.check;
const SparkIcon = Icons.spark;
const CopyIcon = Icons.copy;

type CommitComposerLayout = "sidebar" | "workspace";

const DRAFT_REVIEW_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  flexWrap: "wrap",
  padding: "10px 11px",
  borderRadius: 9,
  background: "color-mix(in oklch, var(--accent) 9%, var(--inset))",
  boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--accent) 34%, var(--line))",
} as const;

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
  readonly layout?: CommitComposerLayout | undefined;
  readonly summaryValue?: string | undefined;
  readonly bodyValue?: string | undefined;
  readonly onSummaryChange?: ((value: string) => void) | undefined;
  readonly onBodyChange?: ((value: string) => void) | undefined;
  readonly onPreview: (messageDraft: string) => void;
  readonly onCommit: (message: string) => void;
  readonly onCreateBranch?: ((trigger: HTMLButtonElement) => void) | undefined;
  readonly onCreatePullRequest?: (() => void) | undefined;
  readonly onMerge?: (() => void) | undefined;
}

/** Compose the git commit message from the subject line and the optional body. */
export function composeCommitMessage(summary: string, body: string): string {
  const subject = summary.trim();
  const detail = body.trim();
  return detail === "" ? subject : `${subject}\n\n${detail}`;
}

function useControlledComposerField(
  controlledValue: string | undefined,
  onControlledChange: ((value: string) => void) | undefined,
): readonly [string, (value: string) => void] {
  const [localValue, setLocalValue] = useState("");
  const value = controlledValue ?? localValue;
  const setValue = useCallback(
    (nextValue: string): void => {
      if (controlledValue === undefined) setLocalValue(nextValue);
      onControlledChange?.(nextValue);
    },
    [controlledValue, onControlledChange],
  );
  return [value, setValue];
}

interface CommitDraftParts {
  readonly summary: string;
  readonly body: string;
}

function splitCommitMessageDraft(message: string): CommitDraftParts {
  const lines = message.replace(/\r\n?/gu, "\n").trim().split("\n");
  return {
    summary: lines[0]?.trim() ?? "",
    body: lines.slice(1).join("\n").trim(),
  };
}

function commitHint(
  hasRepository: boolean,
  hasStaged: boolean,
  subjectEmpty: boolean,
  missingFreshPreview: boolean,
  protectedBranchBlocked: boolean,
  policyBlocked: boolean,
  t: OptionalWidgetTranslate,
): string {
  if (!hasRepository) return t("commitComposer.hint.selectRepository");
  if (!hasStaged) return t("commitComposer.hint.stageChanges");
  if (subjectEmpty) return t("commitComposer.hint.enterSummary");
  if (missingFreshPreview) return t("commitComposer.hint.waitPreview");
  if (protectedBranchBlocked) return t("commitComposer.hint.createBranchForProtected");
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

interface CommitDraftSuggestionProps {
  readonly preview: GitDeliveryCommitPreviewResponse;
  readonly onUse: (message: string) => void;
  readonly t: OptionalWidgetTranslate;
}

function CommitDraftSuggestion({ preview, onUse, t }: CommitDraftSuggestionProps): ReactNode {
  const { suggestedMessage } = preview;
  return (
    <div
      data-testid="git-commit-draft"
      style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
    >
      <p style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12, color: "var(--fg)" }}>
        {t("commitComposer.preview.summary", {
          files: preview.summary.stagedFileCount,
          fileNoun:
            preview.summary.stagedFileCount === 1
              ? t("commitComposer.preview.fileSingular")
              : t("commitComposer.preview.filePlural"),
          areas: preview.summary.areaCount,
          areaNoun:
            preview.summary.areaCount === 1
              ? t("commitComposer.preview.areaSingular")
              : t("commitComposer.preview.areaPlural"),
          tests: preview.summary.touchesTests ? t("commitComposer.preview.touchesTestsSuffix") : "",
        })}
      </p>
      {suggestedMessage === undefined ? (
        <p style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12 }}>
          {t("commitComposer.draft.unavailable")}
        </p>
      ) : (
        <button type="button" style={SECONDARY_BTN} onClick={() => onUse(suggestedMessage)}>
          <SparkIcon size={15} /> {t("commitComposer.action.useDraft")}
        </button>
      )}
    </div>
  );
}

function isProtectedBranchBlock(preview: GitDeliveryCommitPreviewResponse | null): boolean {
  return preview?.policyOutcome === "blocked" && preview.policyBlockReason === "protected-branch";
}

function isPolicyBlock(preview: GitDeliveryCommitPreviewResponse | null): boolean {
  return preview?.policyOutcome === "blocked";
}

function visibleWarnings(
  preview: GitDeliveryCommitPreviewResponse,
  t: OptionalWidgetTranslate,
): readonly { readonly key: string; readonly text: string }[] {
  return preview.intent.warnings
    .filter((warning) => warning !== "empty-body")
    .map((warning) => ({ key: warning, text: t(`commitComposer.warning.${warning}`) }));
}

function preflightFindingText(code: string, t: OptionalWidgetTranslate): string {
  if (code === "branch-protection-unavailable") {
    return t("commitComposer.preflight.branchProtectionUnavailable");
  }
  if (code === "signed-commits-required") {
    return t("commitComposer.preflight.signedCommitsRequired");
  }
  return code.replaceAll("-", " ");
}

function visiblePreflightFindings(
  preview: GitDeliveryCommitPreviewResponse,
  t: OptionalWidgetTranslate,
): readonly { readonly key: string; readonly text: string }[] {
  const hideRemoteProtectionRead = isProtectedBranchBlock(preview);
  return preview.preflightFindingCodes
    .filter((code) => !(hideRemoteProtectionRead && code === "branch-protection-unavailable"))
    .map((code) => ({ key: code, text: preflightFindingText(code, t) }));
}

interface CommitDraftReviewProps {
  readonly summary: string;
  readonly body: string;
  readonly t: OptionalWidgetTranslate;
}

type DraftCopyStatus = "copied" | "failed";

function copyStatusText(status: DraftCopyStatus, t: OptionalWidgetTranslate): string {
  if (status === "copied") return t("commitComposer.copy.copied");
  return t("commitComposer.copy.failed");
}

function CopyCommitDraftAction({
  message,
  t,
}: {
  readonly message: string;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  const [status, setStatus] = useState<DraftCopyStatus | null>(null);
  const copyDraft = (): void => {
    setStatus(null);
    void copyTextToClipboard(message, { restoreFocus: false }).then(
      () => setStatus("copied"),
      () => setStatus("failed"),
    );
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <button
        type="button"
        style={SECONDARY_BTN}
        onClick={copyDraft}
        aria-label={t("commitComposer.action.copyDraft")}
        title={t("commitComposer.action.copyDraft")}
      >
        <CopyIcon size={15} /> {t("commitComposer.action.copyDraft")}
      </button>
      {status === null ? null : (
        <output
          role={status === "failed" ? "alert" : undefined}
          style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12, color: "var(--fg-muted)" }}
        >
          {copyStatusText(status, t)}
        </output>
      )}
    </div>
  );
}

function CommitDraftReview({ summary, body, t }: CommitDraftReviewProps): ReactNode {
  const subject = summary.trim();
  const detail = body.trim();
  if (subject === "") return null;
  const message = composeCommitMessage(subject, detail);
  return (
    <div data-testid="git-commit-message-preview" style={DRAFT_REVIEW_STYLE}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          minWidth: 0,
          flex: 1,
        }}
      >
        <StatusPill tone="info">
          <SparkIcon size={11} /> {t("commitComposer.draft.title")}
        </StatusPill>
      </div>
      <CopyCommitDraftAction message={message} t={t} />
    </div>
  );
}

interface PrimaryCommitActionProps {
  readonly protectedBranchBlocked: boolean;
  readonly canOpenBranchDialog: boolean;
  readonly commitDisabled: boolean;
  readonly hintId: string;
  readonly commitLabel: string;
  readonly message: string;
  readonly onCommit: (message: string) => void;
  readonly onCreateBranch: ((trigger: HTMLButtonElement) => void) | undefined;
  readonly t: OptionalWidgetTranslate;
}

function PrimaryCommitAction({
  protectedBranchBlocked,
  canOpenBranchDialog,
  commitDisabled,
  hintId,
  commitLabel,
  message,
  onCommit,
  onCreateBranch,
  t,
}: PrimaryCommitActionProps): ReactNode {
  if (protectedBranchBlocked) {
    return (
      <button
        type="button"
        style={{ ...PRIMARY_BTN, width: "100%", ...disabledStyle(!canOpenBranchDialog) }}
        disabled={!canOpenBranchDialog}
        aria-describedby={hintId}
        onClick={(event) => onCreateBranch?.(event.currentTarget)}
      >
        <BranchIcon size={16} /> {t("commitComposer.action.createBranchFirst")}
      </button>
    );
  }
  return (
    <button
      type="button"
      style={{ ...PRIMARY_BTN, width: "100%", ...disabledStyle(commitDisabled) }}
      disabled={commitDisabled}
      aria-describedby={hintId}
      onClick={() => onCommit(message)}
    >
      <CommitIcon size={16} /> {commitLabel}
    </button>
  );
}

function DescriptionField({
  body,
  disabled,
  layout,
  onBodyChange,
  t,
}: {
  readonly body: string;
  readonly disabled: boolean;
  readonly layout: CommitComposerLayout;
  readonly onBodyChange: (value: string) => void;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  return (
    <textarea
      aria-label={t("commitComposer.field.description")}
      style={
        layout === "workspace" ? COMMIT_WORKSPACE_DESCRIPTION_FIELD_STYLE : DESCRIPTION_FIELD_STYLE
      }
      value={body}
      disabled={disabled}
      onChange={(e) => onBodyChange(e.target.value)}
      placeholder={t("commitComposer.field.descriptionPlaceholder")}
    />
  );
}

function CommitActionLayout({
  protectedBranchBlocked,
  action,
  description,
}: {
  readonly protectedBranchBlocked: boolean;
  readonly action: ReactNode;
  readonly description: ReactNode;
}): ReactNode {
  if (protectedBranchBlocked) {
    return (
      <>
        {action}
        {description}
      </>
    );
  }
  return (
    <>
      {description}
      {action}
    </>
  );
}

function PolicyBlockNotice({
  preview,
  branchName,
  t,
}: {
  readonly preview: GitDeliveryCommitPreviewResponse;
  readonly branchName: string | undefined;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (!isPolicyBlock(preview)) return null;
  if (preview.policyBlockReason === "protected-branch") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <StatusPill tone="warning">
          <BranchIcon size={11} /> {t("commitComposer.preview.protectedBranchTitle")}
        </StatusPill>
        <p style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12, color: "var(--fg)" }}>
          {t("commitComposer.preview.protectedBranchDetail", {
            branch: branchName ?? t("commitComposer.preview.currentBranch"),
          })}
        </p>
      </div>
    );
  }
  return (
    <p style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12, color: "var(--fg)" }}>
      {t("commitComposer.preview.policyBlocked")}
    </p>
  );
}

function CommitGateNotice({
  id,
  preview,
  branchName,
  t,
}: {
  readonly id: string;
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly branchName: string | undefined;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (!isProtectedBranchBlock(preview)) return null;
  return (
    <div
      id={id}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "9px 10px",
        borderRadius: 9,
        background: "color-mix(in oklch, var(--warn) 11%, var(--inset))",
        boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--warn) 36%, var(--line))",
      }}
    >
      <span style={{ color: "var(--warn)", flex: "none", paddingTop: 1 }}>
        <BranchIcon size={14} />
      </span>
      <p style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12, color: "var(--fg)", margin: 0 }}>
        <strong>{t("commitComposer.preview.protectedBranchTitle")}.</strong>{" "}
        {t("commitComposer.preview.protectedBranchDetail", {
          branch: branchName ?? t("commitComposer.preview.currentBranch"),
        })}
      </p>
    </div>
  );
}

interface CommitComposerStateInput {
  readonly projectId: string | null;
  readonly branchName: string | undefined;
  readonly stagedFileCount: number;
  readonly busy: boolean;
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly previewDraft: string | null;
  readonly summary: string;
  readonly body: string;
  readonly onCreateBranch: ((trigger: HTMLButtonElement) => void) | undefined;
  readonly t: OptionalWidgetTranslate;
}

interface CommitComposerState {
  readonly hasRepository: boolean;
  readonly hasStaged: boolean;
  readonly message: string;
  readonly subjectEmpty: boolean;
  readonly emptyDraftPreview: GitDeliveryCommitPreviewResponse | null;
  readonly visiblePreview: GitDeliveryCommitPreviewResponse | null;
  readonly protectedBranchBlocked: boolean;
  readonly messageBlocked: boolean;
  readonly policyBlocked: boolean;
  readonly missingFreshPreview: boolean;
  readonly commitDisabled: boolean;
  readonly branchActionAvailable: boolean;
  readonly hint: string;
  readonly commitLabel: string;
}

function hasRepository(projectId: string | null): boolean {
  return projectId !== null && projectId !== "";
}

function emptyDraftPreviewFor(
  subjectEmpty: boolean,
  preview: GitDeliveryCommitPreviewResponse | null,
  previewDraft: string | null,
): GitDeliveryCommitPreviewResponse | null {
  if (!subjectEmpty || preview === null || previewDraft !== "") return null;
  return preview;
}

function visiblePreviewFor(
  subjectEmpty: boolean,
  preview: GitDeliveryCommitPreviewResponse | null,
  previewDraft: string | null,
  message: string,
): GitDeliveryCommitPreviewResponse | null {
  if (subjectEmpty || preview === null || previewDraft !== message) return null;
  return preview;
}

function commitLabelFor(branchName: string | undefined, t: OptionalWidgetTranslate): string {
  if (branchName === undefined || branchName === "") return t("commitComposer.action.commit");
  return t("commitComposer.action.commitTo", { branch: branchName });
}

function commitComposerState(input: CommitComposerStateInput): CommitComposerState {
  const message = composeCommitMessage(input.summary, input.body);
  const subjectEmpty = input.summary.trim() === "";
  const selectedRepository = hasRepository(input.projectId);
  const hasStaged = input.stagedFileCount > 0;
  const emptyDraftPreview = emptyDraftPreviewFor(subjectEmpty, input.preview, input.previewDraft);
  const visiblePreview = visiblePreviewFor(
    subjectEmpty,
    input.preview,
    input.previewDraft,
    message,
  );
  const protectedBranchBlocked = isProtectedBranchBlock(visiblePreview);
  const messageBlocked = visiblePreview !== null && !visiblePreview.messageValidation.ok;
  const policyBlocked =
    visiblePreview !== null && (messageBlocked || isPolicyBlock(visiblePreview));
  const missingFreshPreview = !subjectEmpty && visiblePreview === null;
  return {
    hasRepository: selectedRepository,
    hasStaged,
    message,
    subjectEmpty,
    emptyDraftPreview,
    visiblePreview,
    protectedBranchBlocked,
    messageBlocked,
    policyBlocked,
    missingFreshPreview,
    commitDisabled:
      input.busy ||
      !selectedRepository ||
      !hasStaged ||
      subjectEmpty ||
      missingFreshPreview ||
      policyBlocked,
    branchActionAvailable: selectedRepository && input.onCreateBranch !== undefined,
    hint: commitHint(
      selectedRepository,
      hasStaged,
      subjectEmpty,
      missingFreshPreview,
      protectedBranchBlocked,
      policyBlocked,
      input.t,
    ),
    commitLabel: commitLabelFor(input.branchName, input.t),
  };
}

function CommitDraftSuggestionSlot({
  preview,
  onUse,
  t,
}: {
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly onUse: (message: string) => void;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (preview === null) return null;
  return <CommitDraftSuggestion preview={preview} onUse={onUse} t={t} />;
}

function PreviewErrorBlock({
  previewError,
  t,
}: {
  readonly previewError: string | null;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (previewError === null) return null;
  return (
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
  );
}

function CommitPolicyPreviewSlot({
  id,
  preview,
  branchName,
  t,
}: {
  readonly id: string;
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly branchName: string | undefined;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (preview === null) return null;
  if (isProtectedBranchBlock(preview)) return null;
  return <CommitPolicyPreview id={id} preview={preview} branchName={branchName} t={t} />;
}

function previewTone(blocked: boolean): "danger" | "success" {
  if (blocked) return "danger";
  return "success";
}

function previewStatusText(blocked: boolean, t: OptionalWidgetTranslate): string {
  if (blocked) return t("commitComposer.preview.policyActionNeeded");
  return t("commitComposer.preview.meetsPolicy");
}

function fileNoun(count: number, t: OptionalWidgetTranslate): string {
  if (count === 1) return t("commitComposer.preview.fileSingular");
  return t("commitComposer.preview.filePlural");
}

function areaNoun(count: number, t: OptionalWidgetTranslate): string {
  if (count === 1) return t("commitComposer.preview.areaSingular");
  return t("commitComposer.preview.areaPlural");
}

function commitPreviewSummaryText(
  summary: GitDeliveryCommitPreviewResponse["summary"],
  t: OptionalWidgetTranslate,
): string {
  return t("commitComposer.preview.summary", {
    files: summary.stagedFileCount,
    fileNoun: fileNoun(summary.stagedFileCount, t),
    areas: summary.areaCount,
    areaNoun: areaNoun(summary.areaCount, t),
    tests: summary.touchesTests ? t("commitComposer.preview.touchesTestsSuffix") : "",
  });
}

function messageViolationsFor(
  preview: GitDeliveryCommitPreviewResponse,
): readonly GitCommitMessageViolationCode[] {
  if (preview.messageValidation.ok) return [];
  return preview.messageValidation.violations;
}

function SuggestedPrefixLine({
  prefix,
  t,
}: {
  readonly prefix: string | undefined;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (prefix === undefined) return null;
  return (
    <p style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12, color: "var(--fg)" }}>
      {t("commitComposer.preview.suggestedPrefix")} <code style={MONO_INLINE_STYLE}>{prefix}</code>
    </p>
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
  layout = "sidebar",
  summaryValue,
  bodyValue,
  onSummaryChange,
  onBodyChange,
  onPreview,
  onCommit,
  onCreateBranch,
  onCreatePullRequest,
  onMerge,
}: CommitComposerProps): ReactNode {
  const t = useOptionalWidgetTranslate();
  const [summary, setSummary] = useControlledComposerField(summaryValue, onSummaryChange);
  const [body, setBody] = useControlledComposerField(bodyValue, onBodyChange);
  const baseId = useId();
  const hintId = `${baseId}-hint`;
  const previewId = `${baseId}-preview`;
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;

  const state = commitComposerState({
    projectId,
    branchName,
    stagedFileCount,
    busy,
    preview,
    previewDraft,
    summary,
    body,
    onCreateBranch,
    t,
  });

  // Load the current staged summary first; later edits are revalidated with a short debounce.
  useEffect(() => {
    if (!state.hasRepository || !state.hasStaged) return;
    const delay = state.subjectEmpty ? 0 : PREVIEW_DEBOUNCE_MS;
    const handle = setTimeout(() => onPreviewRef.current(state.message), delay);
    return () => clearTimeout(handle);
  }, [stagedFileCount, state.hasRepository, state.hasStaged, state.message, state.subjectEmpty]);

  return (
    <section
      style={layout === "workspace" ? COMMIT_WORKSPACE_PANEL_STYLE : COMMIT_PANEL_STYLE}
      aria-label={t("commitComposer.action.commit")}
    >
      <header style={COMMIT_HEADER_STYLE}>
        <h3 style={{ margin: 0, font: "inherit" }}>{t("commitComposer.action.commit")}</h3>
      </header>
      <CommitDraftSuggestionSlot
        preview={state.emptyDraftPreview}
        onUse={(suggestedMessage) => {
          const draft = splitCommitMessageDraft(suggestedMessage);
          setSummary(draft.summary);
          setBody(draft.body);
        }}
        t={t}
      />
      <input
        type="text"
        aria-label={t("commitComposer.field.summary")}
        style={summaryFieldStyle(false)}
        value={summary}
        disabled={!state.hasRepository}
        aria-invalid={state.messageBlocked ? "true" : undefined}
        aria-describedby={state.policyBlocked && !state.protectedBranchBlocked ? previewId : hintId}
        onChange={(e) => setSummary(e.target.value)}
        placeholder={t("commitComposer.field.summaryPlaceholder")}
      />
      {state.protectedBranchBlocked ? (
        <CommitGateNotice
          id={hintId}
          preview={state.visiblePreview}
          branchName={branchName}
          t={t}
        />
      ) : (
        <p
          id={hintId}
          role="status"
          aria-live="polite"
          style={{ ...SUBTLE_TEXT_STYLE, fontSize: 11.5, color: "var(--fg-faint)" }}
        >
          {state.hint}
        </p>
      )}
      <CommitActionLayout
        protectedBranchBlocked={state.protectedBranchBlocked}
        action={
          <PrimaryCommitAction
            protectedBranchBlocked={state.protectedBranchBlocked}
            canOpenBranchDialog={state.branchActionAvailable}
            commitDisabled={state.commitDisabled}
            hintId={hintId}
            commitLabel={state.commitLabel}
            message={state.message}
            onCommit={onCommit}
            onCreateBranch={onCreateBranch}
            t={t}
          />
        }
        description={
          <DescriptionField
            body={body}
            disabled={!state.hasRepository}
            layout={layout}
            onBodyChange={setBody}
            t={t}
          />
        }
      />
      <CommitDraftReview summary={summary} body={body} t={t} />
      {state.protectedBranchBlocked ? null : (
        <CommitFlowActions
          hasRepository={state.hasRepository}
          onCreatePullRequest={onCreatePullRequest}
          onMerge={onMerge}
          t={t}
        />
      )}
      <PreviewErrorBlock previewError={previewError} t={t} />
      <CommitPolicyPreviewSlot
        id={previewId}
        preview={state.visiblePreview}
        branchName={branchName}
        t={t}
      />
      <MutationOutcome outcome={outcome} error={error} testid="git-commit-outcome" />
    </section>
  );
}

// Secondary policy preview: the change summary, optional scaffolding suggestion, soft suggestions,
// hard policy violations, and preflight checks — present but subordinate to the commit flow. All
// inputs are content-free typed codes/counts.
function CommitPolicyPreview({
  id,
  preview,
  branchName,
  t,
}: {
  readonly id: string;
  readonly preview: GitDeliveryCommitPreviewResponse;
  readonly branchName: string | undefined;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  const blocked = !preview.messageValidation.ok || isPolicyBlock(preview);
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
        <StatusPill tone={previewTone(blocked)}>
          <CheckIcon size={11} /> {previewStatusText(blocked, t)}
        </StatusPill>
        <p style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12, color: "var(--fg)" }}>
          {commitPreviewSummaryText(summary, t)}
        </p>
      </div>
      <SuggestedPrefixLine prefix={intent.suggestedSubjectPrefix} t={t} />
      <PolicyBlockNotice preview={preview} branchName={branchName} t={t} />
      <CodeList
        label={t("commitComposer.preview.messageViolations")}
        testid="git-commit-violations"
        items={messageViolationsFor(preview).map((v) => ({
          key: v,
          text: t(`commitComposer.violation.${v}`),
        }))}
      />
      <CodeList
        label={t("commitComposer.preview.qualityWarnings")}
        testid="git-commit-warnings"
        items={visibleWarnings(preview, t)}
      />
      <CodeList
        label={t("commitComposer.preview.preflightFindings")}
        testid="git-commit-findings"
        items={visiblePreflightFindings(preview, t)}
      />
    </div>
  );
}
