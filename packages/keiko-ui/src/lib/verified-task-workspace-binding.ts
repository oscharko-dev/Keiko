// Shared fail-closed task-workspace binding sequence.
//
// Provisioning creates the managed worktree but deliberately does not stamp a verified Git head.
// Runtime authority requires that stamp, so every UI path that creates and binds a workspace must
// reconcile it before activation. Keeping the sequence here prevents the global workspace switcher
// and the Coding Workbench setup from drifting into different trust postures.

import {
  provisionTaskWorkspace,
  reconcileTaskWorkspaces,
  setActiveTaskWorkspace,
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
