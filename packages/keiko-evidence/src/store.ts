// The EvidenceStore PORT + node adapter (ADR-0010 D4). A single manifest-record-typed port
// (read+write+list+delete) keeps all real IO in one auditable place and makes the layer testable
// with an in-memory store. We deliberately introduce a new port rather than reuse the #6
// WorkspaceWriter, which has no read/list capability that D5 requires.
//
// Safety: the node adapter realpath-contains its base dir once at construction (reusing the #5/#6
// primitives), every filename is derived from a VALIDATED runId (assertValidRunId), and the
// resolved child path is re-checked to remain inside the contained base dir before any write,
// read, or delete. Writes are atomic (temp + rename, same dir = same filesystem). list() returns
// only real `<runId>.json` files and never follows a symlink (lstat skip).

import {
  chmodSync,
  closeSync,
  readdirSync,
  readFileSync,
  openSync,
  lstatSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { resolveWithinWorkspace, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { EvidenceReadError, EvidenceWriteError, InvalidRunIdError } from "./errors.js";
import { existingOwnedDirectory, prepareOwnedDirectory, removeOwnedRunDirectory } from "./fs-safety.js";
import { assertValidRunId } from "./runid.js";

const MANIFEST_SUFFIX = ".json";
const MANIFEST_LOCK_SUFFIX = ".lock";
const MANIFEST_LOCK_TIMEOUT_MS = 5_000;
const MANIFEST_LOCK_POLL_MS = 25;

// POSIX limits filenames to 255 bytes. Exceeding this causes an ENAMETOOLONG error whose message
// includes the absolute path. Guard before any fs call so no path ever leaks (CWE-209).
const POSIX_FILENAME_LIMIT = 255;

function assertEvidenceFilenameFits(runId: string, suffix: string): void {
  if (runId.length + suffix.length > POSIX_FILENAME_LIMIT) {
    throw new InvalidRunIdError("runId produces a filename that exceeds the filesystem limit");
  }
}

function assertManifestFilenameFits(runId: string): void {
  assertEvidenceFilenameFits(runId, MANIFEST_SUFFIX);
}

function assertLockFilenameFits(runId: string): void {
  assertEvidenceFilenameFits(runId, MANIFEST_LOCK_SUFFIX);
}

// The workspace-relative default evidence base dir (ADR-0010 D4): predictable, local, .gitignored.
export const DEFAULT_EVIDENCE_DIR = "./.keiko/evidence";

// Single source of the output-location precedence (ADR-0010 D4): an explicit value (CLI
// --evidence-dir) wins over the KEIKO_EVIDENCE_DIR env var, which wins over the default. Shared by
// the CLI run command and the SDK persistEvidence default so both resolve identically.
export function resolveEvidenceDir(
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string {
  return explicit ?? env?.KEIKO_EVIDENCE_DIR ?? DEFAULT_EVIDENCE_DIR;
}

// Re-export shim: EvidenceStore port interface lives in @oscharko-dev/keiko-contracts (issue #158).
// import+export split so this file can reference EvidenceStore in its own function signatures.
import type { EvidenceStore } from "@oscharko-dev/keiko-contracts";
export type { EvidenceStore };

// ─── In-memory store (tests) ──────────────────────────────────────────────────────

export function createInMemoryEvidenceStore(): EvidenceStore {
  const data = new Map<string, string>();
  return {
    put: (runId: string, json: string): string => {
      assertValidRunId(runId);
      data.set(runId, json);
      return `${runId}${MANIFEST_SUFFIX}`;
    },
    update: (runId: string, update: (existingJson: string | undefined) => string): string => {
      assertValidRunId(runId);
      const next = update(data.get(runId));
      data.set(runId, next);
      return `${runId}${MANIFEST_SUFFIX}`;
    },
    list: (): readonly string[] => [...data.keys()].sort(),
    get: (runId: string): string | undefined => {
      assertValidRunId(runId);
      return data.get(runId);
    },
    location: (runId: string): string => {
      assertValidRunId(runId);
      return `${runId}${MANIFEST_SUFFIX}`;
    },
    delete: (runId: string): void => {
      assertValidRunId(runId);
      data.delete(runId);
    },
  };
}

// ─── Node adapter ──────────────────────────────────────────────────────────────────

// Resolves the base dir, creates it if absent, then realpath-contains it against itself so the
// returned path is the canonical (symlink-followed) base every child path is checked against.
function prepareBaseDir(baseDir: string, fs: WorkspaceFs): string {
  return prepareOwnedDirectory(baseDir, fs, "evidence directory", { mode: 0o700 });
}

function existingBaseDir(baseDir: string, fs: WorkspaceFs): string | undefined {
  return existingOwnedDirectory(baseDir, fs, "evidence directory");
}

// Returns the lexical absolute path of <runId>.json inside the already-real base dir. The runId is
// validated first so no separator/`..`/NUL can reach the join. Final manifest operations must target
// this ledger entry directly and then lstat it; using the entry realpath would follow in-base
// symlinks and mutate a different manifest.
function lexicalManifestPath(runId: string, realBase: string): string {
  assertValidRunId(runId);
  assertManifestFilenameFits(runId);
  return resolveWithinWorkspace(realBase, `${runId}${MANIFEST_SUFFIX}`);
}

function isManifestName(name: string): boolean {
  if (!name.endsWith(MANIFEST_SUFFIX)) {
    return false;
  }
  const runId = name.slice(0, name.length - MANIFEST_SUFFIX.length);
  try {
    assertValidRunId(runId);
    return true;
  } catch {
    return false;
  }
}

function isSingleLinkRegularFile(path: string, fs: WorkspaceFs): boolean {
  try {
    const stat = fs.stat(path);
    return stat.isFile && (stat.hardLinkCount ?? 1) <= 1;
  } catch (error) {
    throw new EvidenceReadError(
      `cannot inspect evidence manifest: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function listManifestRunIds(realBase: string, fs: WorkspaceFs): readonly string[] {
  const runIds: string[] = [];
  try {
    for (const entry of readdirSync(realBase, { withFileTypes: true })) {
      // Never follow a symlink: only count entries the ledger itself wrote as regular files.
      if (
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        !isManifestName(entry.name) ||
        !isSingleLinkRegularFile(join(realBase, entry.name), fs)
      ) {
        continue;
      }
      runIds.push(entry.name.slice(0, entry.name.length - MANIFEST_SUFFIX.length));
    }
  } catch (error) {
    throw new EvidenceReadError(
      `cannot list evidence manifests: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  return runIds.sort();
}

function atomicWrite(target: string, json: string, randomSuffix: () => string): void {
  const temp = `${target}.${randomSuffix()}.tmp`;
  try {
    // O_EXCL ("wx"): refuse to open through a pre-planted symlink at the temp path, closing the
    // temp-vs-final containment asymmetry (the final target is realpath-contained, the temp was
    // not). A randomUUID suffix never collides, so "wx" never spuriously fails.
    writeFileSync(temp, json, { encoding: "utf8", flag: "wx" });
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
      `evidence write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function assertWritableLedgerEntry(target: string, fs: WorkspaceFs): void {
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (entry === undefined) {
    return;
  }
  if (!entry.isFile() || !isSingleLinkRegularFile(target, fs)) {
    throw new EvidenceWriteError("cannot overwrite a non-ledger evidence manifest");
  }
}

function reportLocation(baseDir: string, fs: WorkspaceFs, runId: string): string {
  assertValidRunId(runId);
  assertManifestFilenameFits(runId);
  const realBase = existingBaseDir(baseDir, fs);
  return realBase === undefined
    ? join(resolve(baseDir), `${runId}${MANIFEST_SUFFIX}`)
    : lexicalManifestPath(runId, realBase);
}

function putManifest(
  baseDir: string,
  fs: WorkspaceFs,
  randomSuffix: () => string,
  runId: string,
  json: string,
): string {
  const realBase = prepareBaseDir(baseDir, fs);
  const target = lexicalManifestPath(runId, realBase);
  assertWritableLedgerEntry(target, fs);
  atomicWrite(target, json, randomSuffix);
  return target;
}

function listManifests(baseDir: string, fs: WorkspaceFs): readonly string[] {
  const realBase = existingBaseDir(baseDir, fs);
  return realBase === undefined ? [] : listManifestRunIds(realBase, fs);
}

function getManifest(baseDir: string, fs: WorkspaceFs, runId: string): string | undefined {
  assertValidRunId(runId);
  assertManifestFilenameFits(runId);
  const realBase = existingBaseDir(baseDir, fs);
  if (realBase === undefined) {
    return undefined;
  }
  const target = join(realBase, `${runId}${MANIFEST_SUFFIX}`);
  try {
    if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) {
      return undefined;
    }
    if (!isSingleLinkRegularFile(target, fs)) {
      return undefined;
    }
    return readFileSync(target, "utf8");
  } catch (error) {
    throw new EvidenceReadError(
      `cannot read evidence manifest: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function sleepSync(ms: number): void {
  const waitBuffer = new SharedArrayBuffer(4);
  const waitView = new Int32Array(waitBuffer);
  Atomics.wait(waitView, 0, 0, ms);
}

function acquireManifestLock(realBase: string, runId: string): () => void {
  assertValidRunId(runId);
  assertLockFilenameFits(runId);
  const lockPath = resolveWithinWorkspace(realBase, `${runId}${MANIFEST_LOCK_SUFFIX}`);
  const deadline = Date.now() + MANIFEST_LOCK_TIMEOUT_MS;
  let fd: number | undefined;

  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      if (retryManifestLock(error, lockPath, deadline)) continue;
      throw new EvidenceWriteError(
        `evidence update lock failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  return (): void => {
    try {
      closeSync(fd);
    } finally {
      rmSync(lockPath, { force: true });
    }
  };
}

function retryManifestLock(error: unknown, lockPath: string, deadline: number): boolean {
  if (errorCode(error) !== "EEXIST") {
    return false;
  }
  if (lockIsStale(lockPath)) {
    rmSync(lockPath, { force: true });
    return true;
  }
  if (Date.now() >= deadline) {
    return false;
  }
  sleepSync(MANIFEST_LOCK_POLL_MS);
  return true;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function lockIsStale(lockPath: string): boolean {
  try {
    return Date.now() - lstatSync(lockPath).mtimeMs >= MANIFEST_LOCK_TIMEOUT_MS;
  } catch {
    return true;
  }
}

function readManifestForUpdate(target: string, fs: WorkspaceFs): string | undefined {
  try {
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (entry === undefined) {
      return undefined;
    }
    if (!entry.isFile() || !isSingleLinkRegularFile(target, fs)) {
      throw new EvidenceWriteError("cannot update a non-ledger evidence manifest");
    }
    return readFileSync(target, "utf8");
  } catch (error) {
    if (error instanceof EvidenceWriteError) {
      throw error;
    }
    throw new EvidenceReadError(
      `cannot read evidence manifest: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function updateManifest(
  baseDir: string,
  fs: WorkspaceFs,
  randomSuffix: () => string,
  runId: string,
  update: (existingJson: string | undefined) => string,
): string {
  const realBase = prepareBaseDir(baseDir, fs);
  const target = lexicalManifestPath(runId, realBase);
  const releaseLock = acquireManifestLock(realBase, runId);
  try {
    atomicWrite(target, update(readManifestForUpdate(target, fs)), randomSuffix);
    return target;
  } finally {
    releaseLock();
  }
}

function deleteManifest(baseDir: string, fs: WorkspaceFs, runId: string): void {
  const realBase = existingBaseDir(baseDir, fs);
  if (realBase === undefined) {
    return;
  }
  removeOwnedRunDirectory(realBase, runId, fs, "evidence side-file", { containmentRoot: realBase });
  const target = lexicalManifestPath(runId, realBase);
  if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) {
    return;
  }
  if (!isSingleLinkRegularFile(target, fs)) {
    return;
  }
  rmSync(target, { force: true });
}

export function createNodeEvidenceStore(
  baseDir: string,
  fs: WorkspaceFs = nodeWorkspaceFs,
  randomSuffix: () => string = randomUUID,
): EvidenceStore {
  return {
    put: (runId: string, json: string): string =>
      putManifest(baseDir, fs, randomSuffix, runId, json),
    update: (runId: string, update: (existingJson: string | undefined) => string): string =>
      updateManifest(baseDir, fs, randomSuffix, runId, update),
    list: (): readonly string[] => listManifests(baseDir, fs),
    get: (runId: string): string | undefined => getManifest(baseDir, fs, runId),
    location: (runId: string): string => reportLocation(baseDir, fs, runId),
    delete: (runId: string): void => {
      deleteManifest(baseDir, fs, runId);
    },
  };
}
