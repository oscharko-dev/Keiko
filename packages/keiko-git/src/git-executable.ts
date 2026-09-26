import { constants, accessSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, relative } from "node:path";

const GROUP_WRITE_BIT = 0o020;
const WORLD_WRITE_BIT = 0o002;

// KEIKO-0263: the resolver used to collapse "no git on PATH" and "found a candidate but it lives
// in an untrusted location (workspace-contained OR group/world-writable)" into a bare undefined.
// The runner mapped that bare undefined to a generic exit-127 "git executable unavailable"
// result — losing the planted-binary indicator that operators need to tell "install git" apart
// from "PATH has been salted". The discriminated union below keeps the two apart at the boundary
// while remaining fully redacted (no filesystem path leaves this module).
export type GitExecutableResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "not-found" | "untrusted-location" };

type TrustedCandidateResult =
  | { readonly ok: true; readonly path: string }
  // Distinguished so the outer loop can keep hunting past an ENOENT while still remembering that
  // it rejected an actual candidate for security reasons — the first "untrusted" verdict wins
  // over the fall-through "not-found".
  | { readonly ok: false; readonly reason: "not-found" | "untrusted-location" };

// Only REAL executable images are accepted as `git`, even when PATHEXT offers script extensions.
// Two independent reasons, either of which is sufficient:
//
//  1. A scripted git CANNOT be launched from here anyway. `runner.ts` spawns the resolved path with
//     `shell: false`, and since the fix for CVE-2024-27980 (Node 20.12 / 18.20) that raises EINVAL
//     for `.cmd`/`.bat` on Windows. Resolving one therefore never produced a working git — only a
//     cryptic spawn failure in place of an honest "git is not installed".
//  2. A scripted git SHOULD NOT be launched from here. A `git.bat` earlier on PATH than the real
//     git is arbitrary code wearing a trusted name — precisely the PATH-salting this resolver's
//     containment and writability checks exist to catch. keiko-git is a deliberate leaf (ADR-0019
//     direction rule 2b: keiko-contracts only), so it cannot reach the hardened cmd.exe wrapper in
//     keiko-tools that would be needed to launch one safely.
//
// Widening this set therefore requires BOTH a safe launch path and a reason to trust a scripted
// git — not just an entry in PATHEXT.
const WINDOWS_EXECUTABLE_IMAGE_EXTENSIONS = new Set([".com", ".exe"]);

// T43 (PR #3355 review, diagnostic fidelity only): the two extensions filtered OUT of
// WINDOWS_EXECUTABLE_IMAGE_EXTENSIONS above are never spawned and never returned as `ok: true` —
// see the class comment. They are still checked, separately, so a `git.bat`/`git.cmd` planted in an
// untrusted location does not silently collapse the operator-facing signal from "untrusted-location"
// down to a bare "not-found" (KEIKO-0263 built the discriminated union specifically to keep those
// apart). Security is unaffected either way.
const WINDOWS_SCRIPT_EXTENSIONS = new Set([".bat", ".cmd"]);

// T23 (PR #3355 review): a bare, extensionless `git` was previously probed FIRST on win32, even
// though only `.com`/`.exe` images are ever trusted. `fs.constants.X_OK` is documented as behaving
// like a plain existence check on Windows, so a directory or a non-image file named exactly `git`
// (no extension) would satisfy it and be returned as "the" git executable before `git.com`/`git.exe`
// were ever tried. On win32 the candidate list now carries ONLY the filtered, suffixed image names —
// never the bare name — closing that ordering entirely rather than relying on a later check to catch
// what should never have been a candidate.
function windowsExtensionCandidates(
  env: NodeJS.ProcessEnv,
  extensions: ReadonlySet<string>,
): readonly string[] {
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extensions.has(extension))
    .map((extension) => `git${extension}`);
}

function executableNames(platform: NodeJS.Platform): readonly string[] {
  if (platform !== "win32") return ["git"];
  // PATHEXT is environment-controlled and therefore cannot define the closed set of executable
  // image formats this trust boundary accepts. Probe both approved images directly; PATHEXT remains
  // relevant only to the diagnostic-only script scan below.
  return [...WINDOWS_EXECUTABLE_IMAGE_EXTENSIONS].map((extension) => `git${extension}`);
}

