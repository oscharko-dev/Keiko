import { constants, accessSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

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

function executableNames(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly string[] {
  if (platform !== "win32") return ["git"];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => WINDOWS_EXECUTABLE_IMAGE_EXTENSIONS.has(extension));
  return ["git", ...extensions.map((extension) => `git${extension}`)];
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
  try {
    const real = realpathSync(candidate);
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

export function resolveGitExecutable(
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  groupIds: ReadonlySet<number> | undefined = activeGroupIds(),
): GitExecutableResolution {
  const names = executableNames(env, platform);
  let sawUntrusted = false;
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    for (const name of names) {
      const resolved = trustedCandidate(join(entry, name), cwd, platform, groupIds);
      if (resolved.ok) return resolved;
      if (resolved.reason === "untrusted-location") sawUntrusted = true;
    }
  }
  return { ok: false, reason: sawUntrusted ? "untrusted-location" : "not-found" };
}
