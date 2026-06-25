// Root-relative project-tree file-identifier contract (Issue #1374, Epic #1491). The Files
// browser and the agent-native editor exchange file identifiers with the BFF as ROOT-RELATIVE
// POSIX paths: `root` is an absolute machine path, and every `path` in the FilesTree* /
// FilesContent* / FilesWrite* wire shapes (see ./bff-wire) is interpreted relative to that root.
// Absolute paths are NEVER valid file identifiers — the BFF rejects them with 400 BAD_PATH
// ("The path must be relative to the selected root.", keiko-server/src/files.ts). This module is
// the single, tested place that turns a possibly-absolute candidate into a root-relative
// identifier (or a clear "outside-root" state), so the editor and the file tree can never hand an
// absolute path to the BFF and trigger the absolute-path editor load failure.
//
// Leaf-package rules (ADR-0019): pure string functions only. No filesystem, no clock, no crypto,
// no randomness, and no imports of other `@oscharko-dev/keiko-*` packages. The single in-package
// dependency is `isContainedAgentPath` (./editor-agent), the existing root-relative path guard the
// agent action surface already uses — reused here so ONE predicate defines what a contained,
// root-relative file identifier is across the editor surface (AC5: no new subsystem).

import { isContainedAgentPath } from "./editor-agent.js";

// A root-relative POSIX file identifier: no leading slash, no drive/UNC prefix, no `..` segment,
// no NUL — i.e. exactly what `isContainedAgentPath` accepts. The empty string is reserved for
// "no active file" and is intentionally NOT a valid identifier.
export type RootRelativeFileIdentifier = string;

// Outcome of resolving a candidate path against a workspace root.
export type WorkspaceFileIdentifierResolution =
  // No candidate was supplied — the editor has no active file.
  | { readonly kind: "empty" }
  // The candidate IS the workspace root itself — opening the root selects no file.
  | { readonly kind: "root" }
  // The candidate resolved to a root-relative identifier inside `root`.
  | { readonly kind: "relative"; readonly path: RootRelativeFileIdentifier }
  // The candidate is absolute (or a `..`-escaping relative path) and does not live under `root`.
  // `candidate` is the POSIX-normalized offending input, kept so callers can derive a containing
  // root (AC3) or render a clear non-blocking state (AC4).
  | { readonly kind: "outside-root"; readonly candidate: string };

// The {root, file} pair the editor should open for a candidate. `file` is "" when no file is
// selected (the editor renders its empty state without a failed load).
export interface WorkspaceFileTarget {
  readonly root: string;
  readonly file: RootRelativeFileIdentifier;
}

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/u;

// A path the BFF treats as absolute: POSIX root, Windows drive, UNC share, or `~` (which a shell
// expands to $HOME). Mirrors the server's rejection surface (files.ts normalizeRelativePath +
// resolveArbitraryRoot) so the client and server agree on what "absolute" means.
function isAbsoluteLike(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(path)
  );
}

// Backslash -> slash, collapse repeated slashes, strip a trailing slash. Pure lexical
// normalization shared by root and candidate so prefix comparison is stable across separators.
function toPosix(path: string): string {
  return path
    .replace(/\\/gu, "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/\/+$/u, "");
}

// When `child` is the workspace root return ""; when it is lexically nested under `root` return
// the root-relative remainder; otherwise return null. Matching is case-insensitive (preserving the
// editor's historic behavior and the common macOS/Windows case-insensitive filesystem), but the
// returned remainder keeps the candidate's original casing — only the prefix MATCH is folded.
function relativeUnderRoot(root: string, child: string): string | null {
  const normalizedRoot = toPosix(root);
  const normalizedChild = toPosix(child);
  if (normalizedRoot.length === 0) return null;
  const rootCmp = normalizedRoot.toLowerCase();
  const childCmp = normalizedChild.toLowerCase();
  if (childCmp === rootCmp) return "";
  if (childCmp.startsWith(`${rootCmp}/`)) return normalizedChild.slice(normalizedRoot.length + 1);
  return null;
}

// The single guard for "is this a valid, contained, root-relative file identifier?". Delegates to
// the agent-surface predicate so the editor file tree and agent actions share one definition.
export function isRootRelativeFileIdentifier(value: string): boolean {
  return isContainedAgentPath(value);
}

// Resolve an absolute candidate against the root: strip the root prefix when contained, flag the
// root itself, or report outside-root with the POSIX-normalized candidate.
function resolveAbsoluteCandidate(root: string, raw: string): WorkspaceFileIdentifierResolution {
  const remainder = relativeUnderRoot(root, raw);
  if (remainder === null) return { kind: "outside-root", candidate: toPosix(raw) };
  if (remainder.length === 0) return { kind: "root" };
  return isRootRelativeFileIdentifier(remainder)
    ? { kind: "relative", path: remainder }
    : { kind: "outside-root", candidate: toPosix(raw) };
}

// Resolve a candidate path (absolute or relative, any separator) against an absolute workspace
// root into the root-relative file-identifier contract. NEVER returns an absolute path.
export function resolveWorkspaceFileIdentifier(
  root: string,
  candidate: string | undefined,
): WorkspaceFileIdentifierResolution {
  const raw = candidate?.trim() ?? "";
  if (raw.length === 0) return { kind: "empty" };
  if (raw.includes("\u0000")) return { kind: "outside-root", candidate: toPosix(raw) };
  if (isAbsoluteLike(raw)) return resolveAbsoluteCandidate(root, raw);
  // Relative candidate: normalize separators and strip a single leading "./" before validating.
  const relative = toPosix(raw).replace(/^\.\//u, "");
  if (relative.length === 0) return { kind: "empty" };
  return isRootRelativeFileIdentifier(relative)
    ? { kind: "relative", path: relative }
    : { kind: "outside-root", candidate: relative };
}

// POSIX dirname for an already-`toPosix`-normalized absolute path. Returns "/" at the filesystem
// root and "" when the path has no separator.
function posixDirname(path: string): string {
  const index = path.lastIndexOf("/");
  if (index < 0) return "";
  return index === 0 ? "/" : path.slice(0, index);
}

// POSIX basename for an already-`toPosix`-normalized path.
function posixBasename(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

// Resolve the {root, file} pair the editor should open for a candidate path:
//   - a root-relative or absolute-inside-`root` candidate keeps the supplied root;
//   - a single ABSOLUTE file outside `root` selects its containing directory as the root and its
//     basename as the file (AC3: "selects a containing root");
//   - anything that cannot be turned into a contained root-relative file (no root, a `..`-escaping
//     relative path, a bare filename with no root) yields null so the caller renders a clear
//     non-blocking state (AC3/AC4) instead of sending an unusable path to the BFF.
export function selectWorkspaceFileTarget(
  root: string,
  candidate: string | undefined,
): WorkspaceFileTarget | null {
  const normalizedRoot = toPosix(root.trim());
  const resolution = resolveWorkspaceFileIdentifier(normalizedRoot, candidate);
  switch (resolution.kind) {
    case "relative":
      return normalizedRoot.length > 0 ? { root: normalizedRoot, file: resolution.path } : null;
    case "root":
    case "empty":
      return normalizedRoot.length > 0 ? { root: normalizedRoot, file: "" } : null;
    case "outside-root": {
      const offending = resolution.candidate;
      if (!isAbsoluteLike(offending)) return null;
      const containingRoot = posixDirname(offending);
      const file = posixBasename(offending);
      if (containingRoot.length === 0 || !isRootRelativeFileIdentifier(file)) return null;
      return { root: containingRoot, file };
    }
  }
}
