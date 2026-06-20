// BFF route for governed, editor-driven patch APPLY + post-apply VERIFICATION (Issue #1204,
// ADR-0042 D7, ADR-0043).
//
//   POST /api/editor/patch-apply — apply or reject a reviewed candidate patch, then (for an apply) run
//                                  post-apply verification in an enforced, deny-by-default egress
//                                  boundary and record proposal/apply/verification evidence.
//
// Wave-2 surface, shipped switched OFF (ADR-0042 D7): patch apply and the verification that follows it
// EXECUTE untrusted, model-generated test code, so they are gated behind a default-off feature flag
// enabled only once the enforced egress boundary (delivered by #1202, ADR-0043) is available. Off
// (default) → `disabled`: no validation, write, or execution.
//
// Apply is fail-closed and explicit (AC1): a patch is applied only on an explicit `"apply"` decision and
// only after it passes keiko-tools validation (scope containment AC2, per-hunk write-conflict detection,
// size/line/file limits, and the no-silent-overwrite guardrail AC7/AC14). The diff is round-tripped from
// the generation response and re-validated from scratch — the client's framing is never trusted. On a
// failed verification a guarded restore proposal for explicit re-apply is surfaced; the server never
// reverts silently (AC5).

import {
  EDITOR_PATCH_APPLY_SCHEMA_VERSION,
  parseEditorPatchApplyRequest,
  type EditorPatchApplyChangeCounts,
  type EditorPatchApplyEvidenceRefs,
  type EditorPatchApplyRejection,
  type EditorPatchApplyWireRequest,
  type EditorPatchApplyWireResponse,
  type EditorPatchRejectionReason,
  type EditorPatchRevertProposal,
  type EditorPatchVerificationSummary,
} from "@oscharko-dev/keiko-contracts";
import {
  applyPatch,
  buildRestorePatch,
  validatePatch,
  type PatchApplyResult,
  type PatchFileChange,
  type PatchRejection,
  type PatchValidation,
} from "@oscharko-dev/keiko-tools";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { readJsonObject, resolveRoot, runFilesHandler } from "../files.js";
import { clientAbortSignal } from "./languageRoutes.js";
import { recordPatchApplyEvidence, recordPatchVerificationEvidence } from "./patchApplyEvidence.js";
import {
  defaultPostApplyVerification,
  defaultPostApplyVerificationPreflight,
  skippedVerificationSummary,
  type PostApplyVerificationPreflightPort,
  type PostApplyVerificationPort,
} from "./postApplyVerification.js";

// A unified diff plus the apply envelope; bounded generously (validatePatch enforces the real patch
// byte/line/file limits). 2 MiB of body accommodates a large multi-file candidate diff.
const MAX_PATCH_APPLY_BODY_BYTES = 2 * 1_048_576;

// Gate A — surfaces editor-driven patch apply at all (default OFF: a wave-2 feature shipped switched off).
const PATCH_APPLY_POLICY_ENV = "KEIKO_EDITOR_PATCH_APPLY";
// Post-apply verification runs by DEFAULT; a deployment disables it only by setting this to a disable
// token (the other branch of AC: "skipped only when explicitly disabled by configured policy").
const PATCH_APPLY_VERIFICATION_ENV = "KEIKO_EDITOR_PATCH_APPLY_VERIFICATION";
const ENABLE_TOKENS: ReadonlySet<string> = new Set(["1", "true", "on", "yes", "enabled"]);
const DISABLE_TOKENS: ReadonlySet<string> = new Set(["0", "false", "off", "no", "disabled"]);

const DISABLED_REASON =
  "Editor-driven patch apply is disabled in this build. It is a wave-2 feature gated behind an enforced network-egress boundary (ADR-0042 D7).";
const DISABLED_PATCH_ID = "disabled";
const REJECTED_REASON = "The candidate patch was rejected; the workspace was not modified.";
const FAILED_REASON = "The patch could not be applied. The editor is still usable.";
const REVERT_REASON =
  "Post-apply verification failed. Review this revert proposal and apply it to restore the previous state; nothing was reverted automatically.";

