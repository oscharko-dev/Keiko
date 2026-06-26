"use client";

// Governed merge command center (Issue #478, Epic #470, ADR-0065). A per-project card, launched from the
// Pull Request section of the governed Git flow, that turns a review-ready pull request into a merged base
// branch through the governed merge gateway exposed by the BFF.
//
// It surfaces the merge target (repository / PR number / base + head branch), a STRATEGY SELECTOR populated
// from the preview's eligible strategies (policy ∩ provider capability — never a hard-coded default), a
// readiness summary (mergeable + severity-ranked blockers), the recommendation and policy decision, and a
// final high-risk approval affordance — then merges the PR. Provider failures are normalized into typed
// rejection / recovery states. Outcome is conveyed by TEXT + icon, never colour alone (WCAG 2.2 AA). Styling
// uses inline styles backed by existing CSS custom properties so globals.css is untouched (ADR-0051 gate).

import { useCallback, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  ApiError,
  fetchGitDeliveryMergeExecute,
  fetchGitDeliveryMergePreview,
  type GitDeliveryMergeExecuteResponse,
  type GitDeliveryMergeInput,
  type GitDeliveryMergePreviewResponse,
  type GitDeliveryMergeStrategy,
} from "@/lib/api";
import { Icons } from "../../Icons";

// ─── Injected client (DI seam for tests) ────────────────────────────────────────────────────────

export interface GovernedMergeClient {
  readonly mergePreview: typeof fetchGitDeliveryMergePreview;
  readonly mergeExecute: typeof fetchGitDeliveryMergeExecute;
}

const DEFAULT_CLIENT: GovernedMergeClient = {
  mergePreview: fetchGitDeliveryMergePreview,
  mergeExecute: fetchGitDeliveryMergeExecute,
};

const DISABLED_CODE = "GIT_DELIVERY_MERGE_DISABLED";

function isDisabledError(err: unknown): boolean {
  return err instanceof ApiError && err.code === DISABLED_CODE;
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}

// The human-readable label for a merge strategy. The set is closed (validated server-side), so an
// unrecognized value falls back to the raw token rather than throwing.
const STRATEGY_LABELS: Readonly<Record<GitDeliveryMergeStrategy, string>> = {
  squash: "Squash and merge",
  rebase: "Rebase and merge",
  "merge-commit": "Create a merge commit",
  "provider-default": "Provider default",
};

