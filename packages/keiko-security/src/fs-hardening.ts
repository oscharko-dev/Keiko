// Shared filesystem-hardening primitives [GEN-MAINT-COUPLING-005]. Three SQLite/secret surfaces
// (keiko-memory-vault/store db, keiko-server/store db, and this package's secret-vault) each carried
// a byte-identical private copy of the 0o700 directory / 0o600 file hardening pair. They now share
// this single owner so the win32 no-op and best-effort try/catch semantics can never drift between
// surfaces. Behavior is copied VERBATIM from those copies — no product change.
//
// keiko-security depends only on keiko-contracts and is depended upon by the store/vault packages, so
// hoisting this module here introduces no dependency cycle.

import { chmodSync, existsSync, mkdirSync } from "node:fs";

// Owner-only directory: rwx for the owner, nothing for group/other.
export const DIR_MODE = 0o700;
// Owner-only file: rw for the owner, nothing for group/other.
export const FILE_MODE = 0o600;

// Creates `dir` (recursively) at DIR_MODE when absent, then tightens an already-existing directory to
// DIR_MODE on POSIX. On win32 the chmod is a no-op (POSIX modes are meaningless there). The chmod is
// best-effort: a parent-owned directory we cannot chmod is preferable to a hard failure that blocks
// the user from opening the store/vault.
export function ensureDirHardened(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, DIR_MODE);
    } catch {
      // Best-effort: a parent-owned directory we cannot chmod is preferable to a hard failure.
    }
  }
}

// Best-effort chmod of a path that may not exist yet (e.g. a WAL/-shm sidecar). No-op on win32;
// swallows any error (ENOENT and friends) so callers can hardening-sweep a set of maybe-present paths
// without branching on existence.
export function chmodIfPresent(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // The sidecar (-wal/-shm) may not exist yet; best-effort.
  }
}
