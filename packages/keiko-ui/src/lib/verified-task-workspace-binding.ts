// Shared fail-closed task-workspace binding sequence.
//
// Provisioning creates the managed worktree but deliberately does not stamp a verified Git head.
// Runtime authority requires that stamp, so every UI path that creates and binds a workspace must
// reconcile it before activation. Keeping the sequence here prevents the global workspace switcher
// and the Coding Workbench setup from drifting into different trust postures.

import {
  getActiveTaskWorkspace,
  provisionTaskWorkspace,
  reconcileTaskWorkspaces,
  setActiveTaskWorkspace,
  type ActiveWorkspaceView,
} from "./task-workspace-api";
import { isWorkspaceFailureClass, type WorkspaceFailureClass } from "@oscharko-dev/keiko-contracts";

export type VerifiedTaskWorkspaceBindFailureReason = "branch-conflict";

export interface VerifiedTaskWorkspaceBindFailure {
  readonly ok: false;
  readonly stage: "provision" | "verify" | "activate";
  readonly reason?: VerifiedTaskWorkspaceBindFailureReason;
  readonly failureClass?: WorkspaceFailureClass;
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
  console.warn(`[keiko] task workspace bind ${stage} failed`, error);
}

function boundedBindFailure(
  stage: VerifiedTaskWorkspaceBindFailure["stage"],
  error: unknown,
): VerifiedTaskWorkspaceBindFailure {
  if (typeof error !== "object" || error === null) return { ok: false, stage };
  const candidate = error as { readonly code?: unknown; readonly failureClass?: unknown };
  if (candidate.code !== "BRANCH_CONFLICT" || !isWorkspaceFailureClass(candidate.failureClass)) {
    return { ok: false, stage };
  }
  return {
    ok: false,
    stage,
    reason: "branch-conflict",
    failureClass: candidate.failureClass,
  };
}

/**
 * Restore-time counterpart of {@link bindVerifiedTaskWorkspace} (release-audit F-09b).
 *
 * A persisted active pointer can outlive the verified state the runtime launch authority requires
 * (`lastVerifiedHead`, managed-root identity): after a browser reload the server may still expose
 * the binding while a coding-run start fails `authority-resolution-failed`. Restoring surfaces
 * therefore never claim a binding as-is — the active view is re-verified through the SAME #447
 * reconciliation pass the bind sequence gates on (which also re-stamps the verified head, so a
 * merely-stale binding is repaired rather than just reported).
 *
 * Fail-closed contract: when the verification verdict is non-healthy but the re-read view still
 * claims healthy, this throws instead of returning — a restored binding must never claim more
 * readiness than the verification pass granted. A view whose own persisted health already shows
 * the problem is returned so drifted worktrees stay visible in the session context (#1990).
 */
export async function restoreVerifiedActiveTaskWorkspace(): Promise<ActiveWorkspaceView | null> {
  const active = await getActiveTaskWorkspace();
  if (active === null) return null;
  const report = await reconcileTaskWorkspaces({ root: active.instance.repositoryRoot });
  // Re-read after the pass: reconciliation is the repair authority, so the settled view must be
  // the post-verification truth (fresh health, verified-head stamp, or a self-healed pointer).
  const reverified = await getActiveTaskWorkspace();
  if (reverified === null) return null;
  const entry = report.entries.find((item) => item.workspaceId === reverified.instance.workspaceId);
  if (entry?.status === "healthy" || reverified.instance.health !== "healthy") return reverified;
  warnBindStage("restore-verify", entry?.status ?? "missing-report-entry");
  throw new Error(
    "The active task workspace failed re-verification. Re-bind it before starting a coding run.",
  );
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
    return boundedBindFailure("provision", error);
  }
  try {
    // The notification hook must not break the always-resolves contract of this sequence.
    input.onProvisioned?.();
  } catch (error) {
    warnBindStage("provision-callback", error);
  }
  try {
    const report = await reconcileTaskWorkspaces({ root: input.root });
    if (report.entries.find((entry) => entry.workspaceId === workspaceId)?.status !== "healthy") {
      return { ok: false, stage: "verify" };
    }
  } catch (error) {
    warnBindStage("verify", error);
    return boundedBindFailure("verify", error);
  }
  try {
    await setActiveTaskWorkspace({ workspaceId, requestedBy: input.requestedBy });
    return { ok: true };
  } catch (error) {
    warnBindStage("activate", error);
    return boundedBindFailure("activate", error);
  }
}
