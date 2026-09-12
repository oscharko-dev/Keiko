import { forwardWorkspaceFs, type WorkspaceFs } from "./fs.js";
import type { WorkspaceInfo } from "./types.js";

const ownedWorkspaceRoots = new WeakMap<WorkspaceFs, string>();
// The WorkspaceInfo a prover hands out for a Keiko-owned root, bound to the owned-root port that
// proved it. Consumers that only ever receive the WorkspaceInfo — every git lane's deps, whose spawn
// boundary resolves its cwd through the user-workspace root rules — recover the port from here
// instead of re-admitting the root through rules that deny the state directory's `.keiko` segment.
const ownedRootWorkspaces = new WeakMap<WorkspaceInfo, WorkspaceFs>();

/** @internal The package subpath exposes the binder, never this capability marker. */
export function workspaceFsWithOwnedRootAuthority(
  fs: WorkspaceFs,
  canonicalRoot: string,
): WorkspaceFs {
  const authorized = forwardWorkspaceFs(fs);
  ownedWorkspaceRoots.set(authorized, canonicalRoot);
  return authorized;
}

export function preserveOwnedRootAuthority(source: WorkspaceFs, wrapper: WorkspaceFs): WorkspaceFs {
  const ownedRoot = ownedWorkspaceRoots.get(source);
  if (ownedRoot !== undefined) ownedWorkspaceRoots.set(wrapper, ownedRoot);
  return wrapper;
}

/** @internal Used only by the shared realpath admission boundary. */
export function ownedWorkspaceRootAuthority(fs: WorkspaceFs): string | undefined {
  return ownedWorkspaceRoots.get(fs);
}

/**
 * @internal Mint-side: binds the owned-root port to the WorkspaceInfo produced for exactly that
 * root. The port must already carry authority for `workspace.root`; a port minted for any other
 * root — or one without authority — is refused, so a binding can never widen what the prover
 * granted. The WorkspaceInfo is returned unchanged for call-site convenience.
 */
export function workspaceInfoWithOwnedRootAuthority(
  workspace: WorkspaceInfo,
  fs: WorkspaceFs,
): WorkspaceInfo {
  if (ownedWorkspaceRoots.get(fs) !== workspace.root) {
    throw new Error("owned-root authority does not name this workspace root");
  }
  ownedRootWorkspaces.set(workspace, fs);
  return workspace;
}

/** @internal The owned-root port bound to this WorkspaceInfo, or undefined for an ordinary root. */
export function ownedRootWorkspaceFs(workspace: WorkspaceInfo): WorkspaceFs | undefined {
  return ownedRootWorkspaces.get(workspace);
}