function strategyLabel(strategy: string): string {
  return STRATEGY_LABELS[strategy as GitDeliveryMergeStrategy] ?? strategy;
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
const KV_LABEL: CSSProperties = {
  font: "var(--text-caption)",
  color: "var(--fg-muted)",
  margin: 0,
};

// ─── Form state ───────────────────────────────────────────────────────────────────────────────────

interface MergeForm {
  readonly ownerAndRepo: string;
  readonly prExternalId: string;
  readonly baseBranchName: string;
  readonly headBranchName: string;
  // Empty until a preview seeds the eligible-strategy selector with the preview's default (AC2).
  readonly mergeStrategy: string;
  readonly deleteBranchAfterMerge: boolean;
}

function initialForm(headBranchName: string | undefined): MergeForm {
  return {
    ownerAndRepo: "",
    prExternalId: "",
    baseBranchName: "",
    headBranchName: headBranchName ?? "",
    mergeStrategy: "",
    deleteBranchAfterMerge: false,
  };
}

// A stable key over the merge-TARGET fields (not the strategy or delete flag). A loaded preview is only
// valid for the exact target it was run against; changing any target field invalidates the gate so the
// stale preview can never enable a merge of a different, never-previewed target (AC1 — visible gate).
function targetKeyOf(form: MergeForm): string {
  return [form.ownerAndRepo, form.prExternalId, form.baseBranchName, form.headBranchName].join(" ");
}

function formToInput(form: MergeForm, projectId: string): GitDeliveryMergeInput {
  return {
    projectId,
    ownerAndRepo: form.ownerAndRepo,
    prExternalId: form.prExternalId,
    baseBranchName: form.baseBranchName,
    headBranchName: form.headBranchName,
    // The selector is only enabled once a preview has loaded an eligible value, so this is always a
    // member of the closed strategy set by the time execute is reachable.
    mergeStrategy: (form.mergeStrategy || "provider-default") as GitDeliveryMergeStrategy,
    deleteBranchAfterMerge: form.deleteBranchAfterMerge,
  };
}

// ─── Async actions hook (seq-guarded; surfaces preview / outcome / error / disabled) ────────────────

interface MergeAsyncState {
  readonly preview: GitDeliveryMergePreviewResponse | null;
  readonly outcome: GitDeliveryMergeExecuteResponse | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly disabled: boolean;
}

interface MergeAsync extends MergeAsyncState {
  readonly runPreview: (
    input: GitDeliveryMergeInput,
  ) => Promise<GitDeliveryMergePreviewResponse | null>;
  readonly runExecute: (input: GitDeliveryMergeInput) => void;
}

function useGovernedMergeActions(client: GovernedMergeClient): MergeAsync {
  const [state, setState] = useState<MergeAsyncState>({
    preview: null,
    outcome: null,
    error: null,
    busy: false,
    disabled: false,
  });
  const seq = useRef(0);

  const handleError = useCallback((err: unknown, token: number): void => {
    if (token !== seq.current) return;
    setState((s) => ({
      ...s,
      busy: false,
      disabled: isDisabledError(err),
      error: formatError(err),
    }));
  }, []);

  const runPreview = useCallback(
    async (input: GitDeliveryMergeInput): Promise<GitDeliveryMergePreviewResponse | null> => {
      const token = (seq.current += 1);
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        const preview = await client.mergePreview(input);
        if (token !== seq.current) return null;
        setState((s) => ({ ...s, busy: false, preview, disabled: false }));
        return preview;
      } catch (err) {
        handleError(err, token);
        return null;
      }
    },
    [client, handleError],
  );

  const runExecute = useCallback(
    (input: GitDeliveryMergeInput): void => {
      const token = (seq.current += 1);
      setState((s) => ({ ...s, busy: true, error: null, outcome: null }));
      void client
        .mergeExecute(input)
        .then((outcome) => {
          if (token !== seq.current) return;
          setState((s) => ({ ...s, busy: false, outcome, disabled: false }));
        })
        .catch((err: unknown) => {
          handleError(err, token);
        });
    },
    [client, handleError],
  );

  return { ...state, runPreview, runExecute };
}

// ─── Merge target editor section ─────────────────────────────────────────────────────────────────

interface FieldsProps {
  readonly form: MergeForm;
  readonly busy: boolean;
  readonly onChange: <K extends keyof MergeForm>(key: K, value: MergeForm[K]) => void;
}

function MergeTargetFields({ form, busy, onChange }: FieldsProps): ReactNode {
  return (
    <section style={SECTION_STYLE} aria-label="Merge target">
      <h3 style={HEADING_STYLE}>
        <Icons.git size={12} /> Merge target
      </h3>
      <div style={ROW_STYLE}>
        <label style={{ ...LABEL_STYLE, flex: 1 }}>
          Repository (owner/repo)
          <input
            style={FIELD_STYLE}
            value={form.ownerAndRepo}
            disabled={busy}
            onChange={(e) => onChange("ownerAndRepo", e.target.value)}
            aria-label="Repository owner and name"
          />
        </label>
        <label style={{ ...LABEL_STYLE, flex: 1 }}>
          Pull request number
          <input
            style={FIELD_STYLE}
            value={form.prExternalId}
            disabled={busy}
            onChange={(e) => onChange("prExternalId", e.target.value)}
            aria-label="Pull request number"
            inputMode="numeric"
          />
        </label>
      </div>
      <div style={ROW_STYLE}>
        <label style={{ ...LABEL_STYLE, flex: 1 }}>
          Base branch
          <input
            style={FIELD_STYLE}
            value={form.baseBranchName}
            disabled={busy}
            onChange={(e) => onChange("baseBranchName", e.target.value)}
            aria-label="Base branch"
          />
        </label>
        <label style={{ ...LABEL_STYLE, flex: 1 }}>
          Head branch
          <input
            style={FIELD_STYLE}
            value={form.headBranchName}
            disabled={busy}
            onChange={(e) => onChange("headBranchName", e.target.value)}
            aria-label="Head branch"
          />
        </label>
      </div>
    </section>
  );
}

