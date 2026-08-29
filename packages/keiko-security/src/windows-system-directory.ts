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
// What it can and cannot promise: Node exposes no binding to `GetSystemDirectoryW`, the only
// OS-authoritative source, so this validates the SHAPE of an environment override — enough that a
// binary resolved under it can never land on a workspace-adjacent, PATH-adjacent, remote or
// reparsed path. It is not proof of live OS identity, and the residual is documented rather than
// papered over.

import { win32 as win32Path } from "node:path";

/** Thrown when `SystemRoot`/`WINDIR` — or a requested binary name — fails canonical validation. */
export class WindowsSystemDirectoryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WindowsSystemDirectoryError";
  }
}

export const DEFAULT_WINDOWS_SYSTEM_ROOT = String.raw`C:\Windows`;

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

// cmd.exe's metacharacter class. A system-directory override carrying one of these would be
// re-interpreted the moment the resolved path reaches a command line, so it is rejected at the
// source rather than escaped at each consumer.
const CMD_METACHARACTER = /[()\][%!^"`<>&|;, *?]/;

function hasPathTraversalSegment(candidate: string): boolean {
  return candidate.split(/[\\/]/).includes("..");
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

/**
 * The trusted Windows system directory: `SystemRoot`, then `WINDIR`, then the hard-coded default —
 * validated for canonical shape in every case. Every trusted Windows system-binary resolution in
 * the monorepo goes through this function or `resolveWindowsSystemBinary` below, rather than
 * re-deriving the environment fallback chain with a weaker check.
 */
export function resolveWindowsSystemDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const candidate = env.SystemRoot ?? env.WINDIR ?? DEFAULT_WINDOWS_SYSTEM_ROOT;
  assertCanonicalSystemRoot(candidate);
  return candidate;
}

/**
 * A named binary under the validated Windows system directory's `System32`, NEVER from PATH. The
 * name must be a bare file name: a caller that could pass a path could escape System32 entirely,
 * which is the containment this function exists to provide.
 */
export function resolveWindowsSystemBinary(
  binaryName: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (binaryName.length === 0 || /[\\/]/.test(binaryName) || binaryName === "..") {
    throw new WindowsSystemDirectoryError(
      "binaryName must be a bare System32 file name, not a path",
    );
  }
  // The name is held to the SAME character rules as the directory it is joined onto. Every current
  // caller passes a literal ("cmd.exe", "taskkill.exe", "cscript.exe"), so this is defence in
  // depth — but the returned string is spliced into a command line, and an exported function whose
  // stated purpose is containment must not depend on its callers staying literal to be safe.
  if (CONTROL_CHARACTER.test(binaryName) || CMD_METACHARACTER.test(binaryName)) {
    throw new WindowsSystemDirectoryError(
      "binaryName must not contain a control character, quote or cmd.exe metacharacter",
    );
  }
  return win32Path.join(resolveWindowsSystemDirectory(env), "System32", binaryName);
}
