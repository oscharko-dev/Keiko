/**
 * A task's managed worktree path: an internal run detail (`.keiko/.../task-workspaces/...`) that is
 * never repository truth. The single predicate every surface uses to recognise one, on POSIX and
 * Windows separators alike. Not to be confused with `isManagedTaskWorkspaceRoot` in
 * ManagedTaskWorkspaceGate, which asks whether a root is the active binding's.
 */
export function isManagedTaskWorktreePath(root: unknown): root is string {
  if (typeof root !== "string" || root.length === 0) return false;
  const normalized = root.replaceAll("\\", "/");
  return normalized.includes("/.keiko/") && normalized.includes("/task-workspaces/");
}
