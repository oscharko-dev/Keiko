"use client";

// Governed local Git flow surface (Issue #475, Epic #470). A per-project card that walks
//   Branch (create / switch) → Staging (stage / unstage) → Commit composer (live preview + execute)
// entirely through the governed mutation kernel exposed by the BFF. Every mutation is content-free:
// the surface shows counts, structural area tokens, branch names, and typed warning / violation /
// finding codes — never diff content, raw paths, secrets, or the commit-message body.
//
// Severity and outcome are conveyed by TEXT + icon, never colour alone (WCAG 2.2 AA). Styling uses
// inline styles backed by existing CSS custom properties so globals.css is untouched (ADR-0051 gate).

import { useCallback, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  GitCommitMessageViolationCode,
  GitCommitQualityWarningCode,
} from "@oscharko-dev/keiko-contracts";
import {
  ApiError,
  fetchGitDeliveryCommitExecute,
  fetchGitDeliveryCommitPreview,
  fetchGitDeliveryLocalBranchCreate,
  fetchGitDeliveryLocalBranchSwitch,
  fetchGitDeliveryStage,
  fetchGitDeliveryUnstage,
  type GitDeliveryCommitPreviewResponse,
  type GitDeliveryMutationResponse,
} from "@/lib/api";
import { Icons } from "../../Icons";

// ─── Injected client (DI seam for tests) ────────────────────────────────────────────────────────

export interface GovernedGitFlowClient {
  readonly branchCreate: typeof fetchGitDeliveryLocalBranchCreate;
  readonly branchSwitch: typeof fetchGitDeliveryLocalBranchSwitch;
  readonly stage: typeof fetchGitDeliveryStage;
  readonly unstage: typeof fetchGitDeliveryUnstage;
  readonly commitPreview: typeof fetchGitDeliveryCommitPreview;
  readonly commitExecute: typeof fetchGitDeliveryCommitExecute;
}

const DEFAULT_CLIENT: GovernedGitFlowClient = {
  branchCreate: fetchGitDeliveryLocalBranchCreate,
  branchSwitch: fetchGitDeliveryLocalBranchSwitch,
  stage: fetchGitDeliveryStage,
  unstage: fetchGitDeliveryUnstage,
  commitPreview: fetchGitDeliveryCommitPreview,
  commitExecute: fetchGitDeliveryCommitExecute,
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

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-3)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-md)",
  background: "var(--card)",
};

const HEADING_STYLE: CSSProperties = {
  margin: 0,
  font: "var(--text-label)",
  color: "var(--text-heading)",
};

const FIELD_STYLE: CSSProperties = {
  width: "100%",
  padding: "var(--space-2)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-control)",
  background: "var(--background-secondary)",
  color: "var(--text-body)",
  font: "var(--text-body-sm)",
};

const ROW_STYLE: CSSProperties = { display: "flex", gap: "var(--space-2)", flexWrap: "wrap" };

const PRIMARY_BTN: CSSProperties = {
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-control)",
  background: "var(--button-primary-surface)",
  color: "var(--button-primary-text)",
  cursor: "pointer",
};

const GHOST_BTN: CSSProperties = {
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-control)",
  background: "var(--button-secondary-surface)",
  color: "var(--button-secondary-text)",
  cursor: "pointer",
};

