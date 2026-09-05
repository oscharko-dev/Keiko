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
  fetchGitDeliveryPrApprove,
  fetchGitDeliveryPrExecute,
  fetchGitDeliveryPrPreview,
  fetchGitDeliveryPrDescriptionApply,
  fetchGitDeliveryPrDescriptionApprove,
  fetchGitDeliveryPrDescriptionPreview,
  PR_DESCRIPTION_LANGUAGES,
  type GitDeliveryPrDescriptionPreviewInput,
  type GitDeliveryPrDescriptionTarget,
  type GitDeliveryPrExecuteResponse,
  type GitDeliveryPrInput,
  type GitDeliveryPrKind,
  type GitDeliveryPrPreviewResponse,
  type PrDescriptionApplicationResultWire,
  type PrDescriptionApplicationStatus,
  type PrDescriptionLanguage,
} from "@/lib/api";
import { Icons } from "../../Icons";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const GitIcon = Icons.git;
const InfoIcon = Icons.info;
const CheckIcon = Icons.check;

// ─── Injected client (DI seam for tests) ────────────────────────────────────────────────────────

export interface GovernedPullRequestClient {
  readonly prPreview: typeof fetchGitDeliveryPrPreview;
  // #3387: the create/update mutation now requires an actually consumed, server-issued approval
  // claim unconditionally (epic #3384 correction 5) — never mode-denied merely because the mode is
  // lower. `runExecute` mints it from the identical command and attaches it before calling execute.
  // Optional so an existing injected client that has not yet added it (e.g. a shared multi-card
  // seam) degrades to the pre-#3387 unapproved call instead of a hard TypeScript break; the real
  // BFF route already rejects that unapproved call, so the caller sees "approval-required", never a
  // silently accepted mutation.
  readonly prApprove?: typeof fetchGitDeliveryPrApprove | undefined;
  readonly prExecute: typeof fetchGitDeliveryPrExecute;
  // #3399: the governed PR-description preview -> approve -> apply lifecycle. Optional for the same
  // reason as `prApprove` above — the panel renders nothing when a caller's client omits any of them.
  readonly prDescriptionPreview?: typeof fetchGitDeliveryPrDescriptionPreview | undefined;
  readonly prDescriptionApprove?: typeof fetchGitDeliveryPrDescriptionApprove | undefined;
  readonly prDescriptionApply?: typeof fetchGitDeliveryPrDescriptionApply | undefined;
}

const DEFAULT_CLIENT: GovernedPullRequestClient = {
  prPreview: fetchGitDeliveryPrPreview,
  prApprove: fetchGitDeliveryPrApprove,
  prExecute: fetchGitDeliveryPrExecute,
  prDescriptionPreview: fetchGitDeliveryPrDescriptionPreview,
  prDescriptionApprove: fetchGitDeliveryPrDescriptionApprove,
  prDescriptionApply: fetchGitDeliveryPrDescriptionApply,
};

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
  borderRadius: "var(--radius-surface)",
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

// #3389 (epic #3384 correction 1): "to-ready" (mark ready) is deliberately NOT a member of this
// union. The draft->ready transition now requires the dedicated pr-mark-ready one-use approval,
// bound to base/head SHAs and a readiness digest this generic command-center card never resolves —
// it is offered only from the Coding Workbench's journey outcome, where those facts are already on
// hand from the journey read. "to-draft" (ready->draft) is unaffected; it stays a plain pr-update.
interface PrForm {
  readonly kind: GitDeliveryPrKind;
  readonly ownerAndRepo: string;
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly title: string;
  readonly body: string;
  readonly isDraft: boolean;
  readonly prExternalId: string;
  readonly draftTransition: "none" | "to-draft";
}

function initialForm({
  headBranchName,
  ownerAndRepo,
  baseBranchName,
}: {
  readonly headBranchName?: string | undefined;
  readonly ownerAndRepo?: string | undefined;
  readonly baseBranchName?: string | undefined;
}): PrForm {
  return {
    kind: "pr-create",
    ownerAndRepo: ownerAndRepo ?? "",
    headBranchName: headBranchName ?? "",
    baseBranchName: baseBranchName ?? "",
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
    convertFromDraft: false,
  };
}

