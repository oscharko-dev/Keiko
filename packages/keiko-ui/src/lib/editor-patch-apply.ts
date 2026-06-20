// Maps the governed patch-apply wire response (Issue #1204) into a content-free status view the editor
// host renders, and builds the apply/reject/revert request inputs. The host (keiko-ui) owns this seam:
// it calls the BFF (`requestEditorPatchApply`) and adapts the content-free wire shape — status, applied
// change counts, the post-apply verification summary, rejection reasons, and a guarded revert proposal —
// into a tone + headline a live region can announce. The editor package stays free of BFF/contracts-wire
// knowledge (ADR-0042 D5/D7). No raw test source, log line, or secret is ever surfaced.

import type { EditorPatchApplyRequestInput } from "./api";
import type {
  EditorPatchApplyChangeCounts,
  EditorPatchApplyDecision,
  EditorPatchApplyRejection,
  EditorPatchApplyStatus,
  EditorPatchApplyWireResponse,
  EditorPatchRevertProposal,
  EditorPatchVerificationOutcome,
  EditorPatchVerificationSummary,
} from "./types";

export type PatchApplyTone = "info" | "success" | "warning" | "error";

export interface PatchApplyVerificationView {
  readonly outcome: EditorPatchVerificationOutcome;
  readonly label: string;
  readonly networkEnforced: boolean;
  readonly sandboxBackend: string;
  readonly passed: number;
  readonly failed: number;
}

export interface PatchApplyView {
  readonly status: EditorPatchApplyStatus;
  readonly patchId: string;
  // A content-free, human-readable status line suitable for an aria-live announcement.
  readonly headline: string;
  readonly tone: PatchApplyTone;
  readonly applied?: EditorPatchApplyChangeCounts;
  readonly verification?: PatchApplyVerificationView;
  readonly rejections: readonly EditorPatchApplyRejection[];
  // A guarded revert proposal the user can review and re-apply; present only on failed verification.
  readonly revert?: EditorPatchRevertProposal;
}

const REJECTION_LABEL: Readonly<Record<EditorPatchApplyRejection["reason"], string>> = {
  "out-of-scope": "the patch targets a path outside the workspace",
  "would-overwrite": "the patch would overwrite an existing file",
  "write-conflict": "a target file changed after the patch was proposed",
  "invalid-patch": "the patch is malformed",
  "empty-patch": "the patch contains no changes",
};

function verificationLabel(outcome: EditorPatchVerificationOutcome): string {
  switch (outcome) {
    case "passed":
      return "Verification passed under enforced isolation.";
    case "failed":
      return "Verification failed. Review the change before taking follow-up action.";
    case "denied":
      return "Verification could not run: no enforced sandbox is available on this host.";
    case "skipped":
      return "Verification was skipped by policy.";
    case "not-run":
      return "Verification did not run: no test was resolved for the applied files.";
  }
}

function toVerificationView(summary: EditorPatchVerificationSummary): PatchApplyVerificationView {
  return {
    outcome: summary.outcome,
    label: verificationLabel(summary.outcome),
    networkEnforced: summary.networkEnforced,
    sandboxBackend: summary.sandboxBackend,
    passed: summary.passed,
    failed: summary.failed,
  };
}

function appliedHeadline(
  summary: EditorPatchVerificationSummary | undefined,
  hasRevertProposal: boolean,
): {
  readonly headline: string;
  readonly tone: PatchApplyTone;
} {
  if (summary === undefined || summary.outcome === "passed") {
    return { headline: "Patch applied and verified under enforced isolation.", tone: "success" };
  }
  if (summary.outcome === "failed") {
    return {
      headline: hasRevertProposal
        ? "Patch applied, but verification failed. A revert proposal is available."
        : "Patch applied, but verification failed. Review the change before taking follow-up action.",
      tone: "warning",
    };
  }
  if (summary.outcome === "denied") {
    return {
      headline: "Patch applied, but verification could not run without an enforced sandbox.",
      tone: "warning",
    };
  }
  return { headline: "Patch applied. Verification was not run.", tone: "info" };
}

function rejectionHeadline(rejections: readonly EditorPatchApplyRejection[]): string {
  const first = rejections[0];
  if (first === undefined) {
    return "Patch not applied: it failed validation.";
  }
  return `Patch not applied: ${REJECTION_LABEL[first.reason]}.`;
}

/** Adapts the wire response into the content-free status view the editor host renders. */
export function mapWireToPatchApplyView(wire: EditorPatchApplyWireResponse): PatchApplyView {
  const base = { status: wire.status, patchId: wire.patchId, rejections: wire.rejections ?? [] };
  if (wire.status === "applied") {
    const { headline, tone } = appliedHeadline(
      wire.verification,
      wire.revertProposal !== undefined,
    );
    return {
      ...base,
      headline,
      tone,
      ...(wire.applied === undefined ? {} : { applied: wire.applied }),
      ...(wire.verification === undefined
        ? {}
        : { verification: toVerificationView(wire.verification) }),
      ...(wire.revertProposal === undefined ? {} : { revert: wire.revertProposal }),
    };
  }
  if (wire.status === "conflict") {
    return { ...base, headline: rejectionHeadline(base.rejections), tone: "error" };
  }
  if (wire.status === "rejected") {
    return { ...base, headline: "Patch rejected. No changes were made.", tone: "info" };
  }
  if (wire.status === "disabled") {
    return { ...base, headline: "Patch apply is disabled in this build.", tone: "info" };
  }
  return { ...base, headline: "The patch could not be applied.", tone: "error" };
}

export interface PatchApplyDecisionOptions {
  readonly allowOverwrite?: boolean;
}

/** Builds the apply/reject request from a reviewed candidate's id and reviewable diff (Issue #1204). */
export function buildPatchApplyInput(
  root: string,
  patchId: string,
  applyableDiff: string,
  decision: EditorPatchApplyDecision,
  options: PatchApplyDecisionOptions = {},
): EditorPatchApplyRequestInput {
  return {
    root,
    patchId,
    decision,
    diff: applyableDiff,
    ...(options.allowOverwrite === undefined ? {} : { allowOverwrite: options.allowOverwrite }),
  };
}

/** Builds the re-apply request for a guarded revert proposal (explicit user action; no silent rollback). */
export function buildRevertApplyInput(
  root: string,
  revert: EditorPatchRevertProposal,
): EditorPatchApplyRequestInput {
  return { root, patchId: revert.patchId, decision: "apply", diff: revert.diff };
}