const LABEL_STYLE: CSSProperties = {
  font: "var(--text-caption)",
  color: "var(--fg-muted)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

// ─── Outcome banner (text + icon; never colour alone) ────────────────────────────────────────────

function MutationOutcome({
  outcome,
  error,
}: {
  readonly outcome: GitDeliveryMutationResponse | null;
  readonly error: string | null;
}): ReactNode {
  if (error !== null) {
    return (
      <p role="alert" style={{ font: "var(--text-body-sm)", color: "var(--feedback-danger)" }}>
        <Icons.info size={12} /> {error}
      </p>
    );
  }
  if (outcome === null) return null;
  const codes = [
    ...(outcome.blockReason !== undefined ? [`reason: ${outcome.blockReason}`] : []),
    ...(outcome.preflightFindingCodes ?? []).map((c) => `preflight: ${c}`),
    ...(outcome.requiredApprovers ?? []).map((a) => `approver: ${a}`),
    ...(outcome.executionErrorCode !== undefined ? [`error: ${outcome.executionErrorCode}`] : []),
    ...(outcome.messageViolations ?? []).map((v) => violationLabel(v)),
  ];
  return (
    <div
      data-testid="ggit-outcome"
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
    >
      <p style={{ font: "var(--text-body-sm)", color: "var(--text-body)", margin: 0 }}>
        <Icons.check size={12} /> {outcome.actionKind}: {STATUS_LABEL[outcome.status]}
      </p>
      {codes.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: "var(--space-4)", font: "var(--text-caption)" }}>
          {codes.map((code) => (
            <li key={code} style={{ color: "var(--fg-muted)" }}>
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
  readonly onCreate: (
    branchName: string,
    baseBranchName: string,
    startPointRefHash: string,
  ) => void;
  readonly onSwitch: (branchName: string) => void;
}

function BranchSection({ busy, onCreate, onSwitch }: BranchSectionProps): ReactNode {
  const [newBranch, setNewBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [startPoint, setStartPoint] = useState("");
  const [switchTo, setSwitchTo] = useState("");
  const canCreate = newBranch !== "" && baseBranch !== "" && startPoint !== "";
  return (
    <section style={SECTION_STYLE} aria-label="Branch">
      <h3 style={HEADING_STYLE}>
        <Icons.branch size={12} /> Branch
      </h3>
      <label style={LABEL_STYLE}>
        New branch name
        <input
          style={FIELD_STYLE}
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          aria-label="New branch name"
        />
      </label>
      <div style={ROW_STYLE}>
        <label style={{ ...LABEL_STYLE, flex: 1 }}>
          Base branch
          <input
            style={FIELD_STYLE}
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            aria-label="Base branch"
          />
        </label>
        <label style={{ ...LABEL_STYLE, flex: 1 }}>
          Start-point ref hash
          <input
            style={FIELD_STYLE}
            value={startPoint}
            onChange={(e) => setStartPoint(e.target.value)}
            aria-label="Start-point ref hash"
          />
        </label>
      </div>
      <button
        type="button"
        style={PRIMARY_BTN}
        disabled={busy || !canCreate}
        onClick={() => onCreate(newBranch, baseBranch, startPoint)}
      >
        Create branch
      </button>
      <label style={LABEL_STYLE}>
        Switch to branch
        <input
          style={FIELD_STYLE}
          value={switchTo}
          onChange={(e) => setSwitchTo(e.target.value)}
          aria-label="Switch to branch"
        />
      </label>
      <button
        type="button"
        style={GHOST_BTN}
        disabled={busy || switchTo === ""}
        onClick={() => onSwitch(switchTo)}
      >
        Switch branch
      </button>
    </section>
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
    <section style={SECTION_STYLE} aria-label="Staging">
      <h3 style={HEADING_STYLE}>
        <Icons.files size={12} /> Staging
      </h3>
      <label style={LABEL_STYLE}>
        Pathspecs (one per line)
        <textarea
          style={{ ...FIELD_STYLE, minHeight: 60, resize: "vertical" }}
          value={pathspecs}
          onChange={(e) => setPathspecs(e.target.value)}
          aria-label="Pathspecs"
        />
      </label>
      <p style={{ font: "var(--text-caption)", color: "var(--fg-muted)", margin: 0 }}>{hint}</p>
      <label style={{ ...LABEL_STYLE, flexDirection: "row", alignItems: "center" }}>
        <input
          type="checkbox"
          checked={includeUntracked}
          onChange={(e) => setIncludeUntracked(e.target.checked)}
          aria-label="Include untracked files"
        />
        Include untracked files
      </label>
      <div style={ROW_STYLE}>
        <button
          type="button"
          style={PRIMARY_BTN}
          disabled={busy || parsed.length === 0}
          onClick={() => onStage(parsed, includeUntracked)}
        >
          Stage
        </button>
        <button
          type="button"
          style={GHOST_BTN}
          disabled={busy || parsed.length === 0}
          onClick={() => onUnstage(parsed)}
        >
          Unstage
        </button>
      </div>
    </section>
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
    <div
      data-testid="ggit-preview"
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
    >
      <p style={{ font: "var(--text-body-sm)", color: "var(--text-body)", margin: 0 }}>
        {preview.summary.stagedFileCount.toString()} staged file
        {preview.summary.stagedFileCount === 1 ? "" : "s"} across{" "}
        {preview.summary.areaCount.toString()} area
        {preview.summary.areaCount === 1 ? "" : "s"}
        {preview.summary.touchesTests ? " · touches tests" : ""}
      </p>
      {preview.intent.suggestedSubjectPrefix !== undefined ? (
        <p
          data-testid="ggit-suggested-prefix"
          style={{ font: "var(--text-body-sm)", color: "var(--text-accent)", margin: 0 }}
        >
          Suggested prefix: <code>{preview.intent.suggestedSubjectPrefix}</code>
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
      <p
        data-testid="ggit-policy"
        style={{ font: "var(--text-body-sm)", color: "var(--text-body)", margin: 0 }}
      >
        <Icons.check size={12} /> Policy: {preview.policyOutcome}
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
      <p style={{ font: "var(--text-caption)", color: "var(--fg-muted)", margin: 0 }}>{label}</p>
      <ul style={{ margin: 0, paddingLeft: "var(--space-4)", font: "var(--text-body-sm)" }}>
        {items.map((item) => (
          <li key={item.key} style={{ color: "var(--text-body)" }}>
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
    <section style={SECTION_STYLE} aria-label="Commit">
      <h3 style={HEADING_STYLE}>
        <Icons.git size={12} /> Commit
      </h3>
      <label style={LABEL_STYLE}>
        Commit message
        <textarea
          style={{ ...FIELD_STYLE, minHeight: 88, resize: "vertical" }}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          aria-label="Commit message"
        />
      </label>
      <div style={ROW_STYLE}>
        <button type="button" style={GHOST_BTN} disabled={busy} onClick={() => onPreview(message)}>
          Preview
        </button>
        <button
          type="button"
          style={PRIMARY_BTN}
          disabled={busy || message.trim() === ""}
          onClick={() => onExecute(message)}
        >
          Commit
        </button>
      </div>
      {previewError !== null ? (
        <p role="alert" style={{ font: "var(--text-body-sm)", color: "var(--feedback-danger)" }}>
          <Icons.info size={12} /> {previewError}
        </p>
      ) : null}
      {preview !== null ? <CommitPreviewBody preview={preview} /> : null}
    </section>
  );
}

// ─── Async action runner (shared busy + outcome + error state) ────────────────────────────────────

interface FlowState {
  readonly busy: boolean;
  readonly outcome: GitDeliveryMutationResponse | null;
  readonly error: string | null;
}

function useGovernedGitActions(
  client: GovernedGitFlowClient,
  projectId: string,
): {
  readonly flow: FlowState;
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly previewError: string | null;
  readonly runMutation: (op: () => Promise<GitDeliveryMutationResponse>) => void;
  readonly runPreview: (messageDraft: string) => void;
} {
  const [flow, setFlow] = useState<FlowState>({ busy: false, outcome: null, error: null });
  const [preview, setPreview] = useState<GitDeliveryCommitPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const runMutation = useCallback((op: () => Promise<GitDeliveryMutationResponse>): void => {
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

// ─── Host card ────────────────────────────────────────────────────────────────────────────────────

export interface GovernedGitFlowCardProps {
  /** The active project workspace root (acts as projectId). When absent, an empty state renders. */
  readonly projectId?: string | undefined;
  /** DI seam; defaults to the real BFF client. */
  readonly client?: GovernedGitFlowClient;
}

export function GovernedGitFlowCard({
  projectId,
  client = DEFAULT_CLIENT,
}: GovernedGitFlowCardProps): ReactNode {
  const titleId = useId();
  const liveId = useId();

  if (projectId === undefined || projectId === "") {
    return (
      <div
        data-testid="ggit-empty"
        style={{ padding: "var(--space-4)", color: "var(--fg-muted)", font: "var(--text-body-sm)" }}
      >
        <p>
          <Icons.git size={13} /> Select a project to use governed Git flows.
        </p>
      </div>
    );
  }

  return (
    <GovernedGitFlowBody client={client} projectId={projectId} titleId={titleId} liveId={liveId} />
  );
}

function GovernedGitFlowBody({
  client,
  projectId,
  titleId,
  liveId,
}: {
  readonly client: GovernedGitFlowClient;
  readonly projectId: string;
  readonly titleId: string;
  readonly liveId: string;
}): ReactNode {
  const { flow, preview, previewError, runMutation, runPreview } = useGovernedGitActions(
    client,
    projectId,
  );
  const liveText =
    flow.error !== null
      ? `Action failed: ${flow.error}`
      : flow.outcome !== null
        ? `${flow.outcome.actionKind} ${STATUS_LABEL[flow.outcome.status].toLowerCase()}.`
        : "";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        padding: "var(--space-3)",
        overflow: "auto",
        height: "100%",
      }}
      aria-labelledby={titleId}
    >
      <h2 id={titleId} style={{ ...HEADING_STYLE, font: "var(--text-title)" }}>
        <Icons.git size={14} /> Governed Git
      </h2>
      <p
        id={liveId}
        data-testid="ggit-live"
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
        }}
      >
        {liveText}
      </p>
      <BranchSection
        busy={flow.busy}
        onCreate={(branchName, baseBranchName, startPointRefHash) =>
          runMutation(() =>
            client.branchCreate({ projectId, branchName, baseBranchName, startPointRefHash }),
          )
        }
        onSwitch={(branchName) => runMutation(() => client.branchSwitch({ projectId, branchName }))}
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
      <MutationOutcome outcome={flow.outcome} error={flow.error} />
    </div>
  );
}