// ─── Strategy selector (populated from preview.eligibleStrategies — no hard-coded default; AC2) ──────

function StrategySelector({
  form,
  preview,
  busy,
  onChange,
}: {
  readonly form: MergeForm;
  readonly preview: GitDeliveryMergePreviewResponse | null;
  readonly busy: boolean;
  readonly onChange: <K extends keyof MergeForm>(key: K, value: MergeForm[K]) => void;
}): ReactNode {
  const eligible = preview?.eligibleStrategies ?? [];
  const requestedIneligible = preview !== null && !preview.requestedStrategyEligible;
  return (
    <section style={SECTION_STYLE} aria-label="Merge strategy">
      <h3 style={HEADING_STYLE}>
        <Icons.git size={12} /> Strategy
      </h3>
      <label style={LABEL_STYLE}>
        Merge strategy
        <select
          style={FIELD_STYLE}
          value={form.mergeStrategy}
          disabled={busy || eligible.length === 0}
          onChange={(e) => onChange("mergeStrategy", e.target.value)}
          aria-label="Merge strategy"
          data-testid="gm-strategy"
        >
          {eligible.length === 0 ? (
            <option value="">Run preview to load eligible strategies</option>
          ) : (
            eligible.map((strategy) => (
              <option key={strategy} value={strategy}>
                {strategyLabel(strategy)}
              </option>
            ))
          )}
        </select>
      </label>
      {requestedIneligible ? (
        <p style={KV_LABEL} role="note" data-field="strategy-ineligible">
          The requested strategy “{strategyLabel(preview.requestedStrategy)}” is not eligible.
          {preview.selectedDefaultStrategy !== undefined
            ? ` Defaulting to “${strategyLabel(preview.selectedDefaultStrategy)}”.`
            : ""}
        </p>
      ) : null}
      <label style={{ ...LABEL_STYLE, flexDirection: "row", alignItems: "center" }}>
        <input
          type="checkbox"
          checked={form.deleteBranchAfterMerge}
          disabled={busy}
          onChange={(e) => onChange("deleteBranchAfterMerge", e.target.checked)}
          aria-label="Delete head branch after merge"
        />
        Delete head branch after merge
      </label>
    </section>
  );
}

// ─── Readiness + recommendation + policy panel (pure projection) ─────────────────────────────────────

