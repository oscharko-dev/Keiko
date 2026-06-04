// ADR-0013 D6 — Path validation policy (fail-closed). Structural rules in one place; no path reaches
// the database without passing every check. Normalized absolute form is the only thing that returns.
//
// Issue #174 — cross-platform project roots. Native Windows drive paths (e.g. `C:\Users\Example`)
// are accepted as local project roots. Unsafe Windows shapes — UNC (`\\server\share`), device
// (`\\?\` / `\\.\`), traversal segments, null bytes, and remote URL forms — remain rejected.
// Shape classification is host-independent so unit tests pin every branch on any host OS.

import { isAbsolute, normalize, resolve as resolvePath, win32 as winPath } from "node:path";
import { statSync } from "node:fs";
import { invalidPath, pathNotDirectory, pathNotFound } from "./errors.js";

const MAX_PATH_LEN = 4096;
// scheme prefix per RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) "://"
const REMOTE_URL_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
// Device-namespace prefixes: `\\?\`, `\\.\`, `//?/`, `//./`. Reserved for raw device or extended
// length paths and never used for normal project roots.
const WINDOWS_DEVICE_PREFIX_RE = /^[\\/]{2}[?.][\\/]/;
// UNC (Universal Naming Convention) prefix: `\\<host>\<share>` or `//<host>/<share>`. The first
// character after the two separators is part of the host name and must not start a device prefix.
const WINDOWS_UNC_PREFIX_RE = /^[\\/]{2}[^\\/?.]/;
const TRAVERSAL_SEGMENT_RE = /(^|[\\/])\.\.(?:[\\/]|$)/;

export interface ValidateProjectPathOptions {
  readonly mustExist: boolean;
}

export type PathShape =
  | "posix-absolute"
  | "windows-drive"
  | "windows-unc"
  | "windows-device"
  | "relative";

// Pure, host-independent classifier. Inspects only the input string so the same call returns the
// same shape on Linux, macOS, and Windows hosts.
export function classifyPathShape(input: string): PathShape {
  if (WINDOWS_DEVICE_PREFIX_RE.test(input)) return "windows-device";
  if (WINDOWS_UNC_PREFIX_RE.test(input)) return "windows-unc";
  if (WINDOWS_DRIVE_RE.test(input)) return "windows-drive";
  if (input.startsWith("/")) return "posix-absolute";
  return "relative";
}

function rejectUnsafeShape(input: string, stage: "input" | "normalized"): void {
  const shape = classifyPathShape(input);
  if (shape === "windows-unc") {
    throw invalidPath(
      stage === "input"
        ? "Windows UNC paths are not supported."
        : "Windows UNC paths are not supported after normalization.",
    );
  }
  if (shape === "windows-device") {
    throw invalidPath(
      stage === "input"
        ? "Windows device paths are not supported."
        : "Windows device paths are not supported after normalization.",
    );
  }
}

function rejectTraversal(input: string): void {
  if (TRAVERSAL_SEGMENT_RE.test(input)) {
    throw invalidPath("Path contains a traversal segment.");
  }
}

function rejectStructural(input: string): PathShape {
  if (input.length === 0) throw invalidPath("Path is empty.");
  if (input.length > MAX_PATH_LEN) throw invalidPath("Path too long.");
  if (input.includes("\0")) throw invalidPath("Path contains a null byte.");
  const shape = classifyPathShape(input);
  // Windows drive paths with redundant forward slashes (for example `C://Users/Example`) match the
  // scheme-prefix regex even though they are valid local paths. Classify the shape first and skip
  // the remote-URL check for Windows drive shapes; other shapes still fail closed on `http://`,
  // `ssh://`, `file://`, and similar URL forms.
  if (shape !== "windows-drive" && REMOTE_URL_PREFIX_RE.test(input)) {
    throw invalidPath("Remote URL forms are not allowed.");
  }
  rejectUnsafeShape(input, "input");
  rejectTraversal(input);
  if (shape === "relative") throw invalidPath("Path must be absolute.");
  return shape;
}

function normalizeForShape(input: string, shape: PathShape): string {
  // Use the Windows path namespace for Windows drive paths so backslash separators and drive
  // letters normalize correctly on any host OS. POSIX-absolute paths use the OS-native namespace,
  // which on POSIX hosts is identical to `path.posix`.
  if (shape === "windows-drive") {
    const normalized = winPath.normalize(input);
    if (!winPath.isAbsolute(normalized)) {
      throw invalidPath("Path must be absolute after normalization.");
    }
    rejectUnsafeShape(normalized, "normalized");
    rejectTraversal(normalized);
    return normalized;
  }
  const normalized = normalize(input);
  const resolved = resolvePath(normalized);
  if (!isAbsolute(resolved)) {
    throw invalidPath("Path must be absolute after normalization.");
  }
  rejectUnsafeShape(resolved, "normalized");
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
  const shape = rejectStructural(input);
  const resolved = normalizeForShape(input, shape);
  if (options.mustExist) statAsDirectory(resolved);
  return resolved;
}
