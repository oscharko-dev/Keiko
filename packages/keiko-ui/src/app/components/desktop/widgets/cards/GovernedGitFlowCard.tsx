"use client";

// Governed local Git flow surface (Issue #475, Epic #470). A per-project card that walks
//   Branch (create / switch) → Staging (stage / unstage) → Commit composer (live preview + execute)
// entirely through the governed mutation kernel exposed by the BFF. Every mutation is content-free:
// the surface shows counts, structural area tokens, branch names, and typed warning / violation /
// finding codes — never diff content, raw paths, secrets, or the commit-message body.
//
// Severity and outcome are conveyed by TEXT + icon, never colour alone (WCAG 2.2 AA). Styling uses
// inline styles backed by existing CSS custom properties so globals.css is untouched (ADR-0051 gate).

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  GitCommitMessageViolationCode,
  GitCommitQualityWarningCode,
} from "@oscharko-dev/keiko-contracts";
import {
  ApiError,
  cloneRepository as fetchCloneRepository,
  createProject,
  fetchGitBranches,
  fetchGitDeliveryCommitExecute,
  fetchGitDeliveryCommitPreview,
  fetchGitDeliveryLocalBranchCreate,
  fetchGitDeliveryLocalBranchSwitch,
  fetchGitDeliveryPushExecute,
  fetchGitDeliveryPushPreview,
  fetchGitDeliveryStage,
  fetchGitDeliveryUnstage,
  fetchProjects,
  type GitDeliveryCommitPreviewResponse,
  type GitBranchListEntry,
  type GitDeliveryMutationResponse,
  type GitDeliveryPushPreviewResponse,
} from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";
import { Icons } from "../../Icons";

// The outcome of any governed action. Push execute adds the publish-rejection / recovery fields; they
// are optional so a branch/staging/commit outcome (which omits them) is assignable.
type GovernedGitOutcome = GitDeliveryMutationResponse & {
  readonly publishRejectionReason?: string;
  readonly recoveryDisposition?: string;
  readonly recoveryActionHint?: string;
};

// ─── Injected client (DI seam for tests) ────────────────────────────────────────────────────────

export interface GovernedGitFlowClient {
  readonly listRepositories: typeof fetchProjects;
  readonly registerRepository: typeof createProject;
  readonly cloneRepository: typeof fetchCloneRepository;
  readonly listBranches: typeof fetchGitBranches;
  readonly branchCreate: typeof fetchGitDeliveryLocalBranchCreate;
  readonly branchSwitch: typeof fetchGitDeliveryLocalBranchSwitch;
  readonly stage: typeof fetchGitDeliveryStage;
  readonly unstage: typeof fetchGitDeliveryUnstage;
  readonly commitPreview: typeof fetchGitDeliveryCommitPreview;
  readonly commitExecute: typeof fetchGitDeliveryCommitExecute;
  readonly pushPreview: typeof fetchGitDeliveryPushPreview;
  readonly pushExecute: typeof fetchGitDeliveryPushExecute;
}

const DEFAULT_CLIENT: GovernedGitFlowClient = {
  listRepositories: fetchProjects,
  registerRepository: createProject,
  cloneRepository: fetchCloneRepository,
  listBranches: fetchGitBranches,
  branchCreate: fetchGitDeliveryLocalBranchCreate,
  branchSwitch: fetchGitDeliveryLocalBranchSwitch,
  stage: fetchGitDeliveryStage,
  unstage: fetchGitDeliveryUnstage,
  commitPreview: fetchGitDeliveryCommitPreview,
  commitExecute: fetchGitDeliveryCommitExecute,
  pushPreview: fetchGitDeliveryPushPreview,
  pushExecute: fetchGitDeliveryPushExecute,
};

// ─── Label maps (typed codes → human text; never colour-alone) ──────────────────────────────────

const WARNING_LABEL: Readonly<Record<GitCommitQualityWarningCode, string>> = {
  "mixed-scope": "Mixed scope — changes span several areas",
  "wip-marker": "Work-in-progress marker in the subject",
  "large-change": "Large change — many files staged",
  "empty-body": "No commit body",
  "non-conventional-subject": "Subject is not a conventional-commit type",
};

const VIOLATION_LABEL: Readonly<Record<GitCommitMessageViolationCode, string>> = {
  "empty-subject": "The subject line is empty",
  "missing-conventional-prefix": "Missing a conventional-commit type prefix",
  "disallowed-type": "The commit type is not allowed",
  "subject-too-long": "The subject line is too long",
  "missing-issue-key": "Missing the required issue key",
  "missing-signoff": "Missing the Signed-off-by trailer",
};

const STATUS_LABEL: Readonly<Record<GitDeliveryMutationResponse["status"], string>> = {
  succeeded: "Succeeded",
  blocked: "Blocked",
  "approval-required": "Approval required",
  failed: "Failed",
  "recovery-required": "Recovery required",
};

function warningLabel(code: GitCommitQualityWarningCode): string {
  return WARNING_LABEL[code];
}

function violationLabel(code: GitCommitMessageViolationCode): string {
  return VIOLATION_LABEL[code];
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}

// ─── Shared inline-style tokens (CSS custom properties — globals.css untouched) ──────────────────

const SHELL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
  minHeight: "100%",
  padding: "var(--space-5)",
  overflow: "auto",
  background: "var(--surface-primary)",
};

const TOPBAR_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "var(--space-5)",
  flexWrap: "wrap",
  minWidth: 0,
};

const EYEBROW_STYLE: CSSProperties = {
  margin: "0 0 var(--space-2)",
  font: "var(--weight-semibold) var(--text-caption) var(--font-mono)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-accent)",
};

const HEADING_STYLE: CSSProperties = {
  margin: 0,
  font: "var(--weight-semibold) var(--text-heading) var(--font-ui)",
  color: "var(--text-primary)",
};

const SUBTLE_TEXT_STYLE: CSSProperties = {
  margin: 0,
  font: "var(--text-body-sm) var(--font-ui)",
  color: "var(--text-secondary)",
};

const PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
  padding: "var(--space-5)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-surface)",
  background: "var(--surface-primary)",
};

const PANEL_HEADER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "var(--space-5)",
  alignItems: "flex-start",
};

const PANEL_TITLE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  margin: 0,
  font: "var(--weight-semibold) var(--text-body) var(--font-ui)",
  color: "var(--text-primary)",
};