// Diagnostic-only counterpart of executableNames: names that are NEVER trusted (see
// WINDOWS_SCRIPT_EXTENSIONS above), probed solely to decide whether a failed resolution should
// report "untrusted-location" instead of "not-found" (T43). Empty off win32, where the extension
// distinction does not exist.
function windowsScriptNames(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly string[] {
  if (platform !== "win32") return [];
  return windowsExtensionCandidates(env, WINDOWS_SCRIPT_EXTENSIONS);
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function activeGroupIds(): ReadonlySet<number> | undefined {
  if (typeof process.getgroups !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return new Set([process.getgid(), ...process.getgroups()]);
}

function isWritableByCaller(path: string, groupIds: ReadonlySet<number> | undefined): boolean {
  const stats = statSync(path);
  if ((stats.mode & WORLD_WRITE_BIT) !== 0) return true;
  return (
    (stats.mode & GROUP_WRITE_BIT) !== 0 && (groupIds === undefined || groupIds.has(stats.gid))
  );
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function hasTrustedWindowsImageExtension(path: string): boolean {
  return WINDOWS_EXECUTABLE_IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

// T23: true when a candidate that CLAIMS to be a trusted image (its own name ends in `.com`/`.exe`)
// resolves, via a reparse point, to something that is not. Extracted to its own predicate so the
// extension allow-list only constrains what the NAME promised, never a legitimate script
// candidate's own real extension — T43's `hasUntrustedWindowsScript` deliberately runs `.bat`/
// `.cmd` candidates through the same `trustedCandidate`, and their real extension is expected and
// legitimate to stay a script.
function isTamperedWindowsImageTarget(
  candidate: string,
  real: string,
  platform: NodeJS.Platform,
): boolean {
  return (
    platform === "win32" &&
    hasTrustedWindowsImageExtension(candidate) &&
    !hasTrustedWindowsImageExtension(real)
  );
}

function trustedCandidate(
  candidate: string,
  cwd: string,
  platform: NodeJS.Platform,
  groupIds: ReadonlySet<number> | undefined,
): TrustedCandidateResult {
  try {
    accessSync(candidate, constants.X_OK);
  } catch {
    // The most common shape: this PATH entry does not carry a git executable. Keep looking.
    return { ok: false, reason: "not-found" };
  }
  // `X_OK` does not establish regular-file-ness on either platform family: Windows treats it as an
  // existence check, while POSIX accepts a searchable directory. Require a regular file before any
  // trust classification so a directory/non-file decoy is simply not a candidate — the same
  // redacted `not-found` verdict as an absent executable, not a false planted-binary signal.
  if (!isRegularFile(candidate)) {
    return { ok: false, reason: "not-found" };
  }
  // Reject the PATH-selected spelling before following any symlink/reparse chain. Checking only
  // the final real path lets a workspace-controlled `<workspace>/bin/git` point at an otherwise
  // trusted external image and escape the workspace check by resolution. The second, resolved
  // containment check below remains necessary for the inverse shape: an external spelling whose
  // target enters the workspace.
  if (isContained(cwd, candidate)) {
    return { ok: false, reason: "untrusted-location" };
  }
  try {
    const real = realpathSync(candidate);
    // T23: a reparse point (symlink/junction) can resolve `candidate` to an entirely different file
    // than its name promised. The extension allow-list above only constrains the CANDIDATE's name;
    // without this, `git.exe` reparsed to an arbitrary `.bat`/no-extension target would resolve and
    // be RETURNED as trusted git, defeating the whole extension claim. Regular-file-ness of `real`
    // is already implied by the pre-realpath check above (`statSync` on `candidate` follows the
    // same reparse chain), so only the extension needs revalidating here — and unlike the
    // pre-realpath check, a wrong-extension target is a tampering signal, not a simple absence.
    if (isTamperedWindowsImageTarget(candidate, real, platform)) {
      return { ok: false, reason: "untrusted-location" };
    }
    if (isContained(realpathSync(cwd), real)) {
      return { ok: false, reason: "untrusted-location" };
    }
    if (platform !== "win32") {
      const protectedPaths = [dirname(candidate), real, dirname(real)];
      if (protectedPaths.some((path) => isWritableByCaller(path, groupIds))) {
        return { ok: false, reason: "untrusted-location" };
      }
    }
    return { ok: true, path: real };
  } catch {
    // realpath/stat threw on a candidate that was executable a moment ago: treat as not-found so
    // the outer loop keeps scanning; a truly hostile disappearing entry cannot then hide behind
    // an "untrusted-location" verdict.
    return { ok: false, reason: "not-found" };
  }
}

// T43: probes the never-trusted script extensions purely for diagnostic fidelity. A script match is
// NEVER returned as `ok: true` (`resolveGitExecutable` below only reads the `untrusted-location`
// signal from this function's result) — only whether it fails the SAME location trust checks an
// image candidate would. A script sitting in an otherwise-trusted location is not itself suspicious
// (a legitimate wrapper, or simply nothing to do with git) and is silently ignored, matching the
// "still resolves git.exe when a git.cmd sits beside it" contract; only a script that would ALSO
// have failed as an image (workspace-contained, or — off win32, where extensions are irrelevant so
// windowsScriptNames is empty and this loop never runs — writable) upgrades the final verdict.
function hasUntrustedWindowsScript(
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
  groupIds: ReadonlySet<number> | undefined,
): boolean {
  const scriptNames = windowsScriptNames(env, platform);
  if (scriptNames.length === 0) return false;
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    for (const name of scriptNames) {
      const resolved = trustedCandidate(join(entry, name), cwd, platform, groupIds);
      if (!resolved.ok && resolved.reason === "untrusted-location") return true;
    }
  }
  return false;
}

type ImageScanResult =
  | { readonly found: true; readonly resolution: TrustedCandidateResult & { readonly ok: true } }
  | { readonly found: false; readonly sawUntrusted: boolean };

// Extracted from resolveGitExecutable so the outer function stays a thin dispatcher (complexity):
// scans every PATH entry for a trusted image, stopping at the first one found.
function scanForTrustedImage(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
  groupIds: ReadonlySet<number> | undefined,
): ImageScanResult {
  let sawUntrusted = false;
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    for (const name of names) {
      const resolved = trustedCandidate(join(entry, name), cwd, platform, groupIds);
      if (resolved.ok) return { found: true, resolution: resolved };
      if (resolved.reason === "untrusted-location") sawUntrusted = true;
    }
  }
  return { found: false, sawUntrusted };
}

export function resolveGitExecutable(
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  groupIds: ReadonlySet<number> | undefined = activeGroupIds(),
): GitExecutableResolution {
  const scan = scanForTrustedImage(executableNames(platform), env, cwd, platform, groupIds);
  if (scan.found) return scan.resolution;
  const sawUntrusted = scan.sawUntrusted || hasUntrustedWindowsScript(env, cwd, platform, groupIds);
  return { ok: false, reason: sawUntrusted ? "untrusted-location" : "not-found" };
}
