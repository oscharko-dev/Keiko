// The ONE trusted Windows system-directory decision, for every package that resolves a Windows
// system binary (PR #3354 review: "the whole class is not fixed for the trusted-System32
// decision").
//
// It lives in keiko-security rather than in keiko-tools because BOTH consumers must reach the same
// implementation and the dependency direction only allows one home: `keiko-tools` already depends
// on `keiko-security` (ADR-0019 — security depends on contracts alone, most domain packages depend
// on contracts + security), so the reverse import is impossible. Before this module there were two
// different answers to the same question: keiko-tools' hardened validator for `cmd.exe`/
// `taskkill.exe`, and an `isAbsolute`-only check in windows-shortcuts.ts feeding `cscript.exe` —
// and `isAbsolute` accepts `\\attacker\share`, `\\?\C:\Windows` and root-relative `\Windows`, the
// exact three shapes the hardened one rejects.
//
// Windows exposes the live OS root in the object-manager namespace as `\SystemRoot`. The Win32
// `\\?\GLOBALROOT` escape reaches that namespace without consulting process environment variables,
// drive mappings, the workspace, or PATH. On win32 this module compares the filesystem identity of
// an environment-selected candidate with that OS-owned reference and rejects a reparse anywhere in
// its resolved path. `resolveWindowsSystemDirectory` retains the conventional path only for a
// sanitized child environment; executable resolvers traverse the authoritative GLOBALROOT path.
// Shape and binary-existence checks remain defence in depth; identity is the trust decision.

import { lstatSync, realpathSync, statSync } from "node:fs";
import { win32 as win32Path } from "node:path";

/** Thrown when `SystemRoot`/`WINDIR` — or a requested binary name — fails canonical validation. */
export class WindowsSystemDirectoryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WindowsSystemDirectoryError";
  }
}

/** Thrown when a canonically resolved System32 binary is absent from the host image. */
export class WindowsSystemBinaryMissingError extends Error {
  public readonly code = "WINDOWS_SYSTEM_BINARY_MISSING" as const;

  public constructor() {
    super("resolved Windows system binary does not exist as a regular file");
    this.name = "WindowsSystemBinaryMissingError";
  }
}

export const DEFAULT_WINDOWS_SYSTEM_ROOT = String.raw`C:\Windows`;
const WINDOWS_OBJECT_MANAGER_SYSTEM_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot`;

// Drive-absolute only (`C:\...`). Deliberately excludes every other Windows path SHAPE that
// resolves against something other than one fixed drive letter: UNC (`\\server\share\...`) and
// device paths (`\\?\...`) resolve against a remote or reparsed namespace, root-relative
// (`\Windows`) resolves against the CURRENT drive, and bare-relative (`Windows`) resolves against
// the process cwd — the workspace, for a governed child-process helper. Each of those ambiguities
// is exactly the substitution this validation exists to reject.
const DRIVE_ABSOLUTE_WINDOWS_PATH = /^[A-Za-z]:\\/;

// The full C0 range plus DEL: a path override has no legitimate use for any control character, and
// CR/LF in particular would break a command line the resolved binary is spliced into.
// eslint-disable-next-line no-control-regex -- intentionally matches control chars to REJECT them
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

// cmd.exe's ONE authoritative metacharacter class for both the system-directory validator here and
// keiko-tools' command-line escaping. Exporting the source (rather than a stateful global RegExp)
// lets the downstream escaping pass add its own capture group and `g` flag without copying this
// security-sensitive character list by hand.
const CMD_METACHARACTER = /[()\][%!^"`<>&|;, *?]/u;
export const WINDOWS_CMD_METACHARACTER_SOURCE = CMD_METACHARACTER.source;

function hasPathTraversalSegment(candidate: string): boolean {
  return candidate.split(/[\\/]/).includes("..");
}

// NTFS "Alternate Data Stream" syntax (`path:stream`, optionally `:$DATA`) addresses a secondary
// stream on the file/directory rather than the directory itself. DRIVE_ABSOLUTE_WINDOWS_PATH only
// anchors the PREFIX (no `$` terminator) and CMD_METACHARACTER's class does not include `:` at
// all, so `C:\Windows:evil` passed both checks unmodified (PR #3354 review round 2). The
// drive-letter colon at index 1 is mandatory and already enforced by DRIVE_ABSOLUTE_WINDOWS_PATH
// above; searching from index 2 means that one is never flagged, while any OTHER colon always is.
function hasStreamColon(candidate: string): boolean {
  return candidate.includes(":", 2);
}

