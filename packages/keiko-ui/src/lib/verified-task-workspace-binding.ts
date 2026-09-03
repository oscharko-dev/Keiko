// Shared fail-closed task-workspace binding sequence.
//
// Provisioning creates the managed worktree but deliberately does not stamp a verified Git head.
// Runtime authority requires that stamp, so every UI path that creates and binds a workspace must
// reconcile it before activation. Keeping the sequence here prevents the global workspace switcher
// and the Coding Workbench setup from drifting into different trust postures.

import {
  getActiveTaskWorkspace,
  listTaskWorkspaces,
  provisionTaskWorkspace,
  reconcileTaskWorkspaces,
  repairTaskWorkspace,
  setActiveTaskWorkspace,
  type ActiveWorkspaceView,
} from "./task-workspace-api";
import type {
  TaskWorkspaceDriftMarker,
  WorkspaceFailureClass,
  WorkspaceInstance,
  WorkspaceRecoveryStrategy,
} from "@oscharko-dev/keiko-contracts";
import {
  isAutomaticWorkspaceRepairStrategy,
  isWorkspaceFailureClass,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";
import { reportClientDiagnostic } from "./client-diagnostics";

export type VerifiedTaskWorkspaceBindFailureReason = "branch-conflict";

export type VerifiedTaskWorkspaceBindStage = "provision" | "verify" | "activate" | "repair";

/**
 * What the server refused to bind and what it can do about it. Provisioning refuses an existing
 * managed workspace whose identity it cannot re-prove (POINTER_DRIFT, failure class `repairable`)
 * and persists the classified markers and recovery hints on that row; this carries them to the
 * surface so the operator sees the actual finding and the executable exit, instead of a sentence
 * about the repository path. `strategy` is the first hint the #447 repair service applies under
 * operator approval, or null when every hint needs a human first.
 */
export interface VerifiedTaskWorkspaceRepairOffer {
  readonly workspaceId: string;
  readonly driftMarkers: readonly TaskWorkspaceDriftMarker[];
  readonly strategy: WorkspaceRecoveryStrategy | null;
}

export interface VerifiedTaskWorkspaceBindFailure {
  readonly ok: false;
  readonly stage: VerifiedTaskWorkspaceBindStage;
  // The server's structured task-workspace error code, when the failure carried one.
  readonly code?: string;
  readonly reason?: VerifiedTaskWorkspaceBindFailureReason;
  readonly failureClass?: WorkspaceFailureClass;
  readonly repair?: VerifiedTaskWorkspaceRepairOffer;
}

export type VerifiedTaskWorkspaceBindResult =
  { readonly ok: true } | VerifiedTaskWorkspaceBindFailure;

export interface VerifiedTaskWorkspaceBindInput {
  readonly root: string;
  readonly taskId: string;
  readonly baseBranch: string;
  readonly requestedBy: string;
  readonly onProvisioned?: (() => void) | undefined;
}

// Same bounded console idiom as GEN-STAB-WINDOW-002: the caller-visible result stays the
// sanitized stage label, but the underlying failure remains diagnosable in the local console.
function warnBindStage(stage: string, error: unknown): void {
  reportClientDiagnostic(
    `[keiko] task workspace bind ${stage} failed: ${clientErrorSummary(error)}`,
    {
      correlationId: correlationIdOf(error),
    },
  );
}

// The caller-visible shape of a failure: the stage, the server's code when it sent one, and the
// failure class + branch-conflict reason only when the class is one of the contract's own values
// (an unknown class carries no meaning the surface may act on).
function boundedBindFailure(
  stage: VerifiedTaskWorkspaceBindStage,
  error: unknown,
): VerifiedTaskWorkspaceBindFailure {
  if (typeof error !== "object" || error === null) return { ok: false, stage };
  const candidate = error as { readonly code?: unknown; readonly failureClass?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  if (!isWorkspaceFailureClass(candidate.failureClass)) {
    return code === undefined ? { ok: false, stage } : { ok: false, stage, code };
  }
  return {
    ok: false,
    stage,
    ...(code === undefined ? {} : { code }),
    ...(code === "BRANCH_CONFLICT" ? { reason: "branch-conflict" as const } : {}),
    failureClass: candidate.failureClass,
  };
}

function automaticStrategyOf(instance: WorkspaceInstance): WorkspaceRecoveryStrategy | null {
  const hint = instance.recoveryHints.find(
    (candidate) =>
      !candidate.operatorActionRequired && isAutomaticWorkspaceRepairStrategy(candidate.strategy),
  );
  return hint?.strategy ?? null;
}

// A refused provision names no workspace, but the row it refused is the one persisted for this
// (repository, task) pair, so the inventory the switcher already lists resolves it. A lookup that
// fails leaves the failure without an offer — the surface then shows the finding without a button
// — and is diagnosable in the console like every other stage.
async function repairOfferFor(
  root: string,
  taskId: string,
): Promise<VerifiedTaskWorkspaceRepairOffer | undefined> {
  try {
    const instance = (await listTaskWorkspaces(root)).find((item) => item.taskId === taskId);
    if (instance === undefined) return undefined;
    return {
      workspaceId: instance.workspaceId,
      driftMarkers: instance.driftMarkers,
      strategy: automaticStrategyOf(instance),
    };
  } catch (error) {
    warnBindStage("repair-lookup", error);
    return undefined;
  }
}

// Reconcile, then activate only a workspace the pass reports healthy. Shared by the first bind and
// the post-repair bind so the two cannot drift into different trust postures.
async function verifyAndActivate(
  root: string,
  workspaceId: string,
  requestedBy: string,
): Promise<VerifiedTaskWorkspaceBindResult> {
  try {
    const report = await reconcileTaskWorkspaces({ root });
    if (report.entries.find((entry) => entry.workspaceId === workspaceId)?.status !== "healthy") {
      return { ok: false, stage: "verify" };
    }
  } catch (error) {
    warnBindStage("verify", error);
    return boundedBindFailure("verify", error);
  }
  try {
    await setActiveTaskWorkspace({ workspaceId, requestedBy });
    return { ok: true };
  } catch (error) {
    warnBindStage("activate", error);
    return boundedBindFailure("activate", error);
  }
}

export interface RestoreVerifiedActiveTaskWorkspaceOptions {
  /**
   * The workspace identity whose restore verification the caller already holds for this session, or
   * `null`/absent when it holds none. Only an active view resolving to exactly this identity skips
   * the reconciliation pass; every other identity is verified again.
   */
  readonly verifiedWorkspaceId?: string | null;
}

/**
 * Restore-time counterpart of {@link bindVerifiedTaskWorkspace} (release-audit F-09b).
 *
 * A persisted active pointer can outlive the verified state the runtime launch authority requires
 * (`lastVerifiedHead`, managed-root identity): after a browser reload the server may still expose
 * a stale binding. Restoring surfaces therefore never claim a binding as-is — the active view is
 * re-verified through the SAME #447 reconciliation pass the bind sequence gates on (which also
 * re-stamps the verified head, so a merely-stale binding is repaired rather than just reported).
 *
 * Fail-closed contract: when the verification verdict is non-healthy but the re-read view still
 * claims healthy, this throws instead of returning — a restored binding must never claim more
 * readiness than the verification pass granted. A view whose own persisted health already shows
 * the problem is returned so drifted worktrees stay visible in the session context (#1990).
 *
 * The pass may be skipped for ONE workspace identity only: the caller passes the id whose
 * verification it already holds, and a re-read that still resolves to that same identity is
 * returned unverified. Anything else — a first read, a different active workspace, or a pointer
 * that moved — runs the full pass, because activating a binding is not verifying it
 * (`setActiveTaskWorkspace` does not reconcile). Scoping the skip to the identity, not to the
 * session, is what keeps repeated reloads of one workspace cheap without letting a later
 * activation claim a binding this pass never granted.
 */
export async function restoreVerifiedActiveTaskWorkspace(
  options: RestoreVerifiedActiveTaskWorkspaceOptions = {},
): Promise<ActiveWorkspaceView | null> {
  const active = await getActiveTaskWorkspace();
  if (active === null) return null;
  if (active.instance.workspaceId === options.verifiedWorkspaceId) return active;
  const report = await reconcileTaskWorkspaces({ root: active.instance.repositoryRoot });
  // Re-read after the pass: reconciliation is the repair authority, so the settled view must be
  // the post-verification truth (fresh health, verified-head stamp, or a self-healed pointer).
  const reverified = await getActiveTaskWorkspace();
  if (reverified === null) return null;
  const entry = report.entries.find((item) => item.workspaceId === reverified.instance.workspaceId);
  if (entry?.status === "healthy" || reverified.instance.health !== "healthy") return reverified;
  // The verdict is a closed, content-free status (never an Error), so it is logged as itself: the
  // one fact an operator needs from this line is WHICH status refused the restored binding.
  reportClientDiagnostic(
    `[keiko] task workspace bind restore-verify failed: status=${entry?.status ?? "missing-report-entry"}`,
  );
  throw new TaskWorkspaceRestoreVerificationError();
}

// Typed sentinel so UI surfaces can map the failure to the i18n API instead of rendering this
// developer-facing fallback text verbatim (the message is a non-localized safety net only).
export class TaskWorkspaceRestoreVerificationError extends Error {
  public constructor() {
    super("The active task workspace failed re-verification. Re-bind it before starting a run.");
    this.name = "TaskWorkspaceRestoreVerificationError";
  }
}

export async function bindVerifiedTaskWorkspace(
  input: VerifiedTaskWorkspaceBindInput,
): Promise<VerifiedTaskWorkspaceBindResult> {
  let workspaceId: string;
  try {
    const provisioned = await provisionTaskWorkspace({
      root: input.root,
      taskId: input.taskId,
      baseBranch: input.baseBranch,
      requestedBy: input.requestedBy,
    });
    workspaceId = provisioned.instance.workspaceId;
  } catch (error) {
    warnBindStage("provision", error);
    const failure = boundedBindFailure("provision", error);
    if (failure.code !== "POINTER_DRIFT") return failure;
    const repair = await repairOfferFor(input.root, input.taskId);
    return repair === undefined ? failure : { ...failure, repair };
  }
  try {
    // The notification hook must not break the always-resolves contract of this sequence.
    input.onProvisioned?.();
  } catch (error) {
    warnBindStage("provision-callback", error);
  }
  return verifyAndActivate(input.root, workspaceId, input.requestedBy);
}

export interface VerifiedTaskWorkspaceRepairInput {
  readonly root: string;
  readonly workspaceId: string;
  readonly strategy: WorkspaceRecoveryStrategy;
  readonly requestedBy: string;
  readonly onRepaired?: (() => void) | undefined;
}

/**
 * The operator-approved counterpart of {@link bindVerifiedTaskWorkspace} for a workspace the
 * provision refused: apply the offered recovery strategy through the #447 repair route (the call
 * carries the operator's explicit approval), then run the SAME verify-then-activate sequence a
 * fresh bind runs — a repaired workspace is never activated on the repair's word alone.
 */
export async function repairAndBindVerifiedTaskWorkspace(
  input: VerifiedTaskWorkspaceRepairInput,
): Promise<VerifiedTaskWorkspaceBindResult> {
  try {
    const result = await repairTaskWorkspace({
      workspaceId: input.workspaceId,
      requestedBy: input.requestedBy,
      strategy: input.strategy,
      operatorApproved: true,
    });
    if (!result.applied) {
      return {
        ok: false,
        stage: "repair",
        repair: {
          workspaceId: input.workspaceId,
          driftMarkers: result.driftMarkers,
          strategy: null,
        },
      };
    }
  } catch (error) {
    warnBindStage("repair", error);
    return boundedBindFailure("repair", error);
  }
  try {
    input.onRepaired?.();
  } catch (error) {
    warnBindStage("repair-callback", error);
  }
  return verifyAndActivate(input.root, input.workspaceId, input.requestedBy);
}
