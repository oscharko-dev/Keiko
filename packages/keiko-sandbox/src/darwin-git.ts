import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse } from "node:path";

export interface AttestedDarwinGitExecutable {
  readonly path: string;
  readonly sha256: string;
}

function untrustedGit(): never {
  throw new Error("runtime-gateway-git-untrusted");
}

function isWritableByNonOwner(mode: number): boolean {
  return (mode & 0o022) !== 0;
}

function assertTrustedRootOwnedPath(path: string): void {
  const root = parse(path).root;
  let current = dirname(path);
  for (;;) {
    const entry = lstatSync(current);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.uid !== 0 ||
      isWritableByNonOwner(entry.mode)
    ) {
      untrustedGit();
    }
    if (current === root) return;
    current = dirname(current);
  }
}

/** Attests the exact developer-tool Git path before it enters a Seatbelt allowlist. */
export function attestDarwinGitExecutable(candidate: string): AttestedDarwinGitExecutable {
  try {
    if (
      !isAbsolute(candidate) ||
      candidate.includes("\0") ||
      realpathSync(candidate) !== candidate
    ) {
      return untrustedGit();
    }
    const entry = lstatSync(candidate);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1 ||
      entry.uid !== 0 ||
      isWritableByNonOwner(entry.mode)
    ) {
      return untrustedGit();
    }
    assertTrustedRootOwnedPath(candidate);
    return Object.freeze({
      path: candidate,
      sha256: createHash("sha256").update(readFileSync(candidate)).digest("hex"),
    });
  } catch {
    return untrustedGit();
  }
}

/** Resolves Git through Apple's protected launcher without inheriting a caller-selected toolchain. */
export function resolveDarwinGitExecutable(): AttestedDarwinGitExecutable {
  const xcrun = "/usr/bin/xcrun";
  attestDarwinGitExecutable(xcrun);
  const resolved = spawnSync(xcrun, ["--find", "git"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    shell: false,
    timeout: 10_000,
  });
  if (resolved.error !== undefined || resolved.status !== 0) return untrustedGit();
  const path = resolved.stdout.trim();
  if (path.includes("\n") || path.includes("\r")) return untrustedGit();
  return attestDarwinGitExecutable(path);
}