function MergeReadinessPanel({
  preview,
}: {
  readonly preview: GitDeliveryMergePreviewResponse;
}): ReactNode {
  return (
    <section
      style={SECTION_STYLE}
      aria-label="Readiness"
      aria-live="polite"
      data-testid="gm-readiness"
    >
      <h3 style={HEADING_STYLE}>
        <Icons.info size={12} /> Readiness
      </h3>
      <p style={KV_LABEL} data-field="mergeable">
        Mergeable: {preview.readiness.mergeable ? "yes" : "no"}
      </p>
      <p style={KV_LABEL} data-field="recommendation">
        Recommendation: {preview.recommendation}
      </p>
      <p style={KV_LABEL} data-field="policy">
        Policy: {preview.policyOutcome}
        {preview.policyBlockReason !== undefined ? ` (${preview.policyBlockReason})` : ""}
      </p>
      <p style={KV_LABEL} data-field="risk">
        Risk: {preview.riskClass} (severity {preview.riskSeverity})
      </p>
      <p style={KV_LABEL} data-field="approval">
        Final approval required: {preview.requiresApproval ? "yes" : "no"}
      </p>
      {preview.readiness.blockers.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: "var(--space-4)", font: "var(--text-caption)" }}>
          {preview.readiness.blockers.map((blocker) => (
            <li key={blocker.code} style={{ color: "var(--fg-muted)" }} data-blocker={blocker.code}>
              blocker: {blocker.code} ({blocker.remediation})
              {blocker.actionHint !== undefined ? ` → ${blocker.actionHint}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ─── Final high-risk approval affordance (gates the local UI; server still enforces the token) ───────

function MergeApprovalGate({
  confirmed,
  busy,
  onChange,
}: {
  readonly confirmed: boolean;
  readonly busy: boolean;
  readonly onChange: (next: boolean) => void;
}): ReactNode {
  return (
    <section
      style={SECTION_STYLE}
      aria-label="High-risk merge confirmation"
      data-testid="gm-approval"
    >
      <h3 style={HEADING_STYLE}>
        <Icons.info size={12} /> High-risk confirmation
      </h3>
      <p style={KV_LABEL}>
        This merge is policy-gated as high risk. Confirm explicitly before merging; the server still
        enforces the approval token.
      </p>
      <label style={{ ...LABEL_STYLE, flexDirection: "row", alignItems: "center" }}>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(e) => onChange(e.target.checked)}
          aria-label="I confirm this high-risk merge"
        />
        I confirm this high-risk merge
      </label>
    </section>
  );
}

// ─── Outcome banner (text + icon; never colour alone) ──────────────────────────────────────────────

function outcomeCodes(outcome: GitDeliveryMergeExecuteResponse): readonly string[] {
  return [
    ...(outcome.merged !== undefined ? [`merged: ${outcome.merged ? "yes" : "no"}`] : []),
    ...(outcome.branchDeleted !== undefined
      ? [`branch deleted: ${outcome.branchDeleted ? "yes" : "no"}`]
      : []),
    ...(outcome.blockReason !== undefined ? [`reason: ${outcome.blockReason}`] : []),
    ...(outcome.mergeable !== undefined ? [`mergeable: ${outcome.mergeable ? "yes" : "no"}`] : []),
    ...(outcome.readinessBlockers ?? []).map(
      (b) => `blocker: ${b.code}${b.actionHint !== undefined ? ` → ${b.actionHint}` : ""}`,
    ),
    ...(outcome.preflightFindingCodes ?? []).map((c) => `preflight: ${c}`),
    ...(outcome.requiredApprovers ?? []).map((a) => `approver: ${a}`),
    ...(outcome.mergeRejectionReason !== undefined
      ? [`rejected: ${outcome.mergeRejectionReason}`]
      : []),
    ...(outcome.recoveryDisposition !== undefined
      ? [`recover: ${outcome.recoveryDisposition}`]
      : []),
    ...(outcome.recoveryActionHint !== undefined ? [`hint: ${outcome.recoveryActionHint}`] : []),
    ...(outcome.executionErrorCode !== undefined ? [`error: ${outcome.executionErrorCode}`] : []),
  ];
}

function MergeOutcome({
  outcome,
  error,
}: {
  readonly outcome: GitDeliveryMergeExecuteResponse | null;
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
  const codes = outcomeCodes(outcome);
  return (
    <div
      data-testid="gm-outcome"
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
    >
      <p style={{ font: "var(--text-body-sm)", color: "var(--text-body)", margin: 0 }}>
        <Icons.check size={12} /> {outcome.actionKind}: {outcome.status}
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

// ─── Card body ─────────────────────────────────────────────────────────────────────────────────────

function liveTextFor(async: MergeAsync): string {
  if (async.error !== null) return `Merge action failed: ${async.error}`;
  if (async.outcome !== null) return `Merge ${async.outcome.status}.`;
  if (async.preview !== null)
    return `Preview ready. Recommendation: ${async.preview.recommendation}.`;
  return "";
}

function GovernedMergeBody({
  client,
  projectId,
  headBranchName,
  titleId,
  liveId,
}: {
  readonly client: GovernedMergeClient;
  readonly projectId: string;
  readonly headBranchName: string | undefined;
  readonly titleId: string;
  readonly liveId: string;
}): ReactNode {
  const [form, setForm] = useState<MergeForm>(() => initialForm(headBranchName));
  const [confirmed, setConfirmed] = useState(false);
  // The merge-target key the loaded preview is valid for. Empty until a preview loads.
  const [previewedKey, setPreviewedKey] = useState("");
  const async = useGovernedMergeActions(client);
  const onChange = useCallback(<K extends keyof MergeForm>(key: K, value: MergeForm[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const onPreview = useCallback((): void => {
    const previewedTarget = targetKeyOf(form);
    void async.runPreview(formToInput(form, projectId)).then((preview) => {
      if (preview === null) return;
      // Default the selection to the preview's chosen default strategy (AC2 — never a hard-coded UI
      // default). When the preview offers no default, fall back to the first eligible value.
      const next = preview.selectedDefaultStrategy ?? preview.eligibleStrategies[0] ?? "";
      setForm((f) => ({ ...f, mergeStrategy: next }));
      // This preview is valid only for the target it was run against; a later target edit re-gates.
      setPreviewedKey(previewedTarget);
      // A fresh preview re-arms the high-risk confirmation.
      setConfirmed(false);
    });
  }, [async, form, projectId]);

  const onExecute = useCallback((): void => {
    async.runExecute(formToInput(form, projectId));
  }, [async, form, projectId]);

  if (async.disabled) {
    return (
      <div
        data-testid="gm-disabled"
        style={{ padding: "var(--space-4)", color: "var(--fg-muted)", font: "var(--text-body-sm)" }}
      >
        <p>
          <Icons.info size={13} /> Governed merge delivery is not enabled for this deployment.
        </p>
      </div>
    );
  }

  // Preview needs the full target; execute additionally requires a loaded preview, a chosen strategy, a
  // mergeable PR, and — when the policy gates approval — the explicit high-risk confirmation.
  const canPreview =
    form.ownerAndRepo !== "" &&
    form.prExternalId !== "" &&
    form.baseBranchName !== "" &&
    form.headBranchName !== "";
  const preview = async.preview;
  const requiresApproval = preview?.requiresApproval ?? false;
  const mergeable = preview?.readiness.mergeable ?? false;
  // The loaded preview must be for the CURRENT target — editing a target field after a preview re-gates
  // the merge until a fresh preview confirms the new target's readiness/approval (AC1).
  const previewMatchesTarget = preview !== null && previewedKey === targetKeyOf(form);
  const canExecute =
    canPreview &&
    previewMatchesTarget &&
    form.mergeStrategy !== "" &&
    mergeable &&
    (!requiresApproval || confirmed);
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
        <Icons.git size={14} /> Merge command center
      </h2>
      <p
        id={liveId}
        data-testid="gm-live"
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
        {liveTextFor(async)}
      </p>
      <MergeTargetFields form={form} busy={async.busy} onChange={onChange} />
      <StrategySelector form={form} preview={preview} busy={async.busy} onChange={onChange} />
      {preview !== null ? <MergeReadinessPanel preview={preview} /> : null}
      {requiresApproval ? (
        <MergeApprovalGate confirmed={confirmed} busy={async.busy} onChange={setConfirmed} />
      ) : null}
      <div style={ROW_STYLE}>
        <button
          type="button"
          style={GHOST_BTN}
          disabled={async.busy || !canPreview}
          onClick={onPreview}
        >
          Preview
        </button>
        <button
          type="button"
          style={PRIMARY_BTN}
          disabled={async.busy || !canExecute}
          onClick={onExecute}
          data-testid="gm-submit"
        >
          Merge pull request
        </button>
      </div>
      <MergeOutcome outcome={async.outcome} error={async.error} />
    </div>
  );
}

export interface GovernedMergeCardProps {
  /** The active project workspace root (acts as projectId). When absent, an empty state renders. */
  readonly projectId?: string | undefined;
  /** The head branch under review, carried from the governed Git flow Pull Request section. */
  readonly headBranchName?: string | undefined;
  /** DI seam; defaults to the real BFF client. */
  readonly client?: GovernedMergeClient;
}

export function GovernedMergeCard({
  projectId,
  headBranchName,
  client = DEFAULT_CLIENT,
}: GovernedMergeCardProps): ReactNode {
  const titleId = useId();
  const liveId = useId();
  if (projectId === undefined || projectId === "") {
    return (
      <div
        data-testid="gm-empty"
        style={{ padding: "var(--space-4)", color: "var(--fg-muted)", font: "var(--text-body-sm)" }}
      >
        <p>
          <Icons.git size={13} /> Select a project to open a governed merge.
        </p>
      </div>
    );
  }
  return (
    <GovernedMergeBody
      client={client}
      projectId={projectId}
      headBranchName={headBranchName}
      titleId={titleId}
      liveId={liveId}
    />
  );
}