const PANEL_COPY_STYLE: CSSProperties = {
  margin: "var(--space-2) 0 0",
  font: "var(--text-caption) var(--font-ui)",
  color: "var(--text-secondary)",
};

const FIELD_STYLE: CSSProperties = {
  width: "100%",
  minHeight: "var(--control-height)",
  padding: "0 var(--control-pad-x)",
  border: "1px solid var(--input-border)",
  borderRadius: "var(--radius-control)",
  background: "var(--input-surface)",
  color: "var(--input-text)",
  font: "var(--text-body-sm) var(--font-ui)",
  outline: "none",
};

const TEXTAREA_STYLE: CSSProperties = {
  ...FIELD_STYLE,
  minHeight: 96,
  padding: "var(--space-5) var(--control-pad-x)",
  resize: "vertical",
};

const ROW_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
  gap: "var(--space-5)",
};

const ACTION_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-4)",
  flexWrap: "wrap",
};

const BUTTON_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--space-3)",
  minHeight: "var(--control-height)",
  padding: "0 var(--control-pad-x)",
  borderRadius: "var(--radius-control)",
  font: "var(--weight-medium) var(--text-body-sm) var(--font-ui)",
  cursor: "pointer",
};

const PRIMARY_BTN: CSSProperties = {
  ...BUTTON_BASE,
  border: "1px solid transparent",
  background: "var(--button-primary-surface)",
  color: "var(--button-primary-text)",
  fontWeight: "var(--weight-semibold)",
};

const SECONDARY_BTN: CSSProperties = {
  ...BUTTON_BASE,
  border: "1px solid var(--button-secondary-border)",
  background: "var(--button-secondary-surface)",
  color: "var(--button-secondary-text)",
};

const LABEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  minWidth: 0,
  font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  color: "var(--text-faint)",
};

const LABEL_TEXT_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
};

const CHECKBOX_LABEL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-4)",
  width: "fit-content",
  font: "var(--text-body-sm) var(--font-ui)",
  color: "var(--text-secondary)",
  cursor: "pointer",
};

const PREVIEW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  padding: "var(--space-5)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-control)",
  background: "var(--surface-inset)",
};

const MONO_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-caption)",
  color: "var(--text-accent)",
};

const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
};

function disabledStyle(disabled: boolean): CSSProperties {
  return disabled ? { opacity: "var(--opacity-disabled)", cursor: "not-allowed" } : {};
}

function PrimaryButton({
  disabled = false,
  onClick,
  children,
}: {
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      style={{ ...PRIMARY_BTN, ...disabledStyle(disabled) }}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  disabled = false,
  onClick,
  children,
}: {
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      style={{ ...SECONDARY_BTN, ...disabledStyle(disabled) }}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function StatusPill({
  children,
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info";
}): ReactNode {
  const toneColor =
    tone === "success"
      ? "var(--feedback-success)"
      : tone === "warning"
        ? "var(--feedback-warning)"
        : tone === "danger"
          ? "var(--feedback-danger)"
          : tone === "info"
            ? "var(--feedback-info)"
            : tone === "accent"
              ? "var(--text-accent)"
              : "var(--text-secondary)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-3)",
        width: "fit-content",
        padding: "3px 10px",
        borderRadius: "var(--radius-pill)",
        border: `1px solid color-mix(in oklch, ${toneColor} 42%, transparent)`,
        background:
          tone === "neutral"
            ? "var(--surface-inset)"
            : `color-mix(in oklch, ${toneColor} 12%, transparent)`,
        color: toneColor,
        font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }}
      />
      {children}
    </span>
  );
}

function Panel({
  icon,
  title,
  description,
  badge,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly badge?: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section style={PANEL_STYLE} aria-label={title}>
      <div style={PANEL_HEADER_STYLE}>
        <div>
          <h3 style={PANEL_TITLE_STYLE}>
            {icon}
            {title}
          </h3>
          <p style={PANEL_COPY_STYLE}>{description}</p>
        </div>
        {badge}
      </div>
      {children}
    </section>
  );
}

function FieldLabel({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <label style={LABEL_STYLE}>
      <span style={LABEL_TEXT_STYLE}>{label}</span>
      {children}
    </label>
  );
}

// ─── Outcome banner (text + icon; never colour alone) ────────────────────────────────────────────