// Throws rather than falling back to the next candidate or to the default: an invalid override is
// a signal that the environment is misconfigured or hostile, and silently substituting a "safe"
// value would let that same environment defeat this check on a machine where the default itself
// has been tampered with. Silent fallback is precisely the weakness this replaces.
function assertCanonicalSystemRoot(candidate: string): void {
  if (CONTROL_CHARACTER.test(candidate)) {
    throw new WindowsSystemDirectoryError(
      "Windows system directory override must not contain a control character",
    );
  }
  if (!DRIVE_ABSOLUTE_WINDOWS_PATH.test(candidate)) {
    throw new WindowsSystemDirectoryError(
      String.raw`Windows system directory override must be a drive-absolute path, e.g. C:\Windows`,
    );
  }
  if (hasStreamColon(candidate)) {
    throw new WindowsSystemDirectoryError(
      "Windows system directory override must not contain a colon other than the drive letter's",
    );
  }
  if (hasPathTraversalSegment(candidate)) {
    throw new WindowsSystemDirectoryError(
      'Windows system directory override must not contain a ".." path segment',
    );
  }
  if (CMD_METACHARACTER.test(candidate)) {
    throw new WindowsSystemDirectoryError(
      "Windows system directory override must not contain a quote or cmd.exe metacharacter",
    );
  }
}

export type WindowsSystemDirectoryIdentityCheck = (
  candidate: string,
  authoritativeRoot: string,
) => boolean;

function comparableWindowsPath(path: string): string {
  const normalized = win32Path.normalize(path);
  const withoutLocalDevicePrefix = /^\\\\\?\\[A-Za-z]:\\/u.test(normalized)
    ? normalized.slice(4)
    : normalized;
  return withoutLocalDevicePrefix.replace(/\\+$/u, "").toLowerCase();
}

// Uses stable filesystem object identity rather than path text. BigInt stats avoid precision loss
// in Windows' 64-bit file index. lstat on the candidate deliberately rejects a final reparse point
// (Node reports NTFS junctions as symbolic links); stat then follows ordinary path resolution for
// the identity comparison. A host/filesystem that cannot supply non-zero identity fields fails
// closed instead of treating two unknown identities as equal.
export function sameWindowsSystemDirectoryIdentity(
  candidate: string,
  authoritativeRoot: string,
): boolean {
  try {
    const candidateLink = lstatSync(candidate, { bigint: true });
    if (!candidateLink.isDirectory() || candidateLink.isSymbolicLink()) return false;
    const candidateRealPath = realpathSync.native(candidate);
    // Reject reparses in ANY ancestor, not only a final junction. Otherwise
    // `C:\workspace\mutable-junction\Windows` can identify the real root during this check and be
    // retargeted to a planted System32 before a caller joins and spawns its binary.
    if (comparableWindowsPath(candidateRealPath) !== comparableWindowsPath(candidate)) return false;
    const candidateStats = statSync(candidateRealPath, { bigint: true });
    const authoritativeStats = statSync(authoritativeRoot, { bigint: true });
    return (
      authoritativeStats.isDirectory() &&
      candidateStats.dev !== 0n &&
      candidateStats.ino !== 0n &&
      candidateStats.dev === authoritativeStats.dev &&
      candidateStats.ino === authoritativeStats.ino
    );
  } catch {
    return false;
  }
}

function defaultSystemDirectoryIdentity(candidate: string, authoritativeRoot: string): boolean {
  if (process.platform !== "win32") return true;
  return sameWindowsSystemDirectoryIdentity(candidate, authoritativeRoot);
}

function assertSystemDirectoryIdentity(
  candidate: string,
  identityCheck: WindowsSystemDirectoryIdentityCheck,
): void {
  try {
    if (identityCheck(candidate, WINDOWS_OBJECT_MANAGER_SYSTEM_ROOT)) return;
  } catch {
    // Fall through to the same fail-closed typed error as a negative identity decision.
  }
  throw new WindowsSystemDirectoryError(
    "Windows system directory override does not identify the live OS system root",
  );
}

/**
 * The trusted Windows system directory: `SystemRoot`, then `WINDIR`, then the hard-coded default —
 * validated for canonical shape in every case. Every trusted Windows system-binary resolution in
 * the monorepo goes through this function or `resolveWindowsSystemBinary` below, rather than
 * re-deriving the environment fallback chain with a weaker check.
 */
export function resolveWindowsSystemDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
  identityCheck: WindowsSystemDirectoryIdentityCheck | undefined = defaultSystemDirectoryIdentity,
): string {
  const candidate = env.SystemRoot ?? env.WINDIR ?? DEFAULT_WINDOWS_SYSTEM_ROOT;
  assertCanonicalSystemRoot(candidate);
  assertSystemDirectoryIdentity(candidate, identityCheck);
  return candidate;
}

