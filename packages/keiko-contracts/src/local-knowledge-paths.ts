// Pure path-safety helpers for the Local Knowledge Connector validators (Epic #189,
// Issue #191). Extracted from `local-knowledge-validation.ts` to keep each file under the
// 400-LOC budget and to give downstream packages a single import target when they need to
// re-use the safe-path predicates at their own trust boundaries.
//
// Producers may pass either a workspace-relative path or an absolute path; the validator
// only rejects the most dangerous shapes: traversal segments, tilde expansion (which the
// shell would resolve to $HOME), NUL bytes, Windows-style drive letters and UNC prefixes,
// and the literal filesystem root markers. These helpers NEVER touch the filesystem.

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;
const ROOT_MARKERS = new Set<string>(["/", "\\", "~", "."]);

function hasTraversalSegment(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      return true;
    }
  }
  return false;
}

function isObviouslyUnsafeAbsoluteScope(path: string): boolean {
  if (path === "/" || path === "\\") {
    return true;
  }
  if (path.startsWith("~")) {
    return true;
  }
  if (path.startsWith("\\\\")) {
    return true;
  }
  return WINDOWS_DRIVE_RE.test(path) && path.length <= 3;
}

export function isSafeScopePath(path: string): boolean {
  if (path.length === 0) {
    return false;
  }
  if (path.includes("\0")) {
    return false;
  }
  if (ROOT_MARKERS.has(path)) {
    return false;
  }
  if (path.startsWith("~")) {
    return false;
  }
  if (isObviouslyUnsafeAbsoluteScope(path)) {
    return false;
  }
  return !hasTraversalSegment(path);
}

// Storage references live under Keiko's runtime-state directory and MUST stay relative.
// We refuse anything starting with `/`, `\`, a Windows drive prefix, a tilde, or anything
// containing `..` or NUL.
export function isSafeStorageReference(path: string): boolean {
  if (path.length === 0 || path.includes("\0")) {
    return false;
  }
  if (path.startsWith("/") || path.startsWith("\\") || path.startsWith("~")) {
    return false;
  }
  if (WINDOWS_DRIVE_RE.test(path)) {
    return false;
  }
  return !hasTraversalSegment(path);
}
