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
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import {
  ApiError,
  fetchGitDeliveryPrApprove,
  fetchGitDeliveryPrExecute,
  fetchGitDeliveryPrPreview,
  fetchGitDeliveryPrDescriptionApply,
  fetchGitDeliveryPrDescriptionApprove,
  fetchGitDeliveryPrDescriptionPreview,
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
// `PR_DESCRIPTION_LANGUAGES` is a real value, not a type, so it stays a genuine runtime import.
// Sourced from the contract's own runtime subpath directly (never re-exported through `./api`,
// which is first-load-reachable from the desktop shell) so this small enum-of-languages value never
// drags `pr-description`'s validator module into the eager chunk (epic #3384 final-audit F18) —
// this card is already behind the `next/dynamic({ ssr: false })` boundary in widgets/index.tsx.
import { PR_DESCRIPTION_LANGUAGES } from "@oscharko-dev/keiko-contracts/runtime/pr-description";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
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

// #3387: mints the approval the create/update mutation now requires unconditionally FIRST, from the
// EXACT SAME input, then attaches the returned claim to the identical input before execute — the
// mint route binds to that exact typed command, so the claim it returns is redeemable only for this
// same target/title/body combination (mirrors GovernedMergeCard's runExecute). `prApprove` is
// optional on the client (see GovernedPullRequestClient) — when absent, execute runs unapproved,
// exactly as it did before #3387 (the BFF route itself is the fail-closed backstop).
function withMintedPrApproval(
  client: GovernedPullRequestClient,
  input: GitDeliveryPrInput,
): Promise<GitDeliveryPrInput> {
  const prApprove = client.prApprove;
  if (prApprove === undefined) return Promise.resolve(input);
  return prApprove(input).then((approved): GitDeliveryPrInput => ({
    ...input,
    approval: approved.approval,
  }));
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

  const runExecute = useCallback(
    (input: GitDeliveryPrInput): void => {
      const token = (seq.current += 1);
      setState((s) => ({ ...s, busy: true, error: null, outcome: null }));
      void withMintedPrApproval(client, input)
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

// Action (Create/Update) fieldset — extracted from PrMetadataFields (AGENTS.md §6 max-lines-per-function).
function PrActionFieldset({ form, busy, onChange }: FieldsProps): ReactNode {
  return (
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
  );
}

// PR number field, shown only for the "pr-update" action. `prNumberHintId` is generated by the
// always-mounted PrMetadataFields (not here) so the id stays stable across kind switches instead
// of being re-minted whenever this conditionally-rendered block mounts.
interface UpdateOnlyFieldsProps extends FieldsProps {
  readonly prNumberHintId: string;
  readonly prIdInvalid: boolean;
}

function PrUpdatePrNumberField({
  form,
  busy,
  onChange,
  prNumberHintId,
  prIdInvalid,
}: UpdateOnlyFieldsProps): ReactNode {
  return (
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
  );
}

function PrUpdateDraftStateField({ form, busy, onChange }: FieldsProps): ReactNode {
  const t = useTranslate();
  return (
    <label style={{ ...LABEL_STYLE, flex: 1 }}>
      Draft state{" "}
      <select
        style={FIELD_STYLE}
        value={form.draftTransition}
        disabled={busy}
        onChange={(e) => onChange("draftTransition", e.target.value as PrForm["draftTransition"])}
        aria-label="Draft state"
      >
        <option value="none">No change</option>
        <option value="to-draft">Convert to draft</option>
      </select>
      <span
        style={{ font: "var(--text-caption)", color: "var(--fg-muted)" }}
        data-testid="gpr-mark-ready-hint"
      >
        {t("governedPullRequestCard.markReadyHint")}
      </span>
    </label>
  );
}

// Wraps the two update-only fields in their shared row — thin composition, kept for the same reason
// PrMetadataFields itself is: DOM order and grouping must stay exactly as before the decomposition.
function PrUpdateOnlyFields(props: UpdateOnlyFieldsProps): ReactNode {
  return (
    <div style={ROW_STYLE}>
      <PrUpdatePrNumberField {...props} />
      <PrUpdateDraftStateField {...props} />
    </div>
  );
}

function PrHeadBranchField({ form, busy, onChange }: FieldsProps): ReactNode {
  return (
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
  );
}

function PrTitleBodyFields({ form, busy, onChange }: FieldsProps): ReactNode {
  return (
    <>
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
    </>
  );
}

function PrDraftCheckbox({ form, busy, onChange }: FieldsProps): ReactNode {
  return (
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
      <PrActionFieldset form={form} busy={busy} onChange={onChange} />
      {form.kind === "pr-update" ? (
        <PrUpdateOnlyFields
          form={form}
          busy={busy}
          onChange={onChange}
          prNumberHintId={prNumberHintId}
          prIdInvalid={prIdInvalid}
        />
      ) : null}
      <PrHeadBranchField form={form} busy={busy} onChange={onChange} />
      <PrTargetFields form={form} busy={busy} onChange={onChange} />
      <PrTitleBodyFields form={form} busy={busy} onChange={onChange} />
      <PrDraftCheckbox form={form} busy={busy} onChange={onChange} />
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
}

function initialDescriptionForm(ownerAndRepo: string | undefined): DescriptionForm {
  return { ownerAndRepo: ownerAndRepo ?? "", prNumber: "", language: "en" };
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

// Shared sequencing for the three description actions below: increments the guard token, marks
// busy, dispatches `run()`, and on the still-current response applies `onSettled`'s state patch — a
// stale (superseded) response is silently dropped, mirroring useGovernedPrActions' own seq guard.
function dispatchDescriptionAction<T>(
  seq: { current: number },
  setState: (updater: (s: DescriptionAsyncState) => DescriptionAsyncState) => void,
  handleError: (err: unknown, token: number) => void,
  run: () => Promise<T>,
  onSettled: (value: T) => Partial<DescriptionAsyncState>,
): void {
  const token = (seq.current += 1);
  setState((s) => ({ ...s, busy: true, error: null }));
  void run()
    .then((value) => {
      if (token !== seq.current) return;
      setState((s) => ({ ...s, busy: false, ...onSettled(value) }));
    })
    .catch((err: unknown) => handleError(err, token));
}

function descriptionPreviewAction(
  client: RequiredPrDescriptionClient,
  seq: { current: number },
  setState: (updater: (s: DescriptionAsyncState) => DescriptionAsyncState) => void,
  handleError: (err: unknown, token: number) => void,
  input: GitDeliveryPrDescriptionPreviewInput,
): void {
  const target: GitDeliveryPrDescriptionTarget = {
    projectId: input.projectId,
    ownerAndRepo: input.ownerAndRepo,
    prNumber: input.prNumber,
  };
  dispatchDescriptionAction(
    seq,
    setState,
    handleError,
    () => client.prDescriptionPreview(input),
    (result) => ({
      result,
      target,
      proposalId: result.outcome === "preview" ? result.preview.proposalId : null,
      approved: false,
    }),
  );
}

function descriptionApproveAction(
  client: RequiredPrDescriptionClient,
  seq: { current: number },
  setState: (updater: (s: DescriptionAsyncState) => DescriptionAsyncState) => void,
  handleError: (err: unknown, token: number) => void,
  target: GitDeliveryPrDescriptionTarget,
  proposalId: string,
): void {
  dispatchDescriptionAction(
    seq,
    setState,
    handleError,
    () => client.prDescriptionApprove({ ...target, proposalId }),
    () => ({ approved: true }),
  );
}

function descriptionApplyAction(
  client: RequiredPrDescriptionClient,
  seq: { current: number },
  setState: (updater: (s: DescriptionAsyncState) => DescriptionAsyncState) => void,
  handleError: (err: unknown, token: number) => void,
  target: GitDeliveryPrDescriptionTarget,
  proposalId: string,
): void {
  dispatchDescriptionAction(
    seq,
    setState,
    handleError,
    () => client.prDescriptionApply({ ...target, proposalId }),
    // One-use: the spent proposal/approval never carries forward to a second Apply click — but
    // `target` is kept so the just-applied result stays visible (still "the exact target the
    // current result was produced for"); only a fresh Preview mints a new proposal to approve.
    (result) => ({ result, proposalId: null, approved: false }),
  );
}

// The returned object is rebuilt every render regardless (it spreads `state`), so wrapping these in
// `useCallback` would buy no referential stability — plain closures keep the hook itself short.
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

  const handleError = (err: unknown, token: number): void => {
    if (token !== seq.current) return;
    setState((s) => ({ ...s, busy: false, error: formatError(err) }));
  };

  const runPreview = (input: GitDeliveryPrDescriptionPreviewInput): void => {
    if (client === undefined) return;
    descriptionPreviewAction(client, seq, setState, handleError, input);
  };

  const runApprove = (): void => {
    if (client === undefined || state.proposalId === null || state.target === null) return;
    descriptionApproveAction(client, seq, setState, handleError, state.target, state.proposalId);
  };

  const runApply = (): void => {
    if (
      client === undefined ||
      state.proposalId === null ||
      state.target === null ||
      !state.approved
    ) {
      return;
    }
    descriptionApplyAction(client, seq, setState, handleError, state.target, state.proposalId);
  };

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

function descriptionReasonOf(
  result: PrDescriptionApplicationResultWire | null,
): string | undefined {
  if (result === null) return undefined;
  if (result.outcome === "preview") return result.preview.status.reason;
  if (result.outcome === "observed") return result.status.reason;
  return result.reason;
}

// Text + icon only — never colour alone (WCAG 2.2 AA), matching PrOutcome above.
const DESCRIPTION_STATE_LABEL_KEY: Readonly<
  Record<PrDescriptionApplicationStatus["state"], MessageKey>
> = {
  current: "governedPullRequestCard.description.state.current",
  stale: "governedPullRequestCard.description.state.stale",
  partial: "governedPullRequestCard.description.state.partial",
  fallback: "governedPullRequestCard.description.state.fallback",
  blocked: "governedPullRequestCard.description.state.blocked",
  failed: "governedPullRequestCard.description.state.failed",
};

function PrDescriptionStatusBadge({
  result,
  t,
}: {
  readonly result: PrDescriptionApplicationResultWire | null;
  readonly t: I18nTranslate;
}): ReactNode {
  const state = descriptionStateOf(result);
  if (state === undefined) return null;
  const reason = descriptionReasonOf(result);
  return (
    <p style={KV_LABEL} data-testid="gpr-description-state" data-state={state}>
      <InfoIcon size={12} /> {t(DESCRIPTION_STATE_LABEL_KEY[state])}
      {reason !== undefined ? ` (${reason})` : ""}
    </p>
  );
}

// Renders the server-rendered final body byte-for-byte: the repository template, human-authored
// text outside the managed region, and the trusted "by Keiko" attribution are composed server-side
// (epic #3384 Frozen Decisions 10/11) and must never be recomposed or re-derived in the browser.
function PrDescriptionPreviewBody({
  result,
  t,
}: {
  readonly result: PrDescriptionApplicationResultWire | null;
  readonly t: I18nTranslate;
}): ReactNode {
  if (result === null || result.outcome !== "preview") return null;
  return (
    <div style={LABEL_STYLE}>
      <span>{t("governedPullRequestCard.description.previewCaption")}</span>
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

interface DescriptionFieldsProps {
  readonly form: DescriptionForm;
  readonly busy: boolean;
  readonly onChange: <K extends keyof DescriptionForm>(key: K, value: DescriptionForm[K]) => void;
  readonly t: I18nTranslate;
}

function PrDescriptionPrNumberField({
  form,
  busy,
  onChange,
  t,
}: DescriptionFieldsProps): ReactNode {
  const prNumberHintId = useId();
  const prNumberInvalid = form.prNumber !== "" && !isValidDescriptionPrNumber(form.prNumber);
  // The visible label text intentionally matches the aria-label below (both say "Description pull
  // request number", not the bare "Pull Request number" the create/update form above uses) — two
  // fields with identical accessible names in the same DOM tree are ambiguous for assistive tech
  // and for any `getByLabelText` query, even though they serve distinct forms.
  return (
    <label style={{ ...LABEL_STYLE, flex: 1 }}>
      {t("governedPullRequestCard.description.field.prNumberAria")}{" "}
      <input
        style={FIELD_STYLE}
        inputMode="numeric"
        value={form.prNumber}
        disabled={busy}
        onChange={(e) => onChange("prNumber", e.target.value)}
        aria-label={t("governedPullRequestCard.description.field.prNumberAria")}
        aria-invalid={prNumberInvalid}
        aria-describedby={prNumberInvalid ? prNumberHintId : undefined}
      />
      {prNumberInvalid ? (
        <p
          id={prNumberHintId}
          style={{ font: "var(--text-caption)", color: "var(--feedback-danger)", margin: 0 }}
        >
          {t("governedPullRequestCard.description.field.prNumberHint")}
        </p>
      ) : null}
    </label>
  );
}

function PrDescriptionLanguageField({
  form,
  busy,
  onChange,
  t,
}: DescriptionFieldsProps): ReactNode {
  return (
    <label style={{ ...LABEL_STYLE, flex: 1 }}>
      {t("governedPullRequestCard.description.field.language")}{" "}
      <select
        style={FIELD_STYLE}
        value={form.language}
        disabled={busy}
        onChange={(e) => onChange("language", e.target.value as PrDescriptionLanguage)}
        aria-label={t("governedPullRequestCard.description.field.languageAria")}
      >
        {PR_DESCRIPTION_LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {language.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  );
}

function PrDescriptionFields(props: DescriptionFieldsProps): ReactNode {
  const { form, busy, onChange, t } = props;
  // Same rationale as PrDescriptionPrNumberField above: the visible label matches the aria-label
  // ("Description repository (owner/repo)"), never the create/update form's bare "Repository
  // (owner/repo)", so the two fields never share an ambiguous accessible name.
  return (
    <div style={ROW_STYLE}>
      <label style={{ ...LABEL_STYLE, flex: 1 }}>
        {t("governedPullRequestCard.description.field.repositoryAria")}{" "}
        <input
          style={FIELD_STYLE}
          value={form.ownerAndRepo}
          disabled={busy}
          onChange={(e) => onChange("ownerAndRepo", e.target.value)}
          aria-label={t("governedPullRequestCard.description.field.repositoryAria")}
        />
      </label>
      <PrDescriptionPrNumberField {...props} />
      <PrDescriptionLanguageField {...props} />
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
  readonly t: I18nTranslate;
}

function PrDescriptionButtons({
  busy,
  canPreview,
  canApprove,
  canApply,
  onPreview,
  onApprove,
  onApply,
  t,
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
        {t("governedPullRequestCard.description.action.preview")}
      </button>
      <button
        type="button"
        style={GHOST_BTN}
        disabled={busy || !canApprove}
        onClick={onApprove}
        data-testid="gpr-description-approve-button"
      >
        {t("governedPullRequestCard.description.action.approve")}
      </button>
      <button
        type="button"
        style={PRIMARY_BTN}
        disabled={busy || !canApply}
        onClick={onApply}
        data-testid="gpr-description-apply-button"
      >
        {t("governedPullRequestCard.description.action.apply")}
      </button>
    </div>
  );
}

function descriptionRefreshHint(
  hasPreviewed: boolean,
  stillValid: boolean,
  state: string | undefined,
  t: I18nTranslate,
): ReactNode {
  if (!hasPreviewed || (stillValid && state !== "stale")) return null;
  const message = stillValid
    ? t("governedPullRequestCard.description.refreshHint.stale")
    : t("governedPullRequestCard.description.refreshHint.targetChanged");
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

// Present only once ALL three description methods are on the injected client (Frozen Decision 7:
// the whole preview -> approve -> apply lifecycle or none of it) — never a partially wired panel.
function requiredPrDescriptionClient(
  client: GovernedPullRequestClient,
): RequiredPrDescriptionClient | undefined {
  const { prDescriptionPreview, prDescriptionApprove, prDescriptionApply } = client;
  if (
    prDescriptionPreview === undefined ||
    prDescriptionApprove === undefined ||
    prDescriptionApply === undefined
  ) {
    return undefined;
  }
  return { prDescriptionPreview, prDescriptionApprove, prDescriptionApply };
}

interface DescriptionPanelFlags {
  readonly stillValid: boolean;
  readonly hasPreviewed: boolean;
  readonly visibleResult: PrDescriptionApplicationResultWire | null;
  readonly state: PrDescriptionApplicationStatus["state"] | undefined;
  readonly canPreview: boolean;
  readonly canApprove: boolean;
  readonly canApply: boolean;
}

type DescriptionVisibility = Pick<
  DescriptionPanelFlags,
  "stillValid" | "hasPreviewed" | "visibleResult" | "state"
>;

// A preview/approval is shown only while the form still names the exact target it was produced for
// — mirrors GovernedPullRequestBody's previewedKey/targetKey gate for the create/update form above,
// applied to the description lifecycle's own (ownerAndRepo, prNumber) target.
function derivePrDescriptionVisibility(
  form: DescriptionForm,
  async: DescriptionAsync,
): DescriptionVisibility {
  const targetKey = descriptionTargetKeyOf(form.ownerAndRepo, form.prNumber);
  const previewedKey =
    async.target === null
      ? ""
      : descriptionTargetKeyOf(async.target.ownerAndRepo, String(async.target.prNumber));
  const stillValid = previewedKey !== "" && previewedKey === targetKey;
  const visibleResult = stillValid ? async.result : null;
  return {
    stillValid,
    hasPreviewed: async.target !== null,
    visibleResult,
    state: stillValid ? descriptionStateOf(visibleResult) : undefined,
  };
}

function derivePrDescriptionPanelFlags(
  form: DescriptionForm,
  async: DescriptionAsync,
): DescriptionPanelFlags {
  const visibility = derivePrDescriptionVisibility(form, async);
  const { stillValid, state } = visibility;
  return {
    ...visibility,
    canPreview: form.ownerAndRepo !== "" && isValidDescriptionPrNumber(form.prNumber),
    canApprove: stillValid && async.proposalId !== null && !async.approved && state !== "stale",
    canApply: stillValid && async.proposalId !== null && async.approved && state !== "stale",
  };
}

function PrDescriptionPanelStatus({
  flags,
  error,
  t,
}: {
  readonly flags: DescriptionPanelFlags;
  readonly error: string | null;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <>
      {descriptionRefreshHint(flags.hasPreviewed, flags.stillValid, flags.state, t)}
      <PrDescriptionStatusBadge result={flags.visibleResult} t={t} />
      <PrDescriptionPreviewBody result={flags.visibleResult} t={t} />
      {error !== null ? (
        <p role="alert" style={{ font: "var(--text-body-sm)", color: "var(--feedback-danger)" }}>
          <InfoIcon size={12} /> {error}
        </p>
      ) : null}
    </>
  );
}

function usePrDescriptionPreviewHandler(
  form: DescriptionForm,
  flags: DescriptionPanelFlags,
  async: DescriptionAsync,
  projectId: string,
): () => void {
  return useCallback((): void => {
    if (!flags.canPreview) return;
    async.runPreview({
      projectId,
      ownerAndRepo: form.ownerAndRepo,
      prNumber: Number(form.prNumber),
      language: form.language,
    });
  }, [async, flags.canPreview, form.language, form.ownerAndRepo, form.prNumber, projectId]);
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
  const t = useTranslate();
  const descriptionClient = requiredPrDescriptionClient(client);
  const async = useGovernedPrDescriptionActions(descriptionClient);
  const flags = derivePrDescriptionPanelFlags(form, async);
  const onPreview = usePrDescriptionPreviewHandler(form, flags, async, projectId);

  if (descriptionClient === undefined) return null;

  return (
    <section
      style={SECTION_STYLE}
      aria-label={t("governedPullRequestCard.description.regionAria")}
      data-testid="gpr-description"
    >
      <h3 style={HEADING_STYLE}>
        <GitIcon size={12} /> {t("governedPullRequestCard.description.heading")}
      </h3>
      <PrDescriptionFields form={form} busy={async.busy} onChange={onChange} t={t} />
      <PrDescriptionButtons
        busy={async.busy}
        canPreview={flags.canPreview}
        canApprove={flags.canApprove}
        canApply={flags.canApply}
        onPreview={onPreview}
        onApprove={async.runApprove}
        onApply={async.runApply}
        t={t}
      />
      <PrDescriptionPanelStatus flags={flags} error={async.error} t={t} />
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

interface GovernedPullRequestBodyProps {
  readonly client: GovernedPullRequestClient;
  readonly projectId: string;
  readonly headBranchName: string | undefined;
  readonly ownerAndRepo?: string | undefined;
  readonly baseBranchName?: string | undefined;
  readonly titleId: string;
  readonly liveId: string;
}

const CARD_BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  padding: "var(--space-3)",
  overflow: "auto",
  height: "100%",
};
const LIVE_REGION_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
};

// The visible title + visually-hidden aria-live status line — extracted from GovernedPullRequestBody
// (AGENTS.md §6 max-lines-per-function). A Fragment, so this adds no DOM node of its own.
function PrBodyHeader({
  titleId,
  liveId,
  liveText,
}: {
  readonly titleId: string;
  readonly liveId: string;
  readonly liveText: string;
}): ReactNode {
  return (
    <>
      <h2 id={titleId} style={{ ...HEADING_STYLE, font: "var(--text-title)" }}>
        <GitIcon size={14} /> Pull Request
      </h2>
      <p
        id={liveId}
        data-testid="gpr-live"
        role="status"
        aria-live="polite"
        style={LIVE_REGION_STYLE}
      >
        {liveText}
      </p>
    </>
  );
}

function prSubmitLabel(kind: GitDeliveryPrKind): string {
  return kind === "pr-create" ? "Create Pull Request" : "Update Pull Request";
}

function PrFormActionButtons({
  busy,
  canPreview,
  canExecute,
  kind,
  onPreview,
  onExecute,
}: {
  readonly busy: boolean;
  readonly canPreview: boolean;
  readonly canExecute: boolean;
  readonly kind: GitDeliveryPrKind;
  readonly onPreview: () => void;
  readonly onExecute: () => void;
}): ReactNode {
  return (
    <div style={ROW_STYLE}>
      <button type="button" style={GHOST_BTN} disabled={busy || !canPreview} onClick={onPreview}>
        Preview
      </button>
      <button
        type="button"
        style={PRIMARY_BTN}
        disabled={busy || !canExecute}
        onClick={onExecute}
        data-testid="gpr-submit"
      >
        {prSubmitLabel(kind)}
      </button>
    </div>
  );
}

// Preview only needs the targets (it SYNTHESIZES a title/body suggestion); execute also needs a title.
function derivePrFormFlags(form: PrForm): { canPreview: boolean; canExecute: boolean } {
  const canPreview =
    form.ownerAndRepo !== "" &&
    form.headBranchName !== "" &&
    form.baseBranchName !== "" &&
    (form.kind === "pr-create" || isValidPrNumber(form.prExternalId));
  return { canPreview, canExecute: canPreview && form.title !== "" };
}

interface PrVisibleState {
  readonly visiblePreview: GitDeliveryPrPreviewResponse | null;
  readonly visibleOutcome: GitDeliveryPrExecuteResponse | null;
  readonly visibleError: string | null;
}

// A preview, outcome, or error is surfaced only while the form still names the exact target it was
// produced for (targetKey), never a stale one left over from a previous target.
function derivePrVisibleState(
  async: Pick<PrAsyncState, "preview" | "outcome" | "error">,
  previewedKey: string,
  actionKey: string,
  targetKey: string,
): PrVisibleState {
  return {
    visiblePreview: previewedKey === targetKey ? async.preview : null,
    visibleOutcome: actionKey === targetKey ? async.outcome : null,
    visibleError: actionKey === targetKey ? async.error : null,
  };
}

interface PrRenderState extends PrVisibleState {
  readonly canPreview: boolean;
  readonly canExecute: boolean;
  readonly liveText: string;
}

// Bundles the pure per-render derivations (form validity, target-scoped visibility, the live-region
// text) so GovernedPullRequestBody itself stays a thin composition.
function derivePrRenderState(
  form: PrForm,
  async: PrAsyncState,
  previewedKey: string,
  actionKey: string,
): PrRenderState {
  const { canPreview, canExecute } = derivePrFormFlags(form);
  const visible = derivePrVisibleState(async, previewedKey, actionKey, prTargetKeyOf(form));
  const liveText = liveTextFor({
    busy: async.busy,
    error: visible.visibleError,
    outcome: visible.visibleOutcome,
    preview: visible.visiblePreview,
  });
  return { canPreview, canExecute, ...visible, liveText };
}

// The preview/execute submit handlers — extracted from GovernedPullRequestBody (AGENTS.md §6
// max-lines-per-function). `setForm`/`setPreviewedKey`/`setActionKey` are the stable setters
// returned by the parent's own `useState` calls, so omitting them from the dependency arrays below
// (as the original inline callbacks did) keeps `onPreview`/`onExecute` referentially identical
// across renders that only change unrelated state.
function usePrFormActionHandlers(
  form: PrForm,
  setForm: Dispatch<SetStateAction<PrForm>>,
  projectId: string,
  async: PrAsync,
  setPreviewedKey: Dispatch<SetStateAction<string>>,
  setActionKey: Dispatch<SetStateAction<string>>,
): { onPreview: () => void; onExecute: () => void } {
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
    // `setActionKey`/`setForm`/`setPreviewedKey` are the stable setters returned by the caller's own
    // `useState` calls (guaranteed referentially stable by React) — listed here only to satisfy
    // exhaustive-deps now that they arrive as parameters instead of same-scope closures; including
    // them does not change when this callback is recreated.
  }, [async, form, projectId, setActionKey, setForm, setPreviewedKey]);

  const onExecute = useCallback((): void => {
    setActionKey(prTargetKeyOf(form));
    async.runExecute(formToInput(form, projectId));
  }, [async, form, projectId, setActionKey]);

  return { onPreview, onExecute };
}

function GovernedPullRequestBody({
  client,
  projectId,
  headBranchName,
  ownerAndRepo,
  baseBranchName,
  titleId,
  liveId,
}: GovernedPullRequestBodyProps): ReactNode {
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
  const { onPreview, onExecute } = usePrFormActionHandlers(
    form,
    setForm,
    projectId,
    async,
    setPreviewedKey,
    setActionKey,
  );
  const { canPreview, canExecute, visiblePreview, visibleOutcome, visibleError, liveText } =
    derivePrRenderState(form, async, previewedKey, actionKey);

  return (
    <div style={CARD_BODY_STYLE} aria-labelledby={titleId}>
      <PrBodyHeader titleId={titleId} liveId={liveId} liveText={liveText} />
      <PrMetadataFields form={form} busy={async.busy} onChange={onChange} />
      {visiblePreview !== null ? <PrReadinessPanel preview={visiblePreview} /> : null}
      <PrFormActionButtons
        busy={async.busy}
        canPreview={canPreview}
        canExecute={canExecute}
        kind={form.kind}
        onPreview={onPreview}
        onExecute={onExecute}
      />
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