// Injectable so tests can exercise both the "missing"/"not a file" and the "present" branch
// hermetically on any host, and so a future caller can supply its own filesystem seam. Every
// current caller of `resolveWindowsSystemBinary` omits this (defaults to
// `defaultWindowsBinaryExists`) — no existing call site needs to change.
export type WindowsBinaryExistsCheck = (resolvedPath: string) => boolean;

// Checking here moves an absent System32 binary from a raw spawn-time ENOENT to a dedicated
// operational-missing type. It is gated on the platform genuinely being win32: on another host a
// Windows path is not meaningful, and hermetic callers inject the seam above. Directory identity
// has already been proven before this check runs; this final step classifies a missing/stripped
// system binary separately from an untrusted root.
function defaultWindowsBinaryExists(resolvedPath: string): boolean {
  if (process.platform !== "win32") return true;
  try {
    return statSync(resolvedPath).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function assertSafeSystemPathSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    /[\\/]/u.test(segment) ||
    CONTROL_CHARACTER.test(segment) ||
    CMD_METACHARACTER.test(segment) ||
    segment.includes(":")
  ) {
    throw new WindowsSystemDirectoryError(
      "Windows system executable segments must be bare names without control characters or command syntax",
    );
  }
}

/**
 * Resolve a fixed, literal executable path beneath the authenticated Windows root. This is the
 * nested counterpart to `resolveWindowsSystemBinary` for OS tools such as
 * `System32/WindowsPowerShell/v1.0/powershell.exe`. Every component is a bare segment, and the
 * production path is joined beneath the OS-owned GLOBALROOT namespace so the selected environment
 * path is never traversed again after identity validation.
 */
export function resolveWindowsSystemExecutable(
  segments: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  existsAsFile: WindowsBinaryExistsCheck | undefined = defaultWindowsBinaryExists,
  identityCheck: WindowsSystemDirectoryIdentityCheck | undefined = defaultSystemDirectoryIdentity,
): string {
  if (segments.length === 0) {
    throw new WindowsSystemDirectoryError(
      "Windows system executable path must contain at least one segment",
    );
  }
  for (const segment of segments) assertSafeSystemPathSegment(segment);
  const selectedRoot = resolveWindowsSystemDirectory(env, identityCheck);
  // The test identity port changes only the decision, never the path selected after acceptance.
  // Referential equality is not a trust boundary: a wrapper around the production checker must be
  // just as safe as the function itself. Every real win32 resolution therefore uses GLOBALROOT;
  // off-Windows hermetic tests retain their lexical Windows join.
  const executableRoot =
    process.platform === "win32" ? WINDOWS_OBJECT_MANAGER_SYSTEM_ROOT : selectedRoot;
  const resolved = win32Path.join(executableRoot, ...segments);
  if (!existsAsFile(resolved)) {
    throw new WindowsSystemBinaryMissingError();
  }
  return resolved;
}

/**
 * A named binary under the validated Windows system directory's `System32`, NEVER from PATH. The
 * name must be a bare file name: a caller that could pass a path could escape System32 entirely,
 * which is the containment this function exists to provide. On win32, the resolved path must also
 * exist as a regular file. A fabricated or reparsed root fails at the preceding identity boundary;
 * an authentic root whose binary is absent fails here instead of later as a raw spawn error.
 * `existsAsFile` and `identityCheck` are hermetic test seams.
 */
export function resolveWindowsSystemBinary(
  binaryName: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  existsAsFile: WindowsBinaryExistsCheck | undefined = defaultWindowsBinaryExists,
  identityCheck: WindowsSystemDirectoryIdentityCheck | undefined = defaultSystemDirectoryIdentity,
): string {
  if (binaryName.length === 0 || /[\\/]/.test(binaryName) || binaryName === "..") {
    throw new WindowsSystemDirectoryError(
      "binaryName must be a bare System32 file name, not a path",
    );
  }
  // The name is held to the SAME character rules as the directory it is joined onto, plus a colon
  // ban with no drive-letter exception: unlike the directory, a bare file name has no position at
  // which a colon is ever legitimate — one is always either invalid or NTFS alternate-data-stream
  // syntax. Every current caller passes a literal ("cmd.exe", "taskkill.exe", "cscript.exe"), so
  // this is defence in depth — but the returned string is spliced into a command line, and an
  // exported function whose stated purpose is containment must not depend on its callers staying
  // literal to be safe.
  if (
    CONTROL_CHARACTER.test(binaryName) ||
    CMD_METACHARACTER.test(binaryName) ||
    binaryName.includes(":")
  ) {
    throw new WindowsSystemDirectoryError(
      "binaryName must not contain a control character, quote, colon or cmd.exe metacharacter",
    );
  }
  return resolveWindowsSystemExecutable(["System32", binaryName], env, existsAsFile, identityCheck);
}
