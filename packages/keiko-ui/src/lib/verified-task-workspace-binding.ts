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

export type VerifiedTaskWorkspaceBindResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly stage: "provision" | "verify" | "activate" };

export interface VerifiedTaskWorkspaceBindInput {
  readonly root: string;
  readonly taskId: string;
  readonly baseBranch: string;
  readonly requestedBy: string;
  readonly onProvisioned?: (() => void) | undefined;
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
  } catch {
    return { ok: false, stage: "provision" };
  }
  input.onProvisioned?.();
  try {
    const report = await reconcileTaskWorkspaces({ root: input.root });
    if (report.entries.find((entry) => entry.workspaceId === workspaceId)?.status !== "healthy") {
      return { ok: false, stage: "verify" };
    }
  } catch {
    return { ok: false, stage: "verify" };
  }
  try {
    await setActiveTaskWorkspace({ workspaceId, requestedBy: input.requestedBy });
    return { ok: true };
  } catch {
    return { ok: false, stage: "activate" };
  }
}