/** Injectable options for the route (tests supply a deterministic verification port and a fixed clock). */
export interface EditorPatchApplyRouteOptions {
  readonly verification?: PostApplyVerificationPort | undefined;
  readonly verificationPreflight?: PostApplyVerificationPreflightPort | undefined;
  readonly now?: (() => number) | undefined;
}

function envToken(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim().toLowerCase();
}

/** Whether editor-driven patch apply is surfaced by deployment policy (Gate A; default off). */
export function isPatchApplyEnabledByPolicy(env: EnvSource | undefined): boolean {
  const token = envToken(env?.[PATCH_APPLY_POLICY_ENV]);
  return token !== undefined && ENABLE_TOKENS.has(token);
}

/** Whether post-apply verification runs (default on; off only when explicitly disabled by policy). */
export function isPatchApplyVerificationEnabledByPolicy(env: EnvSource | undefined): boolean {
  const token = envToken(env?.[PATCH_APPLY_VERIFICATION_ENV]);
  return token === undefined || !DISABLE_TOKENS.has(token);
}

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

// ─── Response builders ───────────────────────────────────────────────────────────────────────────

function disabledResponse(): EditorPatchApplyWireResponse {
  return {
    schemaVersion: EDITOR_PATCH_APPLY_SCHEMA_VERSION,
    status: "disabled",
    patchId: DISABLED_PATCH_ID,
    reason: DISABLED_REASON,
  };
}

function rejectedResponse(
  patchId: string,
  evidence: EditorPatchApplyEvidenceRefs,
): EditorPatchApplyWireResponse {
  return {
    schemaVersion: EDITOR_PATCH_APPLY_SCHEMA_VERSION,
    status: "rejected",
    patchId,
    reason: REJECTED_REASON,
    evidence,
  };
}

function conflictResponse(
  patchId: string,
  rejections: readonly EditorPatchApplyRejection[],
  evidence: EditorPatchApplyEvidenceRefs,
): EditorPatchApplyWireResponse {
  return {
    schemaVersion: EDITOR_PATCH_APPLY_SCHEMA_VERSION,
    status: "conflict",
    patchId,
    rejections,
    evidence,
  };
}

function failedResponse(
  patchId: string,
  evidence: EditorPatchApplyEvidenceRefs,
): EditorPatchApplyWireResponse {
  return {
    schemaVersion: EDITOR_PATCH_APPLY_SCHEMA_VERSION,
    status: "failed",
    patchId,
    reason: FAILED_REASON,
    evidence,
  };
}

// ─── Rejection mapping (PatchValidation → content-free editor rejections) ──────────────────────────

function mapRejectionReason(reason: PatchRejection): EditorPatchRejectionReason {
  if (reason.code === "path-unsafe" || reason.code === "path-denied") {
    return "out-of-scope";
  }
  if (reason.message.includes("does not contain any file changes")) {
    return "empty-patch";
  }
  return "invalid-patch";
}

function toRejections(validation: PatchValidation): readonly EditorPatchApplyRejection[] {
  const rejections: EditorPatchApplyRejection[] = [];
  for (const reason of validation.reasons) {
    rejections.push({
      reason: mapRejectionReason(reason),
      ...(reason.path === undefined ? {} : { path: reason.path }),
      detail: reason.message,
    });
  }
  for (const conflict of validation.conflicts) {
    rejections.push({
      reason:
        conflict.reason === "create target already exists" ? "would-overwrite" : "write-conflict",
      path: conflict.path,
      detail: conflict.reason,
    });
  }
  return rejections;
}

function changeCounts(result: PatchApplyResult): EditorPatchApplyChangeCounts {
  return {
    changedFiles: result.changedFiles.length,
    created: result.created.length,
    deleted: result.deleted.length,
  };
}

// The applied test files to verify: every changed file that was not deleted (deleted paths have no test
// to run). The generated candidate creates/rewrites test files, so these are the targeted-test inputs.
function verifiableFiles(result: PatchApplyResult): readonly string[] {
  const deleted = new Set(result.deleted);
  return result.changedFiles.filter((path) => !deleted.has(path));
}

