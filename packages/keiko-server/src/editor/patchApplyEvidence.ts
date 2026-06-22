// Content-free audit linkage for editor-driven patch apply (Issue #1204, ADR-0042 D6/D7, ADR-0043).
// Records the three lifecycle phases distinctly — proposal, apply, and verification — tied together by
// the shared, content-free `patchId` correlation (AC4). The proposal phase is recorded by the
// test-generation evidence (Issue #1202); this module records the APPLY and VERIFICATION phases.
//
// Every record is content-free: it carries only enum literals, counts, a SHA-256 hash of the workspace
// root, and the bounded-execution configuration (command label, timeout, env-allowlist size, network
// status, secret-redaction status, pre/post-apply). It NEVER carries the patch text, a test log line, a
// workspace path, or a secret. Each record uses its own `editorPatchApplySchemaVersion` key and omits
// `evidenceSchemaVersion`, so the grounded / QI evidence reader skips it. Persistence failure never
// fails the request.

import { createHash } from "node:crypto";
import type {
  EditorPatchApplyChangeCounts,
  EditorPatchApplyRejection,
  EditorPatchApplyStatus,
  EditorPatchApplyDecision,
  EditorPatchVerificationSummary,
  EvidenceStore,
} from "@oscharko-dev/keiko-contracts";
import type { Redactor } from "../deps.js";

export const PATCH_APPLY_EVIDENCE_SCHEMA_VERSION = "1" as const;

type PatchApplyEvidencePhase = "apply" | "verification";

// Deterministic, content-free run id derived from the patchId correlation, the phase, and the emission
// time, so an auditor can chain proposal → apply → verification by the shared patchId.
function patchApplyEvidenceRunId(
  patchId: string,
  phase: PatchApplyEvidencePhase,
  emittedAtMs: number,
): string {
  const material = [patchId, phase, String(emittedAtMs)].join("\n");
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 16);
  return `editor-patch-${phase}-${digest}`;
}

// A SHA-256 hash of the canonical workspace root: a content-free pointer that identifies the root in
// the audit trail without recording the path itself (AC13 "cwd/root").
function rootHash(rootRealPath: string): string {
  return createHash("sha256").update(rootRealPath).digest("hex").slice(0, 16);
}

export interface PatchApplyEvidenceInput {
  readonly patchId: string;
  readonly decision: EditorPatchApplyDecision;
  readonly status: EditorPatchApplyStatus;
  readonly applied: boolean;
  readonly counts?: EditorPatchApplyChangeCounts | undefined;
  readonly rejections?: readonly EditorPatchApplyRejection[] | undefined;
  readonly allowOverwrite: boolean;
}

// Records the APPLY-phase evidence: the decision, the outcome status, content-free change counts, and the
// rejection reasons (enums only — no paths). Returns the run id for the response evidence pointer.
export function recordPatchApplyEvidence(
  store: EvidenceStore,
  redactor: Redactor,
  input: PatchApplyEvidenceInput,
  emittedAtMs: number,
): string {
  const runId = patchApplyEvidenceRunId(input.patchId, "apply", emittedAtMs);
  const manifest = {
    editorPatchApplySchemaVersion: PATCH_APPLY_EVIDENCE_SCHEMA_VERSION,
    runId,
    phase: "apply" as const,
    patchId: input.patchId,
    decision: input.decision,
    status: input.status,
    applied: input.applied,
    allowOverwrite: input.allowOverwrite,
    changedFiles: input.counts?.changedFiles ?? 0,
    created: input.counts?.created ?? 0,
    deleted: input.counts?.deleted ?? 0,
    rejectionReasons: (input.rejections ?? []).map((rejection) => rejection.reason),
    emittedAtMs,
  };
  try {
    store.put(runId, JSON.stringify(redactor(manifest)));
  } catch {
    // Audit persistence is best-effort; a write failure must never fail the user's request.
  }
  return runId;
}

export interface PatchVerificationEvidenceInput {
  readonly patchId: string;
  readonly rootRealPath: string;
  // Content-free command label (e.g. "npx vitest run"); never includes file paths.
  readonly command: string;
  readonly summary: EditorPatchVerificationSummary;
}

// Records the VERIFICATION-phase evidence. Per the Issue #1204 owner addendum, it states the command,
// cwd/root (hashed), timeout, env allowlist, network status, secret-redaction status, and whether the
// run was pre- or post-apply — all content-free.
export function recordPatchVerificationEvidence(
  store: EvidenceStore,
  redactor: Redactor,
  input: PatchVerificationEvidenceInput,
  emittedAtMs: number,
): string {
  const runId = patchApplyEvidenceRunId(input.patchId, "verification", emittedAtMs);
  const { summary } = input;
  const manifest = {
    editorPatchApplySchemaVersion: PATCH_APPLY_EVIDENCE_SCHEMA_VERSION,
    runId,
    phase: "verification" as const,
    patchId: input.patchId,
    command: input.command,
    rootHash: rootHash(input.rootRealPath),
    outcome: summary.outcome,
    networkStatus: summary.networkEnforced ? "enforced-none" : "inherited",
    sandboxBackend: summary.sandboxBackend,
    timeoutMs: summary.bounds.wallTimeMs,
    maxOutputBytes: summary.bounds.maxOutputBytes,
    envAllowlistCount: summary.bounds.envAllowlistCount,
    secretsRedacted: summary.secretsRedacted,
    preApply: summary.preApply,
    stepCount: summary.stepCount,
    passed: summary.passed,
    failed: summary.failed,
    durationMs: summary.durationMs,
    emittedAtMs,
  };
  try {
    store.put(runId, JSON.stringify(redactor(manifest)));
  } catch {
    // Audit persistence is best-effort; a write failure must never fail the user's request.
  }
  return runId;
}