// A stable key over the PR-TARGET fields (not title/body, which the preview itself seeds). A
// loaded preview or finished outcome is only meaningful for the exact target it ran against;
// changing the action kind or any target field hides it, so a stale readiness panel or success
// banner can never describe a different, never-executed target (mirrors the merge card's gate).
function prTargetKeyOf(form: PrForm): string {
  return [
    form.kind,
    form.ownerAndRepo,
    form.headBranchName,
    form.baseBranchName,
    form.kind === "pr-update" ? form.prExternalId : "",
  ].join(" ");
}

// GitHub PR numbers are decimal digits; anything else can never resolve and only surfaces as an
// opaque provider error after the round-trip — reject it before the request leaves the card.
function isValidPrNumber(value: string): boolean {
  return /^\d+$/u.test(value);
}

// ─── Async actions hook (seq-guarded; surfaces preview / outcome / error) ───────────────────────────

interface PrAsyncState {
  readonly preview: GitDeliveryPrPreviewResponse | null;
  readonly outcome: GitDeliveryPrExecuteResponse | null;
  readonly error: string | null;
  readonly busy: boolean;
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
  });
  const seq = useRef(0);

  const handleError = useCallback((err: unknown, token: number): void => {
    if (token !== seq.current) return;
    setState((s) => ({
      ...s,
      busy: false,
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
        setState((s) => ({ ...s, busy: false, preview }));
        return preview;
      } catch (err) {
        handleError(err, token);
        return null;
      }
    },
    [client, handleError],
  );

  // #3387: mints the approval the create/update mutation now requires unconditionally FIRST, from
  // the EXACT SAME input, then attaches the returned claim to the identical input before execute —
  // the mint route binds to that exact typed command, so the claim it returns is redeemable only
  // for this same target/title/body combination (mirrors GovernedMergeCard's runExecute).
  const runExecute = useCallback(
    (input: GitDeliveryPrInput): void => {
      const token = (seq.current += 1);
      setState((s) => ({ ...s, busy: true, error: null, outcome: null }));
      const prApprove = client.prApprove;
      const readyToExecute: Promise<GitDeliveryPrInput> =
        prApprove === undefined
          ? Promise.resolve(input)
          : prApprove(input).then(
              (approved): GitDeliveryPrInput => ({ ...input, approval: approved.approval }),
            );
      void readyToExecute
        .then((executeInput) => client.prExecute(executeInput))
        .then((outcome) => {
          if (token !== seq.current) return;
          setState((s) => ({ ...s, busy: false, outcome }));
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
        Repository (owner/repo){" "}
        <input
          style={FIELD_STYLE}
          value={form.ownerAndRepo}
          disabled={busy}
          onChange={(e) => onChange("ownerAndRepo", e.target.value)}
        />
      </label>
      <label style={{ ...LABEL_STYLE, flex: 1 }}>
        Base branch{" "}
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
  const prNumberHintId = useId();
  const prIdInvalid =
    form.kind === "pr-update" && form.prExternalId !== "" && !isValidPrNumber(form.prExternalId);
  return (
    <section style={SECTION_STYLE} aria-label="Pull Request metadata">
      <h3 style={HEADING_STYLE}>
        <GitIcon size={12} /> Metadata
      </h3>
      <fieldset
        style={{
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-control)",
          padding: "var(--space-2)",
        }}
      >
        <legend style={KV_LABEL}>Action</legend>
        <div style={ROW_STYLE}>
          <label style={{ ...LABEL_STYLE, flexDirection: "row", alignItems: "center" }}>
            <input
              type="radio"
              name="pull-request-action"
              checked={form.kind === "pr-create"}
              disabled={busy}
              onChange={() => onChange("kind", "pr-create")}
            />{" "}
            Create
          </label>
          <label style={{ ...LABEL_STYLE, flexDirection: "row", alignItems: "center" }}>
            <input
              type="radio"
              name="pull-request-action"
              checked={form.kind === "pr-update"}
              disabled={busy}
              onChange={() => onChange("kind", "pr-update")}
            />{" "}
            Update
          </label>
        </div>
      </fieldset>
      {form.kind === "pr-update" ? (
        <div style={ROW_STYLE}>
          <label style={{ ...LABEL_STYLE, flex: 1 }}>
            Pull Request number{" "}
            <input
              style={FIELD_STYLE}
              inputMode="numeric"
              value={form.prExternalId}
              disabled={busy}
              onChange={(e) => onChange("prExternalId", e.target.value)}
              aria-label="Pull Request number"
              aria-invalid={prIdInvalid}
              aria-describedby={prIdInvalid ? prNumberHintId : undefined}
            />
            {prIdInvalid ? (
              <p
                id={prNumberHintId}
                data-testid="gpr-pr-number-hint"
                style={{ font: "var(--text-caption)", color: "var(--feedback-danger)", margin: 0 }}
              >
                Enter the numeric Pull Request number, for example 1499.
              </p>
            ) : null}
          </label>
          <label style={{ ...LABEL_STYLE, flex: 1 }}>
            Draft state{" "}
            <select
              style={FIELD_STYLE}
              value={form.draftTransition}
              disabled={busy}
              onChange={(e) =>
                onChange("draftTransition", e.target.value as PrForm["draftTransition"])
              }
              aria-label="Draft state"
            >
              <option value="none">No change</option>
              <option value="to-draft">Convert to draft</option>
            </select>
            <span
              style={{ font: "var(--text-caption)", color: "var(--fg-muted)" }}
              data-testid="gpr-mark-ready-hint"
            >
              To mark this pull request ready for review, use Propose ready on the Coding Workbench
              journey outcome — it binds the exact revision and re-verifies it before executing.
            </span>
          </label>
        </div>
      ) : null}
      <label style={LABEL_STYLE}>
        Head branch{" "}
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
        Title{" "}
        <input
          style={FIELD_STYLE}
          value={form.title}
          disabled={busy}
          onChange={(e) => onChange("title", e.target.value)}
          aria-label="Pull Request title"
        />
      </label>
      <label style={LABEL_STYLE}>
        Body{" "}
        <textarea
          style={{ ...FIELD_STYLE, minHeight: 100, resize: "vertical" }}
          value={form.body}
          disabled={busy}
          onChange={(e) => onChange("body", e.target.value)}
          aria-label="Pull Request body"
        />
      </label>
      <label style={{ ...LABEL_STYLE, flexDirection: "row", alignItems: "center" }}>
        <input
          type="checkbox"
          checked={form.kind === "pr-create" ? form.isDraft : false}
          disabled={busy || form.kind !== "pr-create"}
          onChange={(e) => onChange("isDraft", e.target.checked)}
          aria-label="Open as draft"
        />{" "}
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
        <InfoIcon size={12} /> Readiness
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
        <InfoIcon size={12} /> {error}
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
        <CheckIcon size={12} /> {outcome.actionKind}: {outcome.status}
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

// ─── PR-description application (#3399, epic #3384 correction 4/7/10/11) ────────────────────────────
//
// Preview -> approve -> apply for the reviewed Keiko-generated description. The server renders
// `finalBody`/`managedRegion` — repository template and human text preserved outside one versioned
// managed region, the "by Keiko" attribution added by trusted code after model validation — so this
// panel shows that text byte-for-byte and never composes or edits it. The approval is one-use: a
// successful (or failed) apply always clears the local proposal so a second Apply click can never
// replay a spent approval; the fields must be re-previewed to mint a new one.

interface DescriptionForm {
  readonly ownerAndRepo: string;
  readonly prNumber: string;
  readonly language: PrDescriptionLanguage;
  readonly refinement: string;
}

function initialDescriptionForm(ownerAndRepo: string | undefined): DescriptionForm {
  return { ownerAndRepo: ownerAndRepo ?? "", prNumber: "", language: "en", refinement: "" };
}

function isValidDescriptionPrNumber(value: string): boolean {
  return /^\d+$/u.test(value);
}

function descriptionTargetKeyOf(ownerAndRepo: string, prNumber: string): string {
  return `${ownerAndRepo} ${prNumber}`;
}

interface DescriptionAsyncState {
  readonly result: PrDescriptionApplicationResultWire | null;
  // The exact target the current result/proposal was produced for — never the live form fields,
  // so an approve/apply can never be sent for a PR the user has since retargeted (mirrors
  // GovernedPullRequestBody's previewedKey/targetKey gate for the create/update form above).
  readonly target: GitDeliveryPrDescriptionTarget | null;
  readonly proposalId: string | null;
  readonly approved: boolean;
  readonly error: string | null;
  readonly busy: boolean;
}

interface DescriptionAsync extends DescriptionAsyncState {
  readonly runPreview: (input: GitDeliveryPrDescriptionPreviewInput) => void;
  readonly runApprove: () => void;
  readonly runApply: () => void;
}

// The three description methods, narrowed to non-optional: `PrDescriptionPanel` builds this only
// once all three are present on the injected client, so the hook below never has to branch on a
// partially-populated client mid-lifecycle (preview present but approve missing, etc.).
interface RequiredPrDescriptionClient {
  readonly prDescriptionPreview: typeof fetchGitDeliveryPrDescriptionPreview;
  readonly prDescriptionApprove: typeof fetchGitDeliveryPrDescriptionApprove;
  readonly prDescriptionApply: typeof fetchGitDeliveryPrDescriptionApply;
}

function useGovernedPrDescriptionActions(
  client: RequiredPrDescriptionClient | undefined,
): DescriptionAsync {
  const [state, setState] = useState<DescriptionAsyncState>({
    result: null,
    target: null,
    proposalId: null,
    approved: false,
    error: null,
    busy: false,
  });
  const seq = useRef(0);

  const handleError = useCallback((err: unknown, token: number): void => {
    if (token !== seq.current) return;
    setState((s) => ({ ...s, busy: false, error: formatError(err) }));
  }, []);

  const runPreview = useCallback(
    (input: GitDeliveryPrDescriptionPreviewInput): void => {
      if (client === undefined) return;
      const token = (seq.current += 1);
      const target: GitDeliveryPrDescriptionTarget = {
        projectId: input.projectId,
        ownerAndRepo: input.ownerAndRepo,
        prNumber: input.prNumber,
      };
      setState((s) => ({ ...s, busy: true, error: null }));
      void client
        .prDescriptionPreview(input)
        .then((result) => {
          if (token !== seq.current) return;
          const proposalId = result.outcome === "preview" ? result.preview.proposalId : null;
          setState({ result, target, proposalId, approved: false, error: null, busy: false });
        })
        .catch((err: unknown) => handleError(err, token));
    },
    [client, handleError],
  );

  const runApprove = useCallback((): void => {
    if (client === undefined || state.proposalId === null || state.target === null) return;
    const token = (seq.current += 1);
    const { target, proposalId } = state;
    setState((s) => ({ ...s, busy: true, error: null }));
    void client
      .prDescriptionApprove({ ...target, proposalId })
      .then(() => {
        if (token !== seq.current) return;
        setState((s) => ({ ...s, busy: false, approved: true }));
      })
      .catch((err: unknown) => handleError(err, token));
  }, [client, handleError, state]);

  const runApply = useCallback((): void => {
    if (client === undefined || state.proposalId === null || state.target === null || !state.approved)
      return;
    const token = (seq.current += 1);
    const { target, proposalId } = state;
    setState((s) => ({ ...s, busy: true, error: null }));
    void client
      .prDescriptionApply({ ...target, proposalId })
      .then((result) => {
        if (token !== seq.current) return;
        // One-use: a spent approval never carries forward to a second apply of the same preview.
        setState({ result, target: null, proposalId: null, approved: false, error: null, busy: false });
      })
      .catch((err: unknown) => handleError(err, token));
  }, [client, handleError, state]);

  return { ...state, runPreview, runApprove, runApply };
}

function descriptionStateOf(
  result: PrDescriptionApplicationResultWire | null,
): PrDescriptionApplicationStatus["state"] | undefined {
  if (result === null) return undefined;
  if (result.outcome === "preview") return result.preview.status.state;
  if (result.outcome === "observed") return result.status.state;
  return "blocked";
}

function descriptionReasonOf(result: PrDescriptionApplicationResultWire | null): string | undefined {
  if (result === null) return undefined;
  if (result.outcome === "preview") return result.preview.status.reason;
  if (result.outcome === "observed") return result.status.reason;
  return result.reason;
}

// Text + icon only — never colour alone (WCAG 2.2 AA), matching PrOutcome above.
const DESCRIPTION_STATE_LABEL: Readonly<Record<PrDescriptionApplicationStatus["state"], string>> = {
  current: "Applied and confirmed",
  stale: "Stale — refresh the preview",
  partial: "Applied — partially generated",
  fallback: "Applied — generated without the model",
  blocked: "Blocked — not applied",
  failed: "Failed — not applied",
};

function PrDescriptionStatusBadge({
  result,
}: {
  readonly result: PrDescriptionApplicationResultWire | null;
}): ReactNode {
  const state = descriptionStateOf(result);
  if (state === undefined) return null;
  const reason = descriptionReasonOf(result);
  return (
    <p style={KV_LABEL} data-testid="gpr-description-state" data-state={state}>
      <InfoIcon size={12} /> {DESCRIPTION_STATE_LABEL[state]}
      {reason !== undefined ? ` (${reason})` : ""}
    </p>
  );
}

// Renders the server-rendered final body byte-for-byte: the repository template, human-authored
// text outside the managed region, and the trusted "by Keiko" attribution are composed server-side
// (epic #3384 Frozen Decisions 10/11) and must never be recomposed or re-derived in the browser.
function PrDescriptionPreviewBody({
  result,
}: {
  readonly result: PrDescriptionApplicationResultWire | null;
}): ReactNode {
  if (result === null || result.outcome !== "preview") return null;
  return (
    <div style={LABEL_STYLE}>
      <span>Preview — repository template and human text preserved outside the managed region</span>
      <pre
        data-testid="gpr-description-preview"
        style={{
          ...FIELD_STYLE,
          whiteSpace: "pre-wrap",
          maxHeight: 220,
          overflow: "auto",
          margin: 0,
        }}
      >
        {result.preview.finalBody}
      </pre>
      <span style={{ font: "var(--text-caption)", color: "var(--fg-muted)" }}>
        {result.preview.concurrencyLimitation}
      </span>
    </div>
  );
}

function PrDescriptionFields({
  form,
  busy,
  onChange,
}: {
  readonly form: DescriptionForm;
  readonly busy: boolean;
  readonly onChange: <K extends keyof DescriptionForm>(key: K, value: DescriptionForm[K]) => void;
}): ReactNode {
  const prNumberHintId = useId();
  const prNumberInvalid = form.prNumber !== "" && !isValidDescriptionPrNumber(form.prNumber);
  return (
    <div style={ROW_STYLE}>
      <label style={{ ...LABEL_STYLE, flex: 1 }}>
        Repository (owner/repo){" "}
        <input
          style={FIELD_STYLE}
          value={form.ownerAndRepo}
          disabled={busy}
          onChange={(e) => onChange("ownerAndRepo", e.target.value)}
          aria-label="Description repository (owner/repo)"
        />
      </label>
      <label style={{ ...LABEL_STYLE, flex: 1 }}>
        Pull Request number{" "}
        <input
          style={FIELD_STYLE}
          inputMode="numeric"
          value={form.prNumber}
          disabled={busy}
          onChange={(e) => onChange("prNumber", e.target.value)}
          aria-label="Description pull request number"
          aria-invalid={prNumberInvalid}
          aria-describedby={prNumberInvalid ? prNumberHintId : undefined}
        />
        {prNumberInvalid ? (
          <p
            id={prNumberHintId}
            style={{ font: "var(--text-caption)", color: "var(--feedback-danger)", margin: 0 }}
          >
            Enter the numeric Pull Request number, for example 1499.
          </p>
        ) : null}
      </label>
      <label style={{ ...LABEL_STYLE, flex: 1 }}>
        Language{" "}
        <select
          style={FIELD_STYLE}
          value={form.language}
          disabled={busy}
          onChange={(e) => onChange("language", e.target.value as PrDescriptionLanguage)}
          aria-label="Description language"
        >
          {PR_DESCRIPTION_LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {language.toUpperCase()}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

interface DescriptionButtonsProps {
  readonly busy: boolean;
  readonly canPreview: boolean;
  readonly canApprove: boolean;
  readonly canApply: boolean;
  readonly onPreview: () => void;
  readonly onApprove: () => void;
  readonly onApply: () => void;
}

function PrDescriptionButtons({
  busy,
  canPreview,
  canApprove,
  canApply,
  onPreview,
  onApprove,
  onApply,
}: DescriptionButtonsProps): ReactNode {
  return (
    <div style={ROW_STYLE}>
      <button
        type="button"
        style={GHOST_BTN}
        disabled={busy || !canPreview}
        onClick={onPreview}
        data-testid="gpr-description-preview-button"
      >
        Preview description
      </button>
      <button
        type="button"
        style={GHOST_BTN}
        disabled={busy || !canApprove}
        onClick={onApprove}
        data-testid="gpr-description-approve-button"
      >
        Approve
      </button>
      <button
        type="button"
        style={PRIMARY_BTN}
        disabled={busy || !canApply}
        onClick={onApply}
        data-testid="gpr-description-apply-button"
      >
        Apply
      </button>
    </div>
  );
}

function descriptionRefreshHint(
  hasPreviewed: boolean,
  stillValid: boolean,
  state: string | undefined,
): ReactNode {
  if (!hasPreviewed || (stillValid && state !== "stale")) return null;
  const message = stillValid
    ? "This preview is stale — the pull request changed since it was generated. Preview again before approving or applying."
    : "The repository or Pull Request number changed since the last preview. Preview again before approving or applying.";
  return (
    <p
      role="alert"
      style={{ font: "var(--text-body-sm)", color: "var(--feedback-danger)" }}
      data-testid="gpr-description-refresh-hint"
    >
      <InfoIcon size={12} /> {message}
    </p>
  );
}

function PrDescriptionPanel({
  client,
  projectId,
  ownerAndRepo,
}: {
  readonly client: GovernedPullRequestClient;
  readonly projectId: string;
  readonly ownerAndRepo: string | undefined;
}): ReactNode {
  const [form, setForm] = useState<DescriptionForm>(() => initialDescriptionForm(ownerAndRepo));
  const onChange = useCallback(
    <K extends keyof DescriptionForm>(key: K, value: DescriptionForm[K]): void => {
      setForm((f) => ({ ...f, [key]: value }));
    },
    [],
  );
  // Present only once ALL three description methods are on the injected client (Frozen Decision 7:
  // the whole preview -> approve -> apply lifecycle or none of it) — never a partially wired panel.
  const descriptionClient: RequiredPrDescriptionClient | undefined =
    client.prDescriptionPreview === undefined ||
    client.prDescriptionApprove === undefined ||
    client.prDescriptionApply === undefined
      ? undefined
      : {
          prDescriptionPreview: client.prDescriptionPreview,
          prDescriptionApprove: client.prDescriptionApprove,
          prDescriptionApply: client.prDescriptionApply,
        };
  const async = useGovernedPrDescriptionActions(descriptionClient);

  const targetKey = descriptionTargetKeyOf(form.ownerAndRepo, form.prNumber);
  const previewedKey =
    async.target === null ? "" : descriptionTargetKeyOf(async.target.ownerAndRepo, String(async.target.prNumber));
  const stillValid = previewedKey !== "" && previewedKey === targetKey;
  const visibleResult = stillValid ? async.result : null;
  const state = stillValid ? descriptionStateOf(visibleResult) : undefined;

  const canPreview = form.ownerAndRepo !== "" && isValidDescriptionPrNumber(form.prNumber);
  const canApprove = stillValid && async.proposalId !== null && !async.approved && state !== "stale";
  const canApply = stillValid && async.proposalId !== null && async.approved && state !== "stale";

  const onPreview = useCallback((): void => {
    if (!canPreview) return;
    async.runPreview({
      projectId,
      ownerAndRepo: form.ownerAndRepo,
      prNumber: Number(form.prNumber),
      language: form.language,
      ...(form.refinement === "" ? {} : { refinement: form.refinement }),
    });
  }, [async, canPreview, form.language, form.ownerAndRepo, form.prNumber, form.refinement, projectId]);

  if (descriptionClient === undefined) return null;

  return (
    <section
      style={SECTION_STYLE}
      aria-label="Pull Request description"
      data-testid="gpr-description"
    >
      <h3 style={HEADING_STYLE}>
        <GitIcon size={12} /> Description
      </h3>
      <PrDescriptionFields form={form} busy={async.busy} onChange={onChange} />
      <label style={LABEL_STYLE}>
        Refinement (optional){" "}
        <textarea
          style={{ ...FIELD_STYLE, minHeight: 60, resize: "vertical" }}
          value={form.refinement}
          disabled={async.busy}
          onChange={(e) => onChange("refinement", e.target.value)}
          aria-label="Description refinement"
        />
      </label>
      <PrDescriptionButtons
        busy={async.busy}
        canPreview={canPreview}
        canApprove={canApprove}
        canApply={canApply}
        onPreview={onPreview}
        onApprove={async.runApprove}
        onApply={async.runApply}
      />
      {descriptionRefreshHint(async.target !== null, stillValid, state)}
      <PrDescriptionStatusBadge result={visibleResult} />
      <PrDescriptionPreviewBody result={visibleResult} />
      {async.error !== null ? (
        <p role="alert" style={{ font: "var(--text-body-sm)", color: "var(--feedback-danger)" }}>
          <InfoIcon size={12} /> {async.error}
        </p>
      ) : null}
    </section>
  );
}

// ─── Card body ─────────────────────────────────────────────────────────────────────────────────────

function liveTextFor(async: Pick<PrAsyncState, "busy" | "error" | "outcome" | "preview">): string {
  if (async.busy) return "Pull request action running.";
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
  ownerAndRepo,
  baseBranchName,
  titleId,
  liveId,
}: {
  readonly client: GovernedPullRequestClient;
  readonly projectId: string;
  readonly headBranchName: string | undefined;
  readonly ownerAndRepo?: string | undefined;
  readonly baseBranchName?: string | undefined;
  readonly titleId: string;
  readonly liveId: string;
}): ReactNode {
  const [form, setForm] = useState<PrForm>(() =>
    initialForm({ headBranchName, ownerAndRepo, baseBranchName }),
  );
  // Target keys the loaded preview / last started action are valid for. A preview, outcome, or
  // error is rendered only while the form still names the exact target it was produced for.
  const [previewedKey, setPreviewedKey] = useState("");
  const [actionKey, setActionKey] = useState("");
  const async = useGovernedPrActions(client);
  const onChange = useCallback(<K extends keyof PrForm>(key: K, value: PrForm[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const onPreview = useCallback((): void => {
    const previewedTarget = prTargetKeyOf(form);
    setActionKey(previewedTarget);
    void async.runPreview(formToInput(form, projectId)).then((preview) => {
      if (preview === null) return;
      setPreviewedKey(previewedTarget);
      // Seed the editable fields from the synthesized draft when the user has not authored them yet.
      setForm((f) => ({
        ...f,
        title: f.title === "" ? preview.composedTitle : f.title,
        body: f.body === "" ? preview.composedBody : f.body,
      }));
    });
  }, [async, form, projectId]);

  const onExecute = useCallback((): void => {
    setActionKey(prTargetKeyOf(form));
    async.runExecute(formToInput(form, projectId));
  }, [async, form, projectId]);

  // Preview only needs the targets (it SYNTHESIZES a title/body suggestion); execute also needs a title.
  const canPreview =
    form.ownerAndRepo !== "" &&
    form.headBranchName !== "" &&
    form.baseBranchName !== "" &&
    (form.kind === "pr-create" || isValidPrNumber(form.prExternalId));
  const canExecute = canPreview && form.title !== "";
  const targetKey = prTargetKeyOf(form);
  const visiblePreview = previewedKey === targetKey ? async.preview : null;
  const visibleOutcome = actionKey === targetKey ? async.outcome : null;
  const visibleError = actionKey === targetKey ? async.error : null;
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
        <GitIcon size={14} /> Pull Request
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
        {liveTextFor({
          busy: async.busy,
          error: visibleError,
          outcome: visibleOutcome,
          preview: visiblePreview,
        })}
      </p>
      <PrMetadataFields form={form} busy={async.busy} onChange={onChange} />
      {visiblePreview !== null ? <PrReadinessPanel preview={visiblePreview} /> : null}
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
          {form.kind === "pr-create" ? "Create Pull Request" : "Update Pull Request"}
        </button>
      </div>
      <PrOutcome outcome={visibleOutcome} error={visibleError} />
      <PrDescriptionPanel client={client} projectId={projectId} ownerAndRepo={ownerAndRepo} />
    </div>
  );
}

export interface GovernedPullRequestCardProps {
  /** The active project workspace root (acts as projectId). When absent, an empty state renders. */
  readonly projectId?: string | undefined;
  /** The published head branch, passed from the governed Git flow Publish section. */
  readonly headBranchName?: string | undefined;
  /** Optional safe GitHub owner/repo inferred from configured remotes. */
  readonly ownerAndRepo?: string | undefined;
  /** Optional base branch inferred from upstream/current branch metadata. */
  readonly baseBranchName?: string | undefined;
  /** DI seam; defaults to the real BFF client. */
  readonly client?: GovernedPullRequestClient;
}

export function GovernedPullRequestCard({
  projectId,
  headBranchName,
  ownerAndRepo,
  baseBranchName,
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
          <GitIcon size={13} /> Select a project to open a pull request.
        </p>
      </div>
    );
  }
  return (
    <GovernedPullRequestBody
      client={client}
      projectId={projectId}
      headBranchName={headBranchName}
      ownerAndRepo={ownerAndRepo}
      baseBranchName={baseBranchName}
      titleId={titleId}
      liveId={liveId}
    />
  );
}