function verifiableValidationFiles(files: readonly PatchFileChange[]): readonly string[] {
  return files.filter((file) => file.kind !== "delete").map((file) => file.path);
}

function buildRevertProposal(
  request: EditorPatchApplyWireRequest,
  restoreDiff: string,
  result: PatchApplyResult,
): EditorPatchRevertProposal | undefined {
  return {
    patchId: request.patchId,
    diff: restoreDiff,
    changedFiles: result.changedFiles,
    reason: REVERT_REASON,
  };
}

// ─── Apply handling ────────────────────────────────────────────────────────────────────────────────

interface ApplyContext {
  readonly request: EditorPatchApplyWireRequest;
  readonly deps: UiHandlerDeps;
  readonly realRoot: string;
  readonly signal: AbortSignal;
  readonly nowMs: number;
  readonly options: EditorPatchApplyRouteOptions;
}

async function runVerificationPhase(
  ctx: ApplyContext,
  result: PatchApplyResult,
): Promise<{ readonly summary: EditorPatchVerificationSummary; readonly command: string }> {
  if (!isPatchApplyVerificationEnabledByPolicy(ctx.deps.env)) {
    return { summary: skippedVerificationSummary(), command: "none" };
  }
  const port = ctx.options.verification ?? defaultPostApplyVerification;
  return port({
    realRoot: ctx.realRoot,
    appliedTestFiles: verifiableFiles(result),
    signal: ctx.signal,
  });
}

function conflictOutcome(
  ctx: ApplyContext,
  validation: PatchValidation,
): EditorPatchApplyWireResponse {
  const rejections = toRejections(validation);
  const applyRunId = recordPatchApplyEvidence(
    ctx.deps.evidenceStore,
    ctx.deps.redactor,
    {
      patchId: ctx.request.patchId,
      decision: "apply",
      status: "conflict",
      applied: false,
      rejections,
      allowOverwrite: ctx.request.allowOverwrite === true,
    },
    ctx.nowMs,
  );
  return conflictResponse(ctx.request.patchId, rejections, { applyRunId });
}

function failureOutcome(ctx: ApplyContext): EditorPatchApplyWireResponse {
  const applyRunId = recordPatchApplyEvidence(
    ctx.deps.evidenceStore,
    ctx.deps.redactor,
    {
      patchId: ctx.request.patchId,
      decision: "apply",
      status: "failed",
      applied: false,
      allowOverwrite: ctx.request.allowOverwrite === true,
    },
    ctx.nowMs,
  );
  return failedResponse(ctx.request.patchId, { applyRunId });
}

async function verificationPreflightOutcome(
  ctx: ApplyContext,
  validation: PatchValidation,
): Promise<EditorPatchApplyWireResponse | undefined> {
  if (!isPatchApplyVerificationEnabledByPolicy(ctx.deps.env)) {
    return undefined;
  }
  const port = ctx.options.verificationPreflight ?? defaultPostApplyVerificationPreflight;
  const preflight = await port({
    realRoot: ctx.realRoot,
    appliedTestFiles: verifiableValidationFiles(validation.files),
  });
  if (preflight.ok) {
    return undefined;
  }
  const applyRunId = recordPatchApplyEvidence(
    ctx.deps.evidenceStore,
    ctx.deps.redactor,
    {
      patchId: ctx.request.patchId,
      decision: "apply",
      status: "failed",
      applied: false,
      allowOverwrite: ctx.request.allowOverwrite === true,
    },
    ctx.nowMs,
  );
  const verificationRunId = recordPatchVerificationEvidence(
    ctx.deps.evidenceStore,
    ctx.deps.redactor,
    {
      patchId: ctx.request.patchId,
      rootRealPath: ctx.realRoot,
      command: preflight.command,
      summary: preflight.summary,
    },
    ctx.nowMs,
  );
  return failedResponse(ctx.request.patchId, { applyRunId, verificationRunId });
}

