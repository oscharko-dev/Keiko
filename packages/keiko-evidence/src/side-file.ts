// ADR-0017 D5 — side-file writer for binary evidence (e.g. screenshots) that does NOT fit the
// text-only EvidenceManifest JSON. Atomic O_EXCL temp + rename, realpath-contained against the
// per-run subdirectory of evidenceDir, SHA-256 computed over the raw bytes. Reuses the workspace
// realpath-containment primitive — no new path-safety mechanism is introduced. `evidenceSchemaVersion`
// stays "1" (additive manifest field consumed by callers).

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SideFileWriteResult } from "@oscharko-dev/keiko-contracts";
import {
  assertContainedRealPath,
  resolveWithinWorkspace,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertValidRunId } from "./runid.js";
import { EvidenceWriteError } from "./errors.js";

const MAX_NAME_LENGTH = 128;

// Re-export the shared result type from contracts so side-file users can import it
// from the evidence package entry point.
export type { SideFileWriteResult };

export interface SideFileWriterOptions {
  readonly fs?: WorkspaceFs;
  readonly randomSuffix?: () => string;
}

// Validates a side-file basename. The set is intentionally narrower than runId's: a name segment
// is a single non-empty path component with no separators, no leading dot, no `..`, length cap. No
// regex — character-class check stays linear-time.
function assertValidName(name: string): void {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new EvidenceWriteError("side-file name length is invalid");
  }
  if (name.startsWith(".")) {
    throw new EvidenceWriteError("side-file name must not start with a dot");
  }
  for (let i = 0; i < name.length; i += 1) {
    if (!isAllowedNameChar(name.charCodeAt(i))) {
      throw new EvidenceWriteError("side-file name contains a disallowed character");
    }
  }
}

function isAllowedNameChar(code: number): boolean {
  const isDigit = code >= 48 && code <= 57;
  const isUpper = code >= 65 && code <= 90;
  const isLower = code >= 97 && code <= 122;
  const isPunct = code === 46 || code === 95 || code === 45;
  return isDigit || isUpper || isLower || isPunct;
}

function ensureDir(absolute: string): void {
  try {
    // owner-only: evidence artifacts are local regulated-use machine state, ADR-0048 D2
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new EvidenceWriteError(
      `cannot create evidence subdirectory: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function assertRealDirectoryEntry(absolute: string): void {
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new EvidenceWriteError("side-file run directory must be a real directory");
  }
}

function atomicWriteBytes(target: string, data: Buffer, randomSuffix: () => string): void {
  const temp = `${target}.${randomSuffix()}.tmp`;
  try {
    // O_EXCL ("wx") refuses to open through a pre-planted symlink at the temp path. The randomUUID
    // suffix never collides so "wx" never spuriously fails.
    writeFileSync(temp, data, { flag: "wx" });
    // Best-effort 0o600 on the temp file (the rename preserves the mode). Failure is non-fatal:
    // POSIX-default umask handles the common case; not all filesystems support chmod (e.g. Windows).
    try {
      chmodSync(temp, 0o600);
    } catch {
      // ignore; not all filesystems support chmod (e.g. Windows)
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new EvidenceWriteError(
      `side-file write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

// Writes a binary side-file under `<baseDir>/<runId>/<name>` atomically. Containment is enforced
// by realpath-resolving the per-run directory after creation, then checking the final lexical path
// against that real root via assertContainedRealPath. Returns the relative path to embed in the
// manifest plus the SHA-256 of the raw bytes (tamper-evidence).
export function writeSideFile(
  baseDir: string,
  runId: string,
  name: string,
  data: Buffer,
  options: SideFileWriterOptions = {},
): SideFileWriteResult {
  assertValidRunId(runId);
  assertValidName(name);
  const fs = options.fs ?? nodeWorkspaceFs;
  const randomSuffix = options.randomSuffix ?? randomUUID;
  ensureDir(baseDir);
  const realBase = fs.realPath(baseDir);
  const runDir = join(realBase, runId);
  const existingRunDir = lstatSync(runDir, { throwIfNoEntry: false });
  if (
    existingRunDir !== undefined &&
    (!existingRunDir.isDirectory() || existingRunDir.isSymbolicLink())
  ) {
    throw new EvidenceWriteError("side-file run directory must be a real directory");
  }
  ensureDir(runDir);
  assertRealDirectoryEntry(runDir);
  const lexicalTarget = resolveWithinWorkspace(realBase, join(runId, name));
  const absoluteTarget = assertContainedRealPath(fs, realBase, lexicalTarget, `${runId}/${name}`);
  const sha256 = createHash("sha256").update(data).digest("hex");
  atomicWriteBytes(absoluteTarget, data, randomSuffix);
  return {
    relativePath: name,
    sha256,
    bytes: data.length,
    absolutePath: absoluteTarget,
  };
}
