// Editor-driven patch-APPLY + post-apply VERIFICATION WIRE contract (Issue #1204, Epic #1189,
// ADR-0042 D7, ADR-0043). These are the request/response shapes the `POST /api/editor/patch-apply`
// BFF route consumes and emits. The route is the governed seam between the browser-tier
// `@oscharko-dev/keiko-editor` patch-review action (apply / reject) and the server-owned, gated patch
// application (keiko-tools `validatePatch`/`applyPatch`) and post-apply verification orchestration
// (keiko-verification, isolated by an enforced deny-by-default egress boundary — keiko-sandbox).
//
// Wave-2 surface, shipped switched off (ADR-0042 D7): editor-driven patch apply and the verification
// that follows it EXECUTE untrusted, model-generated test code, so they are gated behind a default-off
// feature flag that may be enabled only once the enforced egress boundary (delivered by #1202,
// ADR-0043) is available and proven by an automated test. With the flag off the route reports
// `disabled` and performs no validation, write, or execution.
//
// Trust and content boundary:
//   - The REQUEST carries the reviewable unified `diff` the user explicitly chose to apply (round-tripped
//     from the generation response). It is reviewable code — the same content class as the candidate
//     `newText` the editor already rendered — never a raw prompt, model reasoning, retrieved excerpt, or
//     secret. The server re-validates it from scratch (containment, limits, conflicts, overwrite) and
//     never trusts the client's framing of it.
//   - The RESPONSE is content-free apart from the reviewable `diff` of a guarded revert proposal (again
//     reviewable code the user explicitly reviews before re-applying). Status, change counts, rejection
//     reasons, the verification summary, and evidence references are enum literals, counts, hashes, and
//     content-free pointers only (EU AI Act Reg. (EU) 2024/1689 Art. 12 record-keeping).
//
// Leaf-package rules (ADR-0019): pure types and frozen const tables plus throw-free validators only.
// No filesystem, no clock, no crypto, no randomness, and no imports of other `@oscharko-dev/keiko-*`
// packages.

// Schema version for the patch-apply envelope, evolved independently of the test-generation envelope
// (ADR-0010 D2: a new shape is a new literal member, never a mutation). Consumers pin against the literal.
export const EDITOR_PATCH_APPLY_SCHEMA_VERSION = "1" as const;

// ─── Request ─────────────────────────────────────────────────────────────────────────────────────
// The reviewer's explicit decision on a generated candidate patch. A patch is NEVER applied without an
// explicit `"apply"` from the user (Issue #1204 AC1); `"reject"` records the decision and mutates nothing.
export type EditorPatchApplyDecision = "apply" | "reject";

export const EDITOR_PATCH_APPLY_DECISIONS: readonly EditorPatchApplyDecision[] = [
  "apply",
  "reject",
] as const;

export interface EditorPatchApplyWireRequest {
  readonly schemaVersion: typeof EDITOR_PATCH_APPLY_SCHEMA_VERSION;
  readonly root: string;
  // Content-free correlation id of the proposal being decided. Links the apply/verification evidence to
  // the generation/proposal evidence (Issue #1204 AC4). Echoed back in the response.
  readonly patchId: string;
  readonly decision: EditorPatchApplyDecision;
  // The reviewable unified diff to apply, round-tripped from the generation response. Required (and
  // non-empty) for an `"apply"` decision; ignored for `"reject"`. The server validates and applies it.
  readonly diff: string;
  // Explicit user confirmation to overwrite an existing target file. Absent/false → a candidate that
  // would create a file which already exists is rejected (Issue #1204 AC7/AC14: no silent overwrite).
  readonly allowOverwrite?: boolean;
  // Whether to run post-apply verification. Defaults to true (verification runs after apply by default);
  // set false ONLY to express an explicit policy decision to skip it (both branches are covered by tests).
  readonly verify?: boolean;
}

// ─── Outcome ─────────────────────────────────────────────────────────────────────────────────────
export type EditorPatchApplyStatus =
  | "disabled" // the feature flag is off (the v1 default): no validation, write, or execution.
  | "applied" // the patch was applied; `verification` carries the post-apply outcome.
  | "rejected" // the decision was `"reject"`: nothing was mutated.
  | "conflict" // the patch failed pre-write validation (scope/conflict/overwrite/invalid): not applied.
  | "failed"; // a bounded, content-free, actionable failure; the editor stays usable.