async function appliedOutcome(
  ctx: ApplyContext,
  result: PatchApplyResult,
  restoreDiff: string | undefined,
): Promise<EditorPatchApplyWireResponse> {
  const { request, deps, nowMs } = ctx;
  const counts = changeCounts(result);
  const applyRunId = recordPatchApplyEvidence(
    deps.evidenceStore,
    deps.redactor,
    {
      patchId: request.patchId,
      decision: "apply",
      status: "applied",
      applied: true,
      counts,
      allowOverwrite: request.allowOverwrite === true,
    },
    nowMs,
  );
  const { summary, command } = await runVerificationPhase(ctx, result);
  const verificationRunId = recordPatchVerificationEvidence(
    deps.evidenceStore,
    deps.redactor,
    { patchId: request.patchId, rootRealPath: ctx.realRoot, command, summary },
    nowMs,
  );
  const revertProposal =
    summary.outcome === "failed" && restoreDiff !== undefined
      ? buildRevertProposal(request, restoreDiff, result)
      : undefined;
  return {
    schemaVersion: EDITOR_PATCH_APPLY_SCHEMA_VERSION,
    status: "applied",
    patchId: request.patchId,
    applied: counts,
    verification: summary,
    ...(revertProposal === undefined ? {} : { revertProposal }),
    evidence: { applyRunId, verificationRunId },
  };
}

async function handleApply(ctx: ApplyContext): Promise<EditorPatchApplyWireResponse> {
  const allowOverwrite = ctx.request.allowOverwrite === true;
  const workspace = detectWorkspaceAt(ctx.realRoot, nodeWorkspaceFs);
  const validation = validatePatch(workspace, ctx.request.diff, { allowOverwrite });
  if (!validation.ok) {
    return conflictOutcome(ctx, validation);
  }
  const preflightResponse = await verificationPreflightOutcome(ctx, validation);
  if (preflightResponse !== undefined) {
    return preflightResponse;
  }
  let restoreDiff: string | undefined;
  try {
    restoreDiff = buildRestorePatch(workspace, validation.normalizedDiff ?? ctx.request.diff, {
      allowOverwrite,
    });
  } catch {
    return failureOutcome(ctx);
  }
  let result: PatchApplyResult;
  try {
    result = applyPatch(workspace, ctx.request.diff, {
      applyEnabled: true,
      signal: ctx.signal,
      allowOverwrite,
    });
  } catch {
    return failureOutcome(ctx);
  }
  return appliedOutcome(ctx, result, restoreDiff);
}

export async function handleEditorPatchApply(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  options: EditorPatchApplyRouteOptions = {},
): Promise<RouteResult> {
  // Gate A — default OFF: surface disabled without reading, parsing, validation, writes, or execution.
  if (!isPatchApplyEnabledByPolicy(deps.env)) {
    return { status: 200, body: deps.redactor(disabledResponse()) };
  }
  const body = await readJsonObject(ctx.req, MAX_PATCH_APPLY_BODY_BYTES);
  if (isRouteResult(body)) {
    return body;
  }
  const parsed = parseEditorPatchApplyRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  const request = parsed.value;
  return runFilesHandler(async () => {
    const root = await resolveRoot(deps.store, request.root, deps.redactor);
    const nowMs = (options.now ?? Date.now)();
    const signal = clientAbortSignal(ctx);
    if (request.decision === "reject") {
      const applyRunId = recordPatchApplyEvidence(
        deps.evidenceStore,
        deps.redactor,
        {
          patchId: request.patchId,
          decision: "reject",
          status: "rejected",
          applied: false,
          allowOverwrite: request.allowOverwrite === true,
        },
        nowMs,
      );
      return {
        status: 200,
        body: deps.redactor(rejectedResponse(request.patchId, { applyRunId })),
      };
    }
    const response = await handleApply({
      request,
      deps,
      realRoot: root.realRoot,
      signal,
      nowMs,
      options,
    });
    return { status: 200, body: deps.redactor(response) };
  });
}
