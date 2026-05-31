// ADR-0013 D6 — Path validation policy (fail-closed). Seven rules in one place. NO path reaches the
// database without passing every check. Normalized absolute form is the only thing that returns.

import { isAbsolute, normalize, resolve as resolvePath } from "node:path";
import { statSync } from "node:fs";
import { invalidPath, pathNotDirectory, pathNotFound } from "./errors.js";

const MAX_PATH_LEN = 4096;
// scheme prefix per RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) "://"
const REMOTE_URL_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_TRAVERSAL_SEGMENT_RE = /(^|[\\/])\.\.(?:[\\/]|$)/;

export interface ValidateProjectPathOptions {
  readonly mustExist: boolean;
}

function isWindowsRootPath(input: string): boolean {
  return input.startsWith("\\\\") || input.startsWith("//");
}

function rejectWindowsPathShape(input: string): void {
  if (WINDOWS_DRIVE_RE.test(input) || isWindowsRootPath(input)) {
    throw invalidPath("Windows drive, UNC, and device paths are not supported.");
  }
}

function rejectTraversal(input: string): void {
  if (WINDOWS_TRAVERSAL_SEGMENT_RE.test(input)) {
    throw invalidPath("Path contains a traversal segment.");
  }
  // Pre-normalize traversal segment check (D6 rule 5): reject explicit `..` segments.
  if (input.includes("/../") || input.endsWith("/..") || input === "..") {
    throw invalidPath("Path contains a traversal segment.");
  }
}

function rejectStructural(input: string): void {
  if (input.length === 0) throw invalidPath("Path is empty.");
  if (input.length > MAX_PATH_LEN) throw invalidPath("Path too long.");
  if (input.includes("\0")) throw invalidPath("Path contains a null byte.");
  if (REMOTE_URL_PREFIX_RE.test(input)) throw invalidPath("Remote URL forms are not allowed.");
  rejectWindowsPathShape(input);
  rejectTraversal(input);
  if (!isAbsolute(input)) throw invalidPath("Path must be absolute.");
}

function normalizeOrReject(input: string): string {
  const normalized = normalize(input);
  const resolved = resolvePath(normalized);
  if (!isAbsolute(resolved)) throw invalidPath("Path must be absolute after normalization.");
  rejectWindowsPathShape(resolved);
  rejectTraversal(resolved);
  return resolved;
}

function statAsDirectory(resolved: string): void {
  let s: ReturnType<typeof statSync>;
  try {
    s = statSync(resolved);
  } catch {
    throw pathNotFound();
  }
  if (!s.isDirectory()) throw pathNotDirectory();
}

// Validates and normalizes a project path. Returns the canonical absolute path on success; throws a
// typed UiStoreError otherwise. When `mustExist` is false, the stat-as-directory step is skipped
// (PATCH/DELETE callers identify a project by its previously normalized path; the directory may
// have been deleted/moved since registration — that is reflected via derived availability).
export function validateProjectPath(input: string, options: ValidateProjectPathOptions): string {
  rejectStructural(input);
  const resolved = normalizeOrReject(input);
  if (options.mustExist) statAsDirectory(resolved);
  return resolved;
}
