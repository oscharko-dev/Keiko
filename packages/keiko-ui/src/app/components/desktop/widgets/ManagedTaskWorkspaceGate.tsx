"use client";

import type { ReactNode } from "react";
import { useWorkspaceManifest, type WorkspaceManifestView } from "../hooks/useWorkspaceManifest";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import {
  ManagedTaskWorkspaceUnavailable,
  type ManagedTaskWorkspaceAccess,
} from "./cards/ManagedTaskWorkspaceUnavailable";

// One predicate for "this window targets the bound managed task-workspace root and the paired read
// authority is not confirmed", shared by the editor, Files and Git hosts (release-audit F-08, PR
// #3452 review) so no surface can disagree about when the managed root is presentable. The managed
// root lives under the deny-listed state area and is readable only through a launcher-paired app
// session (ADR-0141); when authority is missing the host renders the paired-session note instead of
// the raw denials.
export function managedTaskWorkspaceAccess(
  ctx: Pick<WindowRenderContext, "activeBinding">,
  targetRoot: string | undefined,
  workspace: Pick<WorkspaceManifestView, "pathReadAuthority">,
): ManagedTaskWorkspaceAccess | null {
  return ctx.activeBinding !== null &&
    targetRoot === ctx.activeBinding.activeRoot &&
    workspace.pathReadAuthority !== "available"
    ? workspace.pathReadAuthority
    : null;
}

/**
 * Renders a window's content only while its root is presentable. On the bound managed task-workspace
 * root without paired read authority it renders the paired-session note instead, as the editor and
 * Files hosts do; the workspace answer is read again on a re-pair (F65), which lifts it.
 */
export function ManagedTaskWorkspaceGate({
  ctx,
  root,
  children,
}: {
  readonly ctx: Pick<WindowRenderContext, "activeBinding">;
  readonly root: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const workspace = useWorkspaceManifest(root);
  const access = managedTaskWorkspaceAccess(ctx, root, workspace);
  if (access === null) return children;
  return (
    <ManagedTaskWorkspaceUnavailable access={access} onRetry={() => void workspace.refresh()} />
  );
}