export const EDITOR_PATCH_APPLY_STATUSES: readonly EditorPatchApplyStatus[] = [
  "disabled",
  "applied",
  "rejected",
  "conflict",
  "failed",
] as const;

// Why a patch could not be applied. Content-free: a reason enum plus an optional workspace-relative path.
export type EditorPatchRejectionReason =
  | "out-of-scope" // a target path escapes the workspace or matches an always-on deny pattern (AC2).
  | "would-overwrite" // a create target already exists and the user did not confirm overwrite (AC7/AC14).
  | "write-conflict" // a target changed after the patch was proposed (hunk pre-image mismatch).
  | "invalid-patch" // unparseable, malformed, binary, or over a configured size/line/file limit.
  | "empty-patch"; // the diff contained no applicable file change.

export const EDITOR_PATCH_REJECTION_REASONS: readonly EditorPatchRejectionReason[] = [
  "out-of-scope",
  "would-overwrite",
  "write-conflict",
  "invalid-patch",
  "empty-patch",
] as const;

export interface EditorPatchApplyRejection {
  readonly reason: EditorPatchRejectionReason;
  // The workspace-relative path the rejection concerns, when one applies. Never absolute, never content.
  readonly path?: string;
  // A stable, content-free, human-readable explanation.
  readonly detail: string;
}

export interface EditorPatchApplyChangeCounts {
  readonly changedFiles: number;
  readonly created: number;
  readonly deleted: number;
}

// The outcome of the post-apply verification run.
//   - "passed"  — every step passed (or was legitimately skipped).
//   - "failed"  — at least one step failed; a guarded revert proposal accompanies the response (AC5).
//   - "skipped" — verification was explicitly disabled by policy (`verify: false`).
//   - "denied"  — egress isolation was required but no enforcing backend was available, so the untrusted
//                 test code was NOT executed (fail-closed; AC8/AC12).
//   - "not-run" — no targeted test could be resolved for the applied files.
export type EditorPatchVerificationOutcome = "passed" | "failed" | "skipped" | "denied" | "not-run";

export const EDITOR_PATCH_VERIFICATION_OUTCOMES: readonly EditorPatchVerificationOutcome[] = [
  "passed",
  "failed",
  "skipped",
  "denied",
  "not-run",
] as const;

// The bounded execution envelope the verification ran under (Issue #1204 AC11/AC13: bounded time,
// output, and a fixed environment allowlist). Counts only — never the environment values themselves.
export interface EditorPatchVerificationBounds {
  readonly wallTimeMs: number;
  readonly maxOutputBytes: number;
  readonly envAllowlistCount: number;
}

// Content-free summary of the post-apply verification (Issue #1204 AC6/AC11/AC13). Records the isolation
// posture (network enforced, sandbox backend), the bounded envelope, secret-redaction status, and
// whether the run was pre- or post-apply, so an auditor can confirm untrusted code ran under an enforced,
// bounded boundary — without any test source, log line, or secret.
export interface EditorPatchVerificationSummary {
  readonly outcome: EditorPatchVerificationOutcome;
  // True when egress was OS/container-enforced (network:"none") for the run (ADR-0043).
  readonly networkEnforced: boolean;
  // The sandbox backend that enforced isolation, or "none" when egress was not enforced.
  readonly sandboxBackend: string;
  readonly stepCount: number;
  readonly passed: number;
  readonly failed: number;
  readonly durationMs: number;
  readonly bounds: EditorPatchVerificationBounds;
  // Whether the verification ran before (true) or after (false) the patch was applied. Post-apply here.
  readonly preApply: boolean;
  // Whether output/error streams were redacted before they left the execution boundary (always true).
  readonly secretsRedacted: boolean;
  // A stable, content-free, actionable detail (e.g. which gate failed by kind), redacted defence-in-depth.
  readonly detail?: string;
}

