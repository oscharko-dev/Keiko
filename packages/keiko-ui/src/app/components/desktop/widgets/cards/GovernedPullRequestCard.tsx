"use client";

// Governed GitHub pull request command center (Issue #477, Epic #470, ADR-0064). A per-project card,
// launched from the Publish section of the governed Git flow, that turns a published branch into a
// review-ready GitHub pull request through the governed PR gateway exposed by the BFF.
//
// It surfaces a deterministic, USER-EDITABLE metadata draft (title / body / risk narrative synthesized
// from the actual branch + risk context), a readiness summary that distinguishes "remote PR object
// exists" from "ready for review", the draft-vs-ready recommendation, reviewer/label/linkage
// suggestions, and the policy decision — then opens or updates the PR. Provider failures are normalized
// into typed blocked / error states. Outcome is conveyed by TEXT + icon, never colour alone (WCAG 2.2
// AA). Styling uses inline styles backed by existing CSS custom properties so globals.css is untouched
// (ADR-0051 gate).

import { useCallback, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  ApiError,
  fetchGitDeliveryPrExecute,
  fetchGitDeliveryPrPreview,
  type GitDeliveryPrExecuteResponse,
  type GitDeliveryPrInput,
  type GitDeliveryPrKind,
  type GitDeliveryPrPreviewResponse,
} from "@/lib/api";
import { Icons } from "../../Icons";

// ─── Injected client (DI seam for tests) ────────────────────────────────────────────────────────

export interface GovernedPullRequestClient {
  readonly prPreview: typeof fetchGitDeliveryPrPreview;
  readonly prExecute: typeof fetchGitDeliveryPrExecute;
}

const DEFAULT_CLIENT: GovernedPullRequestClient = {
  prPreview: fetchGitDeliveryPrPreview,
  prExecute: fetchGitDeliveryPrExecute,
};

const DISABLED_CODE = "GIT_DELIVERY_PR_DISABLED";

