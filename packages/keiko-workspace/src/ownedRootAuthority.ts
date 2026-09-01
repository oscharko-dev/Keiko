import { forwardWorkspaceFs, type WorkspaceFs } from "./fs.js";

const ownedWorkspaceRoots = new WeakMap<WorkspaceFs, string>();

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