// A guarded revert proposal surfaced when post-apply verification fails (Issue #1204 AC5; Scope:
// "Rollback guidance or guarded revert proposal when verification fails"). It is a PROPOSAL only — the
// server never reverts silently (Out of Scope: "Silent rollback without user approval"). The user reviews
// the inverse `diff` and explicitly re-applies it through this same route to restore the prior state.
export interface EditorPatchRevertProposal {
  // The patchId of the applied patch this proposal reverts.
  readonly patchId: string;
  // The inverse unified diff that restores the pre-apply state, for explicit user review and re-apply.
  readonly diff: string;
  readonly changedFiles: readonly string[];
  // Content-free guidance describing why a revert is offered and that it requires explicit user action.
  readonly reason: string;
}

// Content-free evidence-run pointers tying the apply and verification phases together (Issue #1204 AC4).
// The proposal phase is linked by the shared `patchId`; these are the apply/verification record ids.
export interface EditorPatchApplyEvidenceRefs {
  readonly applyRunId: string;
  readonly verificationRunId?: string;
}

export interface EditorPatchApplyWireResponse {
  readonly schemaVersion: typeof EDITOR_PATCH_APPLY_SCHEMA_VERSION;
  readonly status: EditorPatchApplyStatus;
  // Echoes the request `patchId` so the editor can correlate the response with the reviewed proposal.
  readonly patchId: string;
  // A stable, content-free, human-readable explanation. Present for disabled/failed/rejected.
  readonly reason?: string;
  // Change counts of the applied patch; present only when `status === "applied"`.
  readonly applied?: EditorPatchApplyChangeCounts;
  // The post-apply verification summary; present when `status === "applied"`.
  readonly verification?: EditorPatchVerificationSummary;
  // The reasons a patch was not applied; present only when `status === "conflict"`.
  readonly rejections?: readonly EditorPatchApplyRejection[];
  // A guarded revert proposal; present only when post-apply verification failed.
  readonly revertProposal?: EditorPatchRevertProposal;
  // Content-free apply/verification evidence-run pointers; present once a write was attempted.
  readonly evidence?: EditorPatchApplyEvidenceRefs;
}

// ─── Pure validation (trust-boundary edge: the BFF validates a client-supplied request) ─────────────
export interface EditorPatchApplyParseOk {
  readonly ok: true;
  readonly value: EditorPatchApplyWireRequest;
}
export interface EditorPatchApplyParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type EditorPatchApplyParse = EditorPatchApplyParseOk | EditorPatchApplyParseFail;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDecision(value: unknown): value is EditorPatchApplyDecision {
  return value === "apply" || value === "reject";
}

function collectDiffErrors(value: Record<string, unknown>, errors: string[]): void {
  if (typeof value.diff !== "string") {
    errors.push("diff must be a string");
  } else if (value.decision === "apply" && value.diff.length === 0) {
    errors.push("diff must be a non-empty string for an apply decision");
  }
}

function collectOptionalFlagErrors(value: Record<string, unknown>, errors: string[]): void {
  if (value.allowOverwrite !== undefined && typeof value.allowOverwrite !== "boolean") {
    errors.push("allowOverwrite must be a boolean when provided");
  }
  if (value.verify !== undefined && typeof value.verify !== "boolean") {
    errors.push("verify must be a boolean when provided");
  }
}

function collectRequestErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== EDITOR_PATCH_APPLY_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${EDITOR_PATCH_APPLY_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.root)) {
    errors.push("root must be a non-empty string");
  }
  if (!isNonEmptyString(value.patchId)) {
    errors.push("patchId must be a non-empty string");
  }
  if (!isDecision(value.decision)) {
    errors.push("decision must be one of: apply, reject");
  }
  collectDiffErrors(value, errors);
  collectOptionalFlagErrors(value, errors);
  return errors;
}

// Validates an `unknown` payload into an EditorPatchApplyWireRequest, reporting one error per failed
// invariant. The BFF uses this to reject a malformed request with 400 INVALID_REQUEST.
export function parseEditorPatchApplyRequest(value: unknown): EditorPatchApplyParse {
  if (!isRecord(value)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const errors = collectRequestErrors(value);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_PATCH_APPLY_SCHEMA_VERSION,
      root: value.root as string,
      patchId: value.patchId as string,
      decision: value.decision as EditorPatchApplyDecision,
      diff: value.diff as string,
      ...(typeof value.allowOverwrite === "boolean"
        ? { allowOverwrite: value.allowOverwrite }
        : {}),
      ...(typeof value.verify === "boolean" ? { verify: value.verify } : {}),
    },
  };
}
