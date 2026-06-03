// PURE, security-critical lexical path containment. This module performs NO filesystem
// access: it decides whether a candidate path lexically resolves inside a workspace root.
// Symlink/realpath containment (which DOES touch the filesystem) is enforced separately at
// the IO edge in discovery.ts — see ADR-0005 D2 for the split.

import { isAbsolute, relative, resolve, sep } from "node:path";
import { PathEscapeError } from "./errors.js";

function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

// Returns the normalized absolute path of `candidate` inside `root`, or throws
// PathEscapeError. The returned value is the ONLY path that downstream IO should read, so
// a static analyser's path sanitizer sits on this boundary.
export function resolveWithinWorkspace(root: string, candidate: string): string {
  if (hasNul(root) || hasNul(candidate)) {
    throw new PathEscapeError("path contains a NUL byte", candidate);
  }
  const absoluteRoot = resolve(root);
  const absoluteCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(absoluteRoot, candidate);
  const rel = relative(absoluteRoot, absoluteCandidate);
  if (rel === "") {
    return absoluteRoot;
  }
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathEscapeError(`path escapes the workspace boundary: ${candidate}`, candidate);
  }
  return absoluteCandidate;
}

export function isWithinWorkspace(root: string, candidate: string): boolean {
  try {
    resolveWithinWorkspace(root, candidate);
    return true;
  } catch {
    return false;
  }
}