function isDisabledError(err: unknown): boolean {
  return err instanceof ApiError && err.code === DISABLED_CODE;
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
const KV_LABEL: CSSProperties = {
  font: "var(--text-caption)",
  color: "var(--fg-muted)",
  margin: 0,
};

// ─── Form state ───────────────────────────────────────────────────────────────────────────────────

interface PrForm {
  readonly kind: GitDeliveryPrKind;
  readonly ownerAndRepo: string;
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly title: string;
  readonly body: string;
  readonly isDraft: boolean;
  readonly prExternalId: string;
  readonly draftTransition: "none" | "to-ready" | "to-draft";
}

function initialForm(headBranchName: string | undefined): PrForm {
  return {
    kind: "pr-create",
    ownerAndRepo: "",
    headBranchName: headBranchName ?? "",
    baseBranchName: "",
    title: "",
    body: "",
    isDraft: false,
    prExternalId: "",
    draftTransition: "none",
  };
}

function formToInput(form: PrForm, projectId: string): GitDeliveryPrInput {
  const shared = {
    projectId,
    ownerAndRepo: form.ownerAndRepo,
    headBranchName: form.headBranchName,
    baseBranchName: form.baseBranchName,
    title: form.title,
    body: form.body,
  };
  if (form.kind === "pr-create") {
    return { ...shared, kind: "pr-create", isDraft: form.isDraft };
  }
  return {
    ...shared,
    kind: "pr-update",
    prExternalId: form.prExternalId,
    convertToDraft: form.draftTransition === "to-draft",
    convertFromDraft: form.draftTransition === "to-ready",
  };
}

// ─── Async actions hook (seq-guarded; surfaces preview / outcome / error / disabled) ────────────────

interface PrAsyncState {
  readonly preview: GitDeliveryPrPreviewResponse | null;
  readonly outcome: GitDeliveryPrExecuteResponse | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly disabled: boolean;
}

interface PrAsync extends PrAsyncState {
  readonly runPreview: (input: GitDeliveryPrInput) => Promise<GitDeliveryPrPreviewResponse | null>;
  readonly runExecute: (input: GitDeliveryPrInput) => void;
}

function useGovernedPrActions(client: GovernedPullRequestClient): PrAsync {
  const [state, setState] = useState<PrAsyncState>({
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
    async (input: GitDeliveryPrInput): Promise<GitDeliveryPrPreviewResponse | null> => {
      const token = (seq.current += 1);
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        const preview = await client.prPreview(input);
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
    (input: GitDeliveryPrInput): void => {
      const token = (seq.current += 1);
      setState((s) => ({ ...s, busy: true, error: null, outcome: null }));
      void client
        .prExecute(input)
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

// ─── Metadata editor section ────────────────────────────────────────────────────────────────────

interface FieldsProps {
  readonly form: PrForm;
  readonly busy: boolean;
  readonly onChange: <K extends keyof PrForm>(key: K, value: PrForm[K]) => void;
}

function PrTargetFields({ form, busy, onChange }: FieldsProps): ReactNode {
  return (
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
        Base branch
        <input
          style={FIELD_STYLE}
          value={form.baseBranchName}
          disabled={busy}
          onChange={(e) => onChange("baseBranchName", e.target.value)}
          aria-label="Base branch"
        />
      </label>
    </div>
  );
}

function PrMetadataFields({ form, busy, onChange }: FieldsProps): ReactNode {
  return (
    <section style={SECTION_STYLE} aria-label="Pull request metadata">
      <h3 style={HEADING_STYLE}>
        <Icons.git size={12} /> Metadata
      </h3>
      <label style={LABEL_STYLE}>
        Head branch
        <input
          style={FIELD_STYLE}
          value={form.headBranchName}
          disabled={busy}
          onChange={(e) => onChange("headBranchName", e.target.value)}
          aria-label="Head branch"
        />
      </label>
      <PrTargetFields form={form} busy={busy} onChange={onChange} />
      <label style={LABEL_STYLE}>
        Title
        <input
          style={FIELD_STYLE}
          value={form.title}
          disabled={busy}
          onChange={(e) => onChange("title", e.target.value)}
          aria-label="Pull request title"
        />
      </label>
      <label style={LABEL_STYLE}>
        Body
        <textarea
          style={{ ...FIELD_STYLE, minHeight: 100, resize: "vertical" }}
          value={form.body}
          disabled={busy}
          onChange={(e) => onChange("body", e.target.value)}
          aria-label="Pull request body"
        />
      </label>
      <label style={{ ...LABEL_STYLE, flexDirection: "row", alignItems: "center" }}>
        <input
          type="checkbox"
          checked={form.kind === "pr-create" ? form.isDraft : false}
          disabled={busy || form.kind !== "pr-create"}
          onChange={(e) => onChange("isDraft", e.target.checked)}
          aria-label="Open as draft"
        />
        Open as draft
      </label>
    </section>
  );
}

// ─── Readiness + recommendation + suggestions panel (pure projection) ───────────────────────────────

function PrReadinessPanel({
  preview,
}: {
  readonly preview: GitDeliveryPrPreviewResponse;
}): ReactNode {
  return (
    <section style={SECTION_STYLE} aria-label="Readiness" data-testid="gpr-readiness">
      <h3 style={HEADING_STYLE}>
        <Icons.info size={12} /> Readiness
      </h3>
      <p style={KV_LABEL} data-field="objectExists">
        Remote PR object: {preview.readiness.objectExists ? "exists" : "not created yet"}
      </p>
      <p style={KV_LABEL} data-field="reviewReady">
        Ready for review: {preview.readiness.reviewReady ? "yes" : "no"}
      </p>
      <p style={KV_LABEL} data-field="recommendation">
        Recommendation: {preview.recommendation}
      </p>
      <p style={KV_LABEL} data-field="policy">
        Policy: {preview.policyOutcome}
        {preview.policyBlockReason !== undefined ? ` (${preview.policyBlockReason})` : ""}
      </p>
      <p style={KV_LABEL} data-field="risk">
        Risk: {preview.riskClass} — {preview.riskNarrative}
      </p>
      {preview.readiness.blockerCodes.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: "var(--space-4)", font: "var(--text-caption)" }}>
          {preview.readiness.blockerCodes.map((code) => (
            <li key={code} style={{ color: "var(--fg-muted)" }} data-blocker={code}>
              blocker: {code}
            </li>
          ))}
        </ul>
      ) : null}
      {preview.suggestedLabels.length > 0 ? (
        <p style={KV_LABEL} data-field="labels">
          Suggested labels: {preview.suggestedLabels.join(", ")}
        </p>
      ) : null}
      {preview.suggestedIssueRefs.length > 0 ? (
        <p style={KV_LABEL} data-field="linkage">
          Linked issues: {preview.suggestedIssueRefs.join(", ")}
        </p>
      ) : null}
    </section>
  );
}

// ─── Outcome banner (text + icon; never colour alone) ──────────────────────────────────────────────

function outcomeCodes(outcome: GitDeliveryPrExecuteResponse): readonly string[] {
  return [
    ...(outcome.createdPrExternalId !== undefined ? [`pr: #${outcome.createdPrExternalId}`] : []),
    ...(outcome.blockReason !== undefined ? [`reason: ${outcome.blockReason}`] : []),
    ...(outcome.preflightFindingCodes ?? []).map((c) => `preflight: ${c}`),
    ...(outcome.requiredApprovers ?? []).map((a) => `approver: ${a}`),
    ...(outcome.prRejectionReason !== undefined ? [`rejected: ${outcome.prRejectionReason}`] : []),
    ...(outcome.recoveryDisposition !== undefined
      ? [`recover: ${outcome.recoveryDisposition}`]
      : []),
    ...(outcome.recoveryActionHint !== undefined ? [`hint: ${outcome.recoveryActionHint}`] : []),
    ...(outcome.executionErrorCode !== undefined ? [`error: ${outcome.executionErrorCode}`] : []),
  ];
}

function PrOutcome({
  outcome,
  error,
}: {
  readonly outcome: GitDeliveryPrExecuteResponse | null;
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
      data-testid="gpr-outcome"
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

function liveTextFor(async: PrAsync): string {
  if (async.error !== null) return `Pull request action failed: ${async.error}`;
  if (async.outcome !== null) return `Pull request ${async.outcome.status}.`;
  if (async.preview !== null)
    return `Preview ready. Recommendation: ${async.preview.recommendation}.`;
  return "";
}

function GovernedPullRequestBody({
  client,
  projectId,
  headBranchName,
  titleId,
  liveId,
}: {
  readonly client: GovernedPullRequestClient;
  readonly projectId: string;
  readonly headBranchName: string | undefined;
  readonly titleId: string;
  readonly liveId: string;
}): ReactNode {
  const [form, setForm] = useState<PrForm>(() => initialForm(headBranchName));
  const async = useGovernedPrActions(client);
  const onChange = useCallback(<K extends keyof PrForm>(key: K, value: PrForm[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const onPreview = useCallback((): void => {
    void async.runPreview(formToInput(form, projectId)).then((preview) => {
      if (preview === null) return;
      // Seed the editable fields from the synthesized draft when the user has not authored them yet.
      setForm((f) => ({
        ...f,
        title: f.title === "" ? preview.composedTitle : f.title,
        body: f.body === "" ? preview.composedBody : f.body,
      }));
    });
  }, [async, form, projectId]);

  const onExecute = useCallback((): void => {
    async.runExecute(formToInput(form, projectId));
  }, [async, form, projectId]);

  if (async.disabled) {
    return (
      <div
        data-testid="gpr-disabled"
        style={{ padding: "var(--space-4)", color: "var(--fg-muted)", font: "var(--text-body-sm)" }}
      >
        <p>
          <Icons.info size={13} /> Governed pull request delivery is not enabled for this
          deployment.
        </p>
      </div>
    );
  }

  // Preview only needs the targets (it SYNTHESIZES a title/body suggestion); execute also needs a title.
  const canPreview =
    form.ownerAndRepo !== "" && form.headBranchName !== "" && form.baseBranchName !== "";
  const canExecute = canPreview && form.title !== "";
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
        <Icons.git size={14} /> Pull request command center
      </h2>
      <p
        id={liveId}
        data-testid="gpr-live"
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
      <PrMetadataFields form={form} busy={async.busy} onChange={onChange} />
      {async.preview !== null ? <PrReadinessPanel preview={async.preview} /> : null}
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
          data-testid="gpr-submit"
        >
          {form.kind === "pr-create" ? "Open pull request" : "Update pull request"}
        </button>
      </div>
      <PrOutcome outcome={async.outcome} error={async.error} />
    </div>
  );
}

export interface GovernedPullRequestCardProps {
  /** The active project workspace root (acts as projectId). When absent, an empty state renders. */
  readonly projectId?: string | undefined;
  /** The published head branch, passed from the governed Git flow Publish section. */
  readonly headBranchName?: string | undefined;
  /** DI seam; defaults to the real BFF client. */
  readonly client?: GovernedPullRequestClient;
}

export function GovernedPullRequestCard({
  projectId,
  headBranchName,
  client = DEFAULT_CLIENT,
}: GovernedPullRequestCardProps): ReactNode {
  const titleId = useId();
  const liveId = useId();
  if (projectId === undefined || projectId === "") {
    return (
      <div
        data-testid="gpr-empty"
        style={{ padding: "var(--space-4)", color: "var(--fg-muted)", font: "var(--text-body-sm)" }}
      >
        <p>
          <Icons.git size={13} /> Select a project to open a governed pull request.
        </p>
      </div>
    );
  }
  return (
    <GovernedPullRequestBody
      client={client}
      projectId={projectId}
      headBranchName={headBranchName}
      titleId={titleId}
      liveId={liveId}
    />
  );
}
