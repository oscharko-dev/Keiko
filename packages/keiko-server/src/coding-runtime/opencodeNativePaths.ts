import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Path containment for the native OpenCode policy (#4271). A pathname is only a hint about the file
 * a tool reaches: a symbolic link inside the workspace can name a protected file or one outside it.
 * Every function here is either lexical (`workspaceRelative`) or answers for the physical location
 * (`physicalWorkspacePath`), and an errno other than "does not exist" is thrown to the caller, which
 * fails closed with the body-free `path-unresolvable` refusal instead of guessing.
 */

/** Workspace-relative POSIX path, or undefined when the resource points outside the workspace. */
export function workspaceRelative(resource: string, workspaceRoot: string): string | undefined {
  const candidate = resource.trim();
  if (candidate.includes("\0")) return undefined;
  const rel = isAbsolute(candidate) ? relative(workspaceRoot, candidate) : candidate;
  const posix = rel.split(sep).join("/");
  if (posix === "" || posix === ".") return "";
  if (isAbsolute(posix) || posix === ".." || posix.startsWith("../") || posix.startsWith("/"))
    return undefined;
  const segments = posix.split("/");
  if (segments.includes("..")) return undefined;
  return posix;
}

export type PhysicalWorkspacePath =
  { readonly kind: "inside"; readonly relative: string } | { readonly kind: "escape" };

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * The physical location of `path`: its realpath when it exists, otherwise the realpath of its
 * deepest existing ancestor plus the missing suffix. `undefined` when the missing part hangs off a
 * dangling symbolic link, because a write through it would create the file wherever it points.
 */
function physicalOrAncestor(path: string): string | undefined {
  let candidate = path;
  for (;;) {
    try {
      return join(realpathSync(candidate), relative(candidate, path));
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      if (isSymbolicLink(candidate)) return undefined;
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
}

function leavesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Where a path inside `root` physically is, relative to the root's own physical location. A path
 * whose resolution leaves the root (a symbolic link to `~/.ssh`, a directory link out of the tree)
 * or hangs off a dangling link is an escape. A root that does not exist holds no link, so the
 * lexical answer stands for it. Other errno values (a link loop, a name that is too long, no
 * permission) are thrown.
 */
export function physicalWorkspacePath(resource: string, root: string): PhysicalWorkspacePath {
  const contained = workspaceRelative(resource, root);
  if (contained === undefined) return { kind: "escape" };
  const absoluteRoot = resolve(root);
  const physicalRoot = physicalOrAncestor(absoluteRoot);
  const physical = physicalOrAncestor(resolve(absoluteRoot, contained));
  if (physicalRoot === undefined || physical === undefined) return { kind: "escape" };
  const rel = relative(physicalRoot, physical);
  if (leavesRoot(rel)) return { kind: "escape" };
  return { kind: "inside", relative: rel.split(sep).join("/") };
}

/**
 * Whether a shell argument names a place inside the workspace, lexically and physically. A leading
 * `~` is a home-directory expansion and never inside.
 */
export function pathInsideWorkspace(value: string, root: string): boolean {
  if (value.length === 0 || value.startsWith("~")) return false;
  return physicalWorkspacePath(value, root).kind === "inside";
}