function MutationOutcome({
  outcome,
  error,
}: {
  readonly outcome: GovernedGitOutcome | null;
  readonly error: string | null;
}): ReactNode {
  if (error !== null) {
    return (
      <div
        role="alert"
        style={{
          ...PREVIEW_STYLE,
          borderColor: "color-mix(in oklch, var(--feedback-danger) 48%, var(--border-default))",
          background: "color-mix(in oklch, var(--feedback-danger) 10%, var(--surface-primary))",
        }}
      >
        <StatusPill tone="danger">
          <Icons.info size={11} /> Error
        </StatusPill>
        <p style={{ ...SUBTLE_TEXT_STYLE, color: "var(--text-primary)" }}>{error}</p>
      </div>
    );
  }
  if (outcome === null) return null;
  const tone =
    outcome.status === "succeeded"
      ? "success"
      : outcome.status === "approval-required" || outcome.status === "recovery-required"
        ? "warning"
        : outcome.status === "blocked" || outcome.status === "failed"
          ? "danger"
          : "neutral";
  const codes = [
    ...(outcome.blockReason !== undefined ? [`reason: ${outcome.blockReason}`] : []),
    ...(outcome.preflightFindingCodes ?? []).map((c) => `preflight: ${c}`),
    ...(outcome.requiredApprovers ?? []).map((a) => `approver: ${a}`),
    ...(outcome.executionErrorCode !== undefined ? [`error: ${outcome.executionErrorCode}`] : []),
    ...(outcome.publishRejectionReason !== undefined
      ? [`publish rejected: ${outcome.publishRejectionReason}`]
      : []),
    ...(outcome.recoveryActionHint !== undefined ? [`recover: ${outcome.recoveryActionHint}`] : []),
    ...(outcome.messageViolations ?? []).map((v) => violationLabel(v)),
  ];
  return (
    <div
      data-testid="ggit-outcome"
      style={{
        ...PREVIEW_STYLE,
        borderColor:
          tone === "success"
            ? "color-mix(in oklch, var(--feedback-success) 42%, var(--border-default))"
            : tone === "warning"
              ? "color-mix(in oklch, var(--feedback-warning) 42%, var(--border-default))"
              : tone === "danger"
                ? "color-mix(in oklch, var(--feedback-danger) 42%, var(--border-default))"
                : "var(--border-subtle)",
      }}
    >
      <StatusPill tone={tone}>
        <Icons.check size={11} /> {STATUS_LABEL[outcome.status]}
      </StatusPill>
      <p
        style={{
          margin: 0,
          font: "var(--weight-semibold) var(--text-body-sm) var(--font-ui)",
          color: "var(--text-primary)",
        }}
      >
        {outcome.actionKind}: {STATUS_LABEL[outcome.status]}
      </p>
      {codes.length > 0 ? (
        <ul
          style={{
            margin: 0,
            paddingLeft: "var(--space-7)",
            font: "var(--text-caption) var(--font-ui)",
          }}
        >
          {codes.map((code) => (
            <li
              key={code}
              style={{ color: "var(--text-secondary)", lineHeight: "var(--leading-normal)" }}
            >
              {code}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ─── Branch section (create / switch) ────────────────────────────────────────────────────────────

interface BranchSectionProps {
  readonly busy: boolean;
  readonly branches: readonly GitBranchListEntry[];
  readonly branchesLoading: boolean;
  readonly branchesError: string | null;
  readonly onCreate: (
    branchName: string,
    baseBranchName: string,
    startPointRefHash: string,
  ) => void;
  readonly onSwitch: (branchName: string) => void;
}

function BranchSection({
  busy,
  branches,
  branchesLoading,
  branchesError,
  onCreate,
  onSwitch,
}: BranchSectionProps): ReactNode {
  const [newBranch, setNewBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [switchTo, setSwitchTo] = useState("");
  const currentBranch = branches.find((branch) => branch.current) ?? branches[0];
  const selectedBase = branches.find((branch) => branch.name === baseBranch) ?? currentBranch;
  const selectedSwitch = branches.find((branch) => branch.name === switchTo) ?? currentBranch;
  const canCreate = newBranch.trim() !== "" && selectedBase !== undefined;
  const canSwitch = selectedSwitch !== undefined;

  useEffect(() => {
    if (currentBranch === undefined) return;
    setBaseBranch((value) => (value === "" ? currentBranch.name : value));
    setSwitchTo((value) => (value === "" ? currentBranch.name : value));
  }, [currentBranch]);

  return (
    <Panel
      icon={<Icons.branch size={14} />}
      title="Branch"
      description="Create a reviewable branch from a selected local base branch, or switch the worktree to an existing local branch."
      badge={
        <StatusPill tone={branches.length > 0 ? "accent" : "neutral"}>
          {branchesLoading ? "Loading branches" : `${branches.length.toString()} local`}
        </StatusPill>
      }
    >
      {branchesError !== null ? (
        <div role="alert" style={{ ...PREVIEW_STYLE, borderColor: "var(--feedback-warning)" }}>
          <StatusPill tone="warning">
            <Icons.info size={11} /> Branch list unavailable
          </StatusPill>
          <p style={SUBTLE_TEXT_STYLE}>{branchesError}</p>
        </div>
      ) : null}
      <div style={ROW_STYLE}>
        <FieldLabel label="New branch name">
          <input
            style={FIELD_STYLE}
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            aria-label="New branch name"
            placeholder="feat/change-flow"
          />
        </FieldLabel>
        <FieldLabel label="Base branch">
          <select
            style={FIELD_STYLE}
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            aria-label="Base branch"
            disabled={branchesLoading || branches.length === 0}
          >
            {branches.length === 0 ? <option value="">No local branches</option> : null}
            {branches.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}
                {branch.current ? " (current)" : ""}
              </option>
            ))}
          </select>
        </FieldLabel>
      </div>
      <div style={ROW_STYLE}>
        <FieldLabel label="Switch to branch">
          <select
            style={FIELD_STYLE}
            value={switchTo}
            onChange={(e) => setSwitchTo(e.target.value)}
            aria-label="Switch to branch"
            disabled={branchesLoading || branches.length === 0}
          >
            {branches.length === 0 ? <option value="">No local branches</option> : null}
            {branches.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}
                {branch.current ? " (current)" : ""}
              </option>
            ))}
          </select>
        </FieldLabel>
      </div>
      <div style={ACTION_ROW_STYLE}>
        <p style={SUBTLE_TEXT_STYLE}>
          New branches start from the selected base branch; the technical start point is resolved
          automatically.
        </p>
        <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
          <SecondaryButton
            disabled={busy || !canSwitch}
            onClick={() => {
              if (selectedSwitch !== undefined) onSwitch(selectedSwitch.name);
            }}
          >
            <Icons.branch size={12} /> Switch branch
          </SecondaryButton>
          <PrimaryButton
            disabled={busy || !canCreate}
            onClick={() => {
              if (selectedBase !== undefined) {
                onCreate(newBranch.trim(), selectedBase.name, selectedBase.headRefHash);
              }
            }}
          >
            <Icons.plus size={12} /> Create branch
          </PrimaryButton>
        </div>
      </div>
    </Panel>
  );
}

// ─── Staging section (stage / unstage) ────────────────────────────────────────────────────────────

interface StagingSectionProps {
  readonly busy: boolean;
  readonly onStage: (pathspecs: readonly string[], includeUntracked: boolean) => void;
  readonly onUnstage: (pathspecs: readonly string[]) => void;
}

function parsePathspecs(raw: string): readonly string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function StagingSection({ busy, onStage, onUnstage }: StagingSectionProps): ReactNode {
  const [pathspecs, setPathspecs] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const parsed = parsePathspecs(pathspecs);
  const hint = `${parsed.length.toString()} pathspec${parsed.length === 1 ? "" : "s"}`;
  return (
    <Panel
      icon={<Icons.files size={14} />}
      title="Staging"
      description="Stage or unstage explicit pathspecs without exposing file content in the Git surface."
      badge={<StatusPill tone={parsed.length > 0 ? "accent" : "neutral"}>{hint}</StatusPill>}
    >
      <FieldLabel label="Pathspecs (one per line)">
        <textarea
          style={{ ...TEXTAREA_STYLE, minHeight: 104 }}
          value={pathspecs}
          onChange={(e) => setPathspecs(e.target.value)}
          aria-label="Pathspecs (one per line)"
          placeholder={"src/app/file.ts\ndocs/runbook.md"}
        />
      </FieldLabel>
      <div style={ACTION_ROW_STYLE}>
        <label style={CHECKBOX_LABEL_STYLE}>
          <input
            type="checkbox"
            checked={includeUntracked}
            onChange={(e) => setIncludeUntracked(e.target.checked)}
            aria-label="Include untracked files"
          />
          Include untracked files
        </label>
        <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
          <SecondaryButton disabled={busy || parsed.length === 0} onClick={() => onUnstage(parsed)}>
            <Icons.files size={12} /> Unstage
          </SecondaryButton>
          <PrimaryButton
            disabled={busy || parsed.length === 0}
            onClick={() => onStage(parsed, includeUntracked)}
          >
            <Icons.check size={12} /> Stage
          </PrimaryButton>
        </div>
      </div>
    </Panel>
  );
}

// ─── Commit preview body (warnings / violations / findings / policy) ──────────────────────────────

function CommitPreviewBody({
  preview,
}: {
  readonly preview: GitDeliveryCommitPreviewResponse;
}): ReactNode {
  const violations = preview.messageValidation.ok ? [] : preview.messageValidation.violations;
  return (
    <div data-testid="ggit-preview" style={PREVIEW_STYLE}>
      <div
        style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", flexWrap: "wrap" }}
      >
        <StatusPill tone={preview.policyOutcome === "blocked" ? "danger" : "success"}>
          <Icons.check size={11} /> Preview
        </StatusPill>
        <p style={{ ...SUBTLE_TEXT_STYLE, color: "var(--text-primary)" }}>
          {preview.summary.stagedFileCount.toString()} staged file
          {preview.summary.stagedFileCount === 1 ? "" : "s"} across{" "}
          {preview.summary.areaCount.toString()} area
          {preview.summary.areaCount === 1 ? "" : "s"}
          {preview.summary.touchesTests ? " · touches tests" : ""}
        </p>
      </div>
      {preview.intent.suggestedSubjectPrefix !== undefined ? (
        <p
          data-testid="ggit-suggested-prefix"
          style={{ ...SUBTLE_TEXT_STYLE, color: "var(--text-primary)" }}
        >
          Suggested prefix: <code style={MONO_STYLE}>{preview.intent.suggestedSubjectPrefix}</code>
        </p>
      ) : null}
      <CodeList
        label="Quality warnings"
        testid="ggit-warnings"
        items={preview.intent.warnings.map((w) => ({ key: w, text: warningLabel(w) }))}
      />
      <CodeList
        label="Message-policy violations"
        testid="ggit-violations"
        items={violations.map((v) => ({ key: v, text: violationLabel(v) }))}
      />
      <CodeList
        label="Preflight findings"
        testid="ggit-findings"
        items={preview.preflightFindingCodes.map((c) => ({ key: c, text: c }))}
      />
      <p data-testid="ggit-policy" style={{ ...SUBTLE_TEXT_STYLE, color: "var(--text-primary)" }}>
        <Icons.check size={12} /> Policy: <strong>{preview.policyOutcome}</strong>
        {preview.policyBlockReason !== undefined ? ` (${preview.policyBlockReason})` : ""}
      </p>
    </div>
  );
}

function CodeList({
  label,
  testid,
  items,
}: {
  readonly label: string;
  readonly testid: string;
  readonly items: readonly { readonly key: string; readonly text: string }[];
}): ReactNode {
  if (items.length === 0) return null;
  return (
    <div data-testid={testid}>
      <p
        style={{
          margin: "0 0 var(--space-2)",
          font: "var(--weight-semibold) var(--text-caption) var(--font-ui)",
          color: "var(--text-faint)",
          textTransform: "uppercase",
          letterSpacing: "0.03em",
        }}
      >
        {label}
      </p>
      <ul
        style={{
          margin: 0,
          paddingLeft: "var(--space-7)",
          font: "var(--text-body-sm) var(--font-ui)",
        }}
      >
        {items.map((item) => (
          <li
            key={item.key}
            style={{ color: "var(--text-primary)", lineHeight: "var(--leading-normal)" }}
          >
            <Icons.info size={11} /> {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Commit composer (message + live preview + execute) ──────────────────────────────────────────

interface CommitComposerProps {
  readonly busy: boolean;
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly previewError: string | null;
  readonly onPreview: (messageDraft: string) => void;
  readonly onExecute: (message: string) => void;
}

function CommitComposer({
  busy,
  preview,
  previewError,
  onPreview,
  onExecute,
}: CommitComposerProps): ReactNode {
  const [message, setMessage] = useState("");
  return (
    <Panel
      icon={<Icons.git size={14} />}
      title="Commit"
      description="Compose the commit intent, preview policy findings, then execute through the Git workflow."
      badge={<StatusPill tone={message.trim() !== "" ? "accent" : "neutral"}>Intent</StatusPill>}
    >
      <FieldLabel label="Commit message">
        <textarea
          style={{ ...TEXTAREA_STYLE, minHeight: 124 }}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          aria-label="Commit message"
          placeholder={
            "feat(scope): concise subject\n\nExplain the reviewed intent and verification evidence."
          }
        />
      </FieldLabel>
      <div style={ACTION_ROW_STYLE}>
        <p style={SUBTLE_TEXT_STYLE}>
          Preview validates policy before the write action is offered.
        </p>
        <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
          <SecondaryButton disabled={busy} onClick={() => onPreview(message)}>
            <Icons.search size={12} /> Preview
          </SecondaryButton>
          <PrimaryButton
            disabled={busy || message.trim() === ""}
            onClick={() => onExecute(message)}
          >
            <Icons.check size={12} /> Commit
          </PrimaryButton>
        </div>
      </div>
      {previewError !== null ? (
        <div role="alert" style={{ ...PREVIEW_STYLE, borderColor: "var(--feedback-danger)" }}>
          <StatusPill tone="danger">
            <Icons.info size={11} /> Preview error
          </StatusPill>
          <p style={SUBTLE_TEXT_STYLE}>{previewError}</p>
        </div>
      ) : null}
      {preview !== null ? <CommitPreviewBody preview={preview} /> : null}
    </Panel>
  );
}

// ─── Publish section (governed push: preview + execute) ───────────────────────────────────────────

function PublishPreviewBody({
  preview,
}: {
  readonly preview: GitDeliveryPushPreviewResponse;
}): ReactNode {
  return (
    <div data-testid="ggit-push-preview" style={PREVIEW_STYLE}>
      <div
        style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", flexWrap: "wrap" }}
      >
        <StatusPill tone={preview.forceBlocked ? "danger" : "info"}>
          <Icons.git size={11} /> Push preview
        </StatusPill>
        <p style={{ ...SUBTLE_TEXT_STYLE, color: "var(--text-primary)" }}>
          Target: <code style={MONO_STYLE}>{preview.remoteAlias}</code> ·{" "}
          <code style={MONO_STYLE}>{preview.remoteBranchName}</code> · risk {preview.riskClass}
          {preview.wouldCreateRemoteBranch ? " · creates remote branch" : ""}
          {preview.forceBlocked ? " · force blocked" : ""}
        </p>
      </div>
      <CodeList
        label="Preflight findings"
        testid="ggit-push-findings"
        items={preview.preflightBlockingCodes.map((c) => ({ key: c, text: c }))}
      />
      <p
        data-testid="ggit-push-policy"
        style={{ ...SUBTLE_TEXT_STYLE, color: "var(--text-primary)" }}
      >
        <Icons.check size={12} /> Policy: <strong>{preview.policyOutcome}</strong>
        {preview.policyBlockReason !== undefined ? ` (${preview.policyBlockReason})` : ""}
      </p>
    </div>
  );
}

interface PublishSectionProps {
  readonly busy: boolean;
  readonly client: GovernedGitFlowClient;
  readonly projectId: string;
  readonly onExecute: (op: () => Promise<GovernedGitOutcome>) => void;
}

function PublishSection({ busy, client, projectId, onExecute }: PublishSectionProps): ReactNode {
  const [remoteAlias, setRemoteAlias] = useState("origin");
  const [remoteBranch, setRemoteBranch] = useState("");
  const [sourceBranch, setSourceBranch] = useState("");
  const [setUpstream, setSetUpstream] = useState(false);
  const [preview, setPreview] = useState<GitDeliveryPushPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const ready = remoteAlias !== "" && remoteBranch !== "" && sourceBranch !== "";
  const input = {
    projectId,
    remoteAlias,
    remoteBranchName: remoteBranch,
    sourceBranchName: sourceBranch,
    setUpstreamTracking: setUpstream,
  } as const;
  const onPreview = (): void => {
    setPreviewError(null);
    void client.pushPreview(input).then(
      (res) => setPreview(res),
      (err: unknown) => {
        setPreview(null);
        setPreviewError(formatError(err));
      },
    );
  };
  return (
    <Panel
      icon={<Icons.git size={14} />}
      title="Publish"
      description="Preview and push a constrained branch target with upstream tracking controlled explicitly."
      badge={<StatusPill tone={ready ? "accent" : "neutral"}>Remote</StatusPill>}
    >
      <div style={ROW_STYLE}>
        <FieldLabel label="Remote">
          <input
            style={FIELD_STYLE}
            value={remoteAlias}
            onChange={(e) => setRemoteAlias(e.target.value)}
            aria-label="Remote alias"
          />
        </FieldLabel>
        <FieldLabel label="Source branch">
          <input
            style={FIELD_STYLE}
            value={sourceBranch}
            onChange={(e) => setSourceBranch(e.target.value)}
            aria-label="Source branch"
            placeholder="feat/change-flow"
          />
        </FieldLabel>
      </div>
      <FieldLabel label="Remote branch">
        <input
          style={FIELD_STYLE}
          value={remoteBranch}
          onChange={(e) => setRemoteBranch(e.target.value)}
          aria-label="Remote branch"
          placeholder="feat/change-flow"
        />
      </FieldLabel>
      <div style={ACTION_ROW_STYLE}>
        <label style={CHECKBOX_LABEL_STYLE}>
          <input
            type="checkbox"
            checked={setUpstream}
            onChange={(e) => setSetUpstream(e.target.checked)}
            aria-label="Set upstream tracking"
          />
          Set upstream tracking
        </label>
        <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
          <SecondaryButton disabled={busy || !ready} onClick={onPreview}>
            <Icons.search size={12} /> Preview push
          </SecondaryButton>
          <PrimaryButton
            disabled={busy || !ready}
            onClick={() => onExecute(() => client.pushExecute(input))}
          >
            <Icons.arrowUp size={12} /> Push
          </PrimaryButton>
        </div>
      </div>
      {previewError !== null ? (
        <div role="alert" style={{ ...PREVIEW_STYLE, borderColor: "var(--feedback-danger)" }}>
          <StatusPill tone="danger">
            <Icons.info size={11} /> Push preview error
          </StatusPill>
          <p style={SUBTLE_TEXT_STYLE}>{previewError}</p>
        </div>
      ) : null}
      {preview !== null ? <PublishPreviewBody preview={preview} /> : null}
    </Panel>
  );
}

// ─── Repository manager (clone/register/select/open) ─────────────────────────────────────────────

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

function RepositoryManager({
  client,
  selectedProjectId,
  liveId,
  onSelect,
  onOpenFiles,
  onOpenEditor,
}: {
  readonly client: GovernedGitFlowClient;
  readonly selectedProjectId: string | null;
  readonly liveId: string;
  readonly onSelect: (projectId: string) => void;
  readonly onOpenFiles?: ((projectPath: string) => void) | undefined;
  readonly onOpenEditor?: ((projectPath: string) => void) | undefined;
}): ReactNode {
  const [repositories, setRepositories] = useState<readonly ProjectWithAvailability[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [destinationPath, setDestinationPath] = useState("");
  const [existingPath, setExistingPath] = useState("");
  const [lastAdded, setLastAdded] = useState<ProjectWithAvailability | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(selectedProjectId);

  const loadRepositories = useCallback((): void => {
    setLoadError(null);
    void client.listRepositories().then(
      (res) => setRepositories(res.projects),
      (err: unknown) => {
        setRepositories([]);
        setLoadError(formatError(err));
      },
    );
  }, [client]);

  useEffect(() => {
    loadRepositories();
  }, [loadRepositories]);

  useEffect(() => {
    setExpandedProjectId(selectedProjectId);
  }, [selectedProjectId]);

  const selectAndRemember = useCallback(
    (project: ProjectWithAvailability): void => {
      setLastAdded(project);
      onSelect(project.path);
      setExpandedProjectId(project.path);
    },
    [onSelect],
  );

  const runRepositoryAction = useCallback(
    (op: () => Promise<{ readonly project: ProjectWithAvailability }>): void => {
      setBusy(true);
      setLoadError(null);
      void op().then(
        (res) => {
          setBusy(false);
          selectAndRemember(res.project);
          loadRepositories();
        },
        (err: unknown) => {
          setBusy(false);
          setLoadError(formatError(err));
        },
      );
    },
    [loadRepositories, selectAndRemember],
  );

  const canClone = repositoryUrl.trim() !== "" && destinationPath.trim() !== "";
  const canRegister = existingPath.trim() !== "";
  const visibleRepositories =
    selectedProjectId !== null && repositories.every((repo) => repo.path !== selectedProjectId)
      ? [
          {
            path: selectedProjectId,
            name: basename(selectedProjectId),
            favorite: false,
            createdAt: 0,
            lastOpenedAt: 0,
            available: true,
          },
          ...repositories,
        ]
      : repositories;

  return (
    <>
      <Panel
        icon={<Icons.plus size={14} />}
        title="Add repository"
        description="Clone a repository into a local folder or register an existing working copy."
        badge={
          <StatusPill tone={repositories.length > 0 ? "accent" : "neutral"}>
            {`${visibleRepositories.length.toString()} repos`}
          </StatusPill>
        }
      >
        {loadError !== null ? (
          <div role="alert" style={{ ...PREVIEW_STYLE, borderColor: "var(--feedback-danger)" }}>
            <StatusPill tone="danger">
              <Icons.info size={11} /> Repository error
            </StatusPill>
            <p style={SUBTLE_TEXT_STYLE}>{loadError}</p>
          </div>
        ) : null}

        <div style={ROW_STYLE}>
          <FieldLabel label="Repository URL">
            <input
              style={FIELD_STYLE}
              value={repositoryUrl}
              onChange={(event) => setRepositoryUrl(event.target.value)}
              aria-label="Repository URL"
              placeholder="https://github.com/org/repo.git"
            />
          </FieldLabel>
          <FieldLabel label="Clone to folder">
            <input
              style={FIELD_STYLE}
              value={destinationPath}
              onChange={(event) => setDestinationPath(event.target.value)}
              aria-label="Clone to folder"
              placeholder="/Users/me/Work/repo"
            />
          </FieldLabel>
        </div>
        <div style={ACTION_ROW_STYLE}>
          <p style={SUBTLE_TEXT_STYLE}>
            Clone creates the local working copy and registers it here.
          </p>
          <PrimaryButton
            disabled={busy || !canClone}
            onClick={() =>
              runRepositoryAction(() =>
                client.cloneRepository({
                  repositoryUrl: repositoryUrl.trim(),
                  destinationPath: destinationPath.trim(),
                }),
              )
            }
          >
            <Icons.plus size={12} /> Clone repository
          </PrimaryButton>
        </div>

        <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-5)" }}>
          <div style={ROW_STYLE}>
            <FieldLabel label="Existing working copy">
              <input
                style={FIELD_STYLE}
                value={existingPath}
                onChange={(event) => setExistingPath(event.target.value)}
                aria-label="Existing working copy"
                placeholder="/Users/me/Work/existing-repo"
              />
            </FieldLabel>
            <div style={{ display: "flex", alignItems: "end" }}>
              <SecondaryButton
                disabled={busy || !canRegister}
                onClick={() =>
                  runRepositoryAction(() =>
                    client.registerRepository({
                      path: existingPath.trim(),
                      name: basename(existingPath.trim()),
                    }),
                  )
                }
              >
                <Icons.folder size={12} /> Register repository
              </SecondaryButton>
            </div>
          </div>
        </div>

        {lastAdded !== null ? (
          <div style={PREVIEW_STYLE} role="status" aria-live="polite">
            <StatusPill tone="success">
              <Icons.check size={11} /> Repository ready
            </StatusPill>
            <p style={{ ...SUBTLE_TEXT_STYLE, color: "var(--text-primary)" }}>
              {lastAdded.name} is ready at <code style={MONO_STYLE}>{lastAdded.path}</code>.
            </p>
            <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
              {onOpenEditor !== undefined ? (
                <SecondaryButton onClick={() => onOpenEditor(lastAdded.path)}>
                  <Icons.edit size={12} /> Open in Editor
                </SecondaryButton>
              ) : null}
              {onOpenFiles !== undefined ? (
                <SecondaryButton onClick={() => onOpenFiles(lastAdded.path)}>
                  <Icons.files size={12} /> Open in Files
                </SecondaryButton>
              ) : null}
            </div>
          </div>
        ) : null}
      </Panel>

      <section
        aria-label="Repositories"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
      >
        <div style={PANEL_HEADER_STYLE}>
          <div>
            <p style={EYEBROW_STYLE}>Repositories</p>
            <h3 style={PANEL_TITLE_STYLE}>
              <Icons.git size={14} />
              Working copies
            </h3>
          </div>
          <StatusPill tone={expandedProjectId === null ? "neutral" : "accent"}>
            {expandedProjectId === null ? "All collapsed" : "Repository open"}
          </StatusPill>
        </div>
        {visibleRepositories.length === 0 ? (
          <div style={PREVIEW_STYLE}>
            <p style={SUBTLE_TEXT_STYLE}>No repositories registered yet.</p>
          </div>
        ) : (
          visibleRepositories.map((repo) => {
            const expanded = expandedProjectId === repo.path;
            return (
              <RepositoryAccordion
                key={repo.path}
                repo={repo}
                expanded={expanded}
                liveId={liveId}
                client={client}
                onToggle={() => {
                  const next = expanded ? null : repo.path;
                  setExpandedProjectId(next);
                  if (next !== null) onSelect(next);
                }}
                onOpenEditor={onOpenEditor}
                onOpenFiles={onOpenFiles}
              />
            );
          })
        )}
      </section>
    </>
  );
}

function RepositoryAccordion({
  repo,
  expanded,
  liveId,
  client,
  onToggle,
  onOpenEditor,
  onOpenFiles,
}: {
  readonly repo: ProjectWithAvailability;
  readonly expanded: boolean;
  readonly liveId: string;
  readonly client: GovernedGitFlowClient;
  readonly onToggle: () => void;
  readonly onOpenFiles?: ((projectPath: string) => void) | undefined;
  readonly onOpenEditor?: ((projectPath: string) => void) | undefined;
}): ReactNode {
  return (
    <article
      style={{
        border: `1px solid ${expanded ? "var(--border-accent)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius-surface)",
        background: expanded ? "var(--surface-primary)" : "var(--surface-inset)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          gap: "var(--space-5)",
          alignItems: "center",
          padding: "var(--space-4)",
        }}
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          style={{
            display: "grid",
            gridTemplateColumns: "24px minmax(0, 1fr)",
            gap: "var(--space-4)",
            alignItems: "center",
            minWidth: 0,
            padding: 0,
            border: 0,
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "grid",
              placeItems: "center",
              width: 24,
              height: 24,
              color: "var(--text-accent)",
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform 120ms ease",
            }}
          >
            <Icons.chevronR size={13} />
          </span>
          <span style={{ minWidth: 0 }}>
            <span
              style={{
                display: "block",
                font: "var(--weight-semibold) var(--text-body-sm) var(--font-ui)",
                color: "var(--text-primary)",
              }}
            >
              {repo.name}
            </span>
            <code
              style={{
                ...MONO_STYLE,
                display: "block",
                marginTop: 2,
                color: "var(--text-secondary)",
                overflowWrap: "anywhere",
              }}
            >
              {repo.path}
            </code>
          </span>
        </button>
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
          {onOpenEditor !== undefined ? (
            <SecondaryButton onClick={() => onOpenEditor(repo.path)}>
              <Icons.edit size={12} /> Editor
            </SecondaryButton>
          ) : null}
          {onOpenFiles !== undefined ? (
            <SecondaryButton onClick={() => onOpenFiles(repo.path)}>
              <Icons.files size={12} /> Files
            </SecondaryButton>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div
          style={{
            borderTop: "1px solid var(--border-subtle)",
            padding: "var(--space-5)",
            background: "var(--surface-primary)",
          }}
        >
          <WorktreeWorkflow client={client} projectId={repo.path} liveId={liveId} />
        </div>
      ) : null}
    </article>
  );
}

// ─── Async action runner (shared busy + outcome + error state) ────────────────────────────────────

interface FlowState {
  readonly busy: boolean;
  readonly outcome: GovernedGitOutcome | null;
  readonly error: string | null;
}

function useGovernedGitActions(
  client: GovernedGitFlowClient,
  projectId: string,
): {
  readonly flow: FlowState;
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly previewError: string | null;
  readonly runMutation: (op: () => Promise<GovernedGitOutcome>) => void;
  readonly runPreview: (messageDraft: string) => void;
} {
  const [flow, setFlow] = useState<FlowState>({ busy: false, outcome: null, error: null });
  const [preview, setPreview] = useState<GitDeliveryCommitPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const runMutation = useCallback((op: () => Promise<GovernedGitOutcome>): void => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setFlow({ busy: true, outcome: null, error: null });
    void op().then(
      (res) => {
        if (seqRef.current === seq) setFlow({ busy: false, outcome: res, error: null });
      },
      (err: unknown) => {
        if (seqRef.current === seq)
          setFlow({ busy: false, outcome: null, error: formatError(err) });
      },
    );
  }, []);

  const runPreview = useCallback(
    (messageDraft: string): void => {
      setPreviewError(null);
      void client.commitPreview({ projectId, messageDraft }).then(
        (res) => setPreview(res),
        (err: unknown) => {
          setPreview(null);
          setPreviewError(formatError(err));
        },
      );
    },
    [client, projectId],
  );

  return { flow, preview, previewError, runMutation, runPreview };
}

function FlowOverview({
  flow,
  projectId,
}: {
  readonly flow: FlowState;
  readonly projectId: string;
}): ReactNode {
  const steps = [
    { label: "Branch", detail: "Bounded local change target", icon: <Icons.branch size={13} /> },
    { label: "Stage", detail: "Explicit pathspec mutation", icon: <Icons.files size={13} /> },
    { label: "Commit", detail: "Message and policy preview", icon: <Icons.git size={13} /> },
    { label: "Push", detail: "Constrained remote publish", icon: <Icons.arrowUp size={13} /> },
  ] as const;
  const statusText = flow.busy
    ? "Running"
    : flow.outcome !== null
      ? STATUS_LABEL[flow.outcome.status]
      : flow.error !== null
        ? "Error"
        : "Ready";
  const tone =
    flow.busy ||
    flow.outcome?.status === "approval-required" ||
    flow.outcome?.status === "recovery-required"
      ? "warning"
      : flow.outcome?.status === "succeeded"
        ? "success"
        : flow.error !== null ||
            flow.outcome?.status === "blocked" ||
            flow.outcome?.status === "failed"
          ? "danger"
          : "accent";

  return (
    <div
      style={{
        ...PANEL_STYLE,
        gap: "var(--space-6)",
        alignSelf: "start",
        position: "sticky",
        top: "var(--space-5)",
      }}
      aria-label="Git workflow status"
    >
      <div>
        <p style={EYEBROW_STYLE}>Workflow</p>
        <h3 style={{ ...PANEL_TITLE_STYLE, marginBottom: "var(--space-3)" }}>Delivery path</h3>
        <StatusPill tone={tone}>{statusText}</StatusPill>
      </div>
      <ol
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
        }}
      >
        {steps.map((step, index) => (
          <li
            key={step.label}
            style={{
              display: "grid",
              gridTemplateColumns: "28px minmax(0, 1fr)",
              gap: "var(--space-4)",
              alignItems: "start",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 28,
                height: 28,
                display: "grid",
                placeItems: "center",
                borderRadius: "var(--radius-control)",
                border: "1px solid var(--border-subtle)",
                background: index === 0 ? "var(--surface-accent-subtle)" : "var(--surface-inset)",
                color: index === 0 ? "var(--accent-on-tint)" : "var(--text-secondary)",
              }}
            >
              {step.icon}
            </span>
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  font: "var(--weight-semibold) var(--text-body-sm) var(--font-ui)",
                  color: "var(--text-primary)",
                }}
              >
                {step.label}
              </span>
              <span
                style={{
                  display: "block",
                  marginTop: 1,
                  font: "var(--text-caption) var(--font-ui)",
                  color: "var(--text-secondary)",
                }}
              >
                {step.detail}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-5)" }}>
        <p style={{ ...EYEBROW_STYLE, marginBottom: "var(--space-3)" }}>Repository</p>
        <code
          style={{
            display: "block",
            maxWidth: "100%",
            padding: "var(--space-4)",
            borderRadius: "var(--radius-control)",
            background: "var(--surface-inset)",
            color: "var(--text-secondary)",
            font: "var(--text-caption) var(--font-mono)",
            overflowWrap: "anywhere",
          }}
        >
          {projectId}
        </code>
      </div>
    </div>
  );
}

// ─── Host card ────────────────────────────────────────────────────────────────────────────────────

export interface GovernedGitFlowCardProps {
  /** Optional repository path to preselect when opened from Files, Editor, or Runtime. */
  readonly projectId?: string | undefined;
  readonly onOpenFiles?: ((projectPath: string) => void) | undefined;
  readonly onOpenEditor?: ((projectPath: string) => void) | undefined;
  /** DI seam; defaults to the real BFF client. */
  readonly client?: GovernedGitFlowClient;
}

export function GovernedGitFlowCard({
  projectId,
  onOpenFiles,
  onOpenEditor,
  client = DEFAULT_CLIENT,
}: GovernedGitFlowCardProps): ReactNode {
  const titleId = useId();
  const liveId = useId();
  return (
    <GovernedGitFlowBody
      client={client}
      initialProjectId={projectId}
      titleId={titleId}
      liveId={liveId}
      onOpenFiles={onOpenFiles}
      onOpenEditor={onOpenEditor}
    />
  );
}

function GovernedGitFlowBody({
  client,
  initialProjectId,
  titleId,
  liveId,
  onOpenFiles,
  onOpenEditor,
}: {
  readonly client: GovernedGitFlowClient;
  readonly initialProjectId?: string | undefined;
  readonly titleId: string;
  readonly liveId: string;
  readonly onOpenFiles?: ((projectPath: string) => void) | undefined;
  readonly onOpenEditor?: ((projectPath: string) => void) | undefined;
}): ReactNode {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialProjectId !== undefined && initialProjectId !== "" ? initialProjectId : null,
  );
  useEffect(() => {
    if (initialProjectId !== undefined && initialProjectId !== "") {
      setSelectedProjectId(initialProjectId);
    }
  }, [initialProjectId]);

  return (
    <div style={SHELL_STYLE} aria-labelledby={titleId}>
      <header style={TOPBAR_STYLE}>
        <h2 id={titleId} style={{ ...HEADING_STYLE, fontSize: "var(--text-title)" }}>
          Repository Manager
        </h2>
        <StatusPill tone={selectedProjectId === null ? "neutral" : "accent"}>
          {selectedProjectId === null ? "No repository selected" : "Repository selected"}
        </StatusPill>
      </header>
      <RepositoryManager
        client={client}
        selectedProjectId={selectedProjectId}
        liveId={liveId}
        onSelect={setSelectedProjectId}
        onOpenFiles={onOpenFiles}
        onOpenEditor={onOpenEditor}
      />
      {selectedProjectId === null ? (
        <p
          id={liveId}
          data-testid="ggit-live"
          role="status"
          aria-live="polite"
          style={SUBTLE_TEXT_STYLE}
        >
          Clone or register a repository to unlock local Git workflows.
        </p>
      ) : null}
    </div>
  );
}

function WorktreeWorkflow({
  client,
  projectId,
  liveId,
}: {
  readonly client: GovernedGitFlowClient;
  readonly projectId: string;
  readonly liveId: string;
}): ReactNode {
  const { flow, preview, previewError, runMutation, runPreview } = useGovernedGitActions(
    client,
    projectId,
  );
  const [branches, setBranches] = useState<readonly GitBranchListEntry[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const loadBranches = useCallback((): void => {
    setBranchesLoading(true);
    setBranchesError(null);
    void client.listBranches(projectId).then(
      (res) => {
        setBranchesLoading(false);
        setBranches(res.available ? res.branches : []);
        setBranchesError(res.available ? null : (res.message ?? "Local branches are unavailable."));
      },
      (err: unknown) => {
        setBranchesLoading(false);
        setBranches([]);
        setBranchesError(formatError(err));
      },
    );
  }, [client, projectId]);

  useEffect(() => {
    loadBranches();
  }, [loadBranches]);

  const runBranchMutation = useCallback(
    (op: () => Promise<GovernedGitOutcome>): void => {
      runMutation(async () => {
        const outcome = await op();
        loadBranches();
        return outcome;
      });
    },
    [loadBranches, runMutation],
  );

  const liveText =
    flow.error !== null
      ? `Action failed: ${flow.error}`
      : flow.outcome !== null
        ? `${flow.outcome.actionKind} ${STATUS_LABEL[flow.outcome.status].toLowerCase()}.`
        : "";
  return (
    <>
      <p
        id={liveId}
        data-testid="ggit-live"
        role="status"
        aria-live="polite"
        style={VISUALLY_HIDDEN_STYLE}
      >
        {liveText}
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(220px, 0.32fr) minmax(min(100%, 460px), 1fr)",
          gap: "var(--space-6)",
          alignItems: "start",
        }}
      >
        <FlowOverview flow={flow} projectId={projectId} />
        <div
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)", minWidth: 0 }}
        >
          <MutationOutcome outcome={flow.outcome} error={flow.error} />
          <BranchSection
            busy={flow.busy}
            branches={branches}
            branchesLoading={branchesLoading}
            branchesError={branchesError}
            onCreate={(branchName, baseBranchName, startPointRefHash) =>
              runBranchMutation(() =>
                client.branchCreate({ projectId, branchName, baseBranchName, startPointRefHash }),
              )
            }
            onSwitch={(branchName) =>
              runBranchMutation(() => client.branchSwitch({ projectId, branchName }))
            }
          />
          <StagingSection
            busy={flow.busy}
            onStage={(pathspecs, includeUntracked) =>
              runMutation(() => client.stage({ projectId, pathspecs, includeUntracked }))
            }
            onUnstage={(pathspecs) => runMutation(() => client.unstage({ projectId, pathspecs }))}
          />
          <CommitComposer
            busy={flow.busy}
            preview={preview}
            previewError={previewError}
            onPreview={runPreview}
            onExecute={(message) => runMutation(() => client.commitExecute({ projectId, message }))}
          />
          <PublishSection
            busy={flow.busy}
            client={client}
            projectId={projectId}
            onExecute={runMutation}
          />
        </div>
      </div>
    </>
  );
}
