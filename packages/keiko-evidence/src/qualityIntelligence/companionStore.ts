// Quality Intelligence companion-artifact store (Issue #274/#280/#282, Epic #270, ADR-0023 D7+D8).
//
// Generic contained JSON artifact store that lives ALONGSIDE the immutable run manifest under
// `<evidenceDir>/qi/`, keyed by `<runId><suffix>`. The run manifest (`<runId>.qi.json`) stays the
// integrity-hashed, write-once evidence record; companion artifacts carry the MUTABLE product
// surfaces the manifest deliberately does not (generated candidate bodies for review/export, and
// the human review/lifecycle state). Suffix isolation keeps `listQualityIntelligenceRuns` (which
// only counts `.qi.json`) blind to companions.
//
// Same safety discipline as the manifest store: realpath-contained base, validated runId-derived
// filename, atomic O_EXCL temp + rename, 0o700 dir / 0o600 file intent.

import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveWithinWorkspace, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertValidRunId } from "@oscharko-dev/keiko-security";
import { PostRenameFsyncError, replaceViaDurableTempFile } from "../durable-write.js";
import { EvidenceReadError, EvidenceWriteError } from "../errors.js";
import {
  existingOwnedDirectory,
  isSingleLinkRegularFile,
  prepareOwnedDirectory,
} from "../fs-safety.js";
import { QI_SUBDIR } from "./store.js";

const QI_DIR_MODE = 0o700;

export interface ContainedJsonArtifactStore<T> {
  readonly record: (runId: string, value: T) => string;
  readonly load: (runId: string) => T | undefined;
  readonly delete: (runId: string) => boolean;
  readonly location: (runId: string) => string;
}

export interface ContainedJsonArtifactStoreOptions<T> {
  readonly fs?: WorkspaceFs;
  readonly randomSuffix?: () => string;
  /** Validates + narrows a parsed JSON value; return `undefined` to reject a corrupt artifact. */
  readonly parse: (value: unknown) => T | undefined;
}

function realBaseForWrite(baseDir: string, fs: WorkspaceFs): string {
  return prepareOwnedDirectory(baseDir, fs, "QI companion directory", { mode: QI_DIR_MODE });
}

function realBaseForRead(baseDir: string, fs: WorkspaceFs): string | undefined {
  return existingOwnedDirectory(baseDir, fs, "QI companion directory");
}

function lexicalArtifactPath(runId: string, suffix: string, realBase: string): string {
  assertValidRunId(runId);
  const name = `${runId}${suffix}`;
  return resolveWithinWorkspace(realBase, name);
}

function toQiCompanionInspectionError(message: string): Error {
  return new EvidenceReadError(`cannot inspect QI companion: ${message}`);
}

function isSingleLinkQiCompanion(path: string, fs: WorkspaceFs): boolean {
  return isSingleLinkRegularFile(path, fs, toQiCompanionInspectionError);
}

function assertWritableArtifactEntry(target: string, fs: WorkspaceFs): void {
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (entry === undefined) return;
  if (!entry.isFile() || !isSingleLinkQiCompanion(target, fs)) {
    throw new EvidenceWriteError("cannot overwrite a non-ledger QI companion artifact");
  }
}

function atomicWrite(target: string, json: string, randomSuffix: () => string): void {
  const temp = `${target}.${randomSuffix()}.tmp`;
  try {
    replaceViaDurableTempFile(target, temp, json);
  } catch (error) {
    // Post-rename fsync failure = content is durable on the target, only the parent-dir metadata
    // fsync is unconfirmed. Do not clean the (already gone) temp; do not claim the write failed.
    // See KEIKO-0388 / KEIKO-1034.
    if (error instanceof PostRenameFsyncError) {
      throw new EvidenceWriteError(
        `QI companion parent-directory fsync failed after durable rename: ${error.message}`,
      );
    }
    rmSync(temp, { force: true });
    throw new EvidenceWriteError(
      `QI companion write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function readArtifactFile<T>(
  baseDir: string,
  fs: WorkspaceFs,
  suffix: string,
  parse: (value: unknown) => T | undefined,
  runId: string,
): T | undefined {
  assertValidRunId(runId);
  const realBase = realBaseForRead(baseDir, fs);
  if (realBase === undefined) return undefined;
  const target = join(realBase, `${runId}${suffix}`);
  if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) return undefined;
  if (!isSingleLinkQiCompanion(target, fs)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new EvidenceReadError(
      `QI companion is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  return parse(parsed);
}

function deleteArtifactFile(
  baseDir: string,
  fs: WorkspaceFs,
  suffix: string,
  runId: string,
): boolean {
  assertValidRunId(runId);
  const realBase = realBaseForRead(baseDir, fs);
  if (realBase === undefined) return false;
  const target = lexicalArtifactPath(runId, suffix, realBase);
  if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) return false;
  if (!isSingleLinkQiCompanion(target, fs)) return false;
  rmSync(target, { force: true });
  return true;
}

/**
 * Build a node-backed contained JSON artifact store for one `suffix` (e.g. `.candidates.json`).
 * `record` overwrites in place (companions are mutable, unlike the write-once manifest): it writes
 * a fresh atomic temp and renames over any existing file.
 */
export function createNodeContainedJsonArtifactStore<T>(
  evidenceDir: string,
  suffix: string,
  options: ContainedJsonArtifactStoreOptions<T>,
): ContainedJsonArtifactStore<T> {
  const baseDir = join(evidenceDir, QI_SUBDIR);
  const fs = options.fs ?? nodeWorkspaceFs;
  const randomSuffix = options.randomSuffix ?? randomUUID;
  return {
    record: (runId: string, value: T): string => {
      assertValidRunId(runId);
      const realBase = realBaseForWrite(baseDir, fs);
      const target = lexicalArtifactPath(runId, suffix, realBase);
      assertWritableArtifactEntry(target, fs);
      atomicWrite(target, JSON.stringify(value), randomSuffix);
      return target;
    },
    load: (runId: string): T | undefined =>
      readArtifactFile(baseDir, fs, suffix, options.parse, runId),
    delete: (runId: string): boolean => deleteArtifactFile(baseDir, fs, suffix, runId),
    location: (runId: string): string => {
      assertValidRunId(runId);
      const realBase = realBaseForRead(baseDir, fs);
      return realBase === undefined
        ? join(resolve(baseDir), `${runId}${suffix}`)
        : lexicalArtifactPath(runId, suffix, realBase);
    },
  };
}

/**
 * Idempotently delete ONE QI companion artifact `<runId><suffix>` from the contained `qi/` dir.
 *
 * Used by the run-deletion path (`deleteQualityIntelligenceRun`) to clean up companion artifacts
 * that live alongside the run manifest. EXACT-suffix matching is mandatory: a non-leading `.` is a
 * legal runId character (`assertValidRunId`), so `run-1` and `run-1.2` can coexist and a prefix
 * (`startsWith`) sweep would let deleting `run-1` destroy `run-1.2`'s companion. By deriving the
 * full `${runId}${suffix}` name from the validated run id, the delete is collision-free,
 * realpath-contained at the base, and symlink-refusing (`deleteArtifactFile` lstat-gates `isFile`,
 * which is false for a symlink). Returns true iff a regular single-link file was removed.
 *
 * Intentionally NOT re-exported from the package barrel — it is an internal seam consumed only by
 * the deletion path, so the published surface stays unchanged.
 */
export function deleteQualityIntelligenceCompanionArtifact(
  evidenceDir: string,
  runId: string,
  suffix: string,
  options: { readonly fs?: WorkspaceFs } = {},
): boolean {
  const baseDir = join(evidenceDir, QI_SUBDIR);
  const fs = options.fs ?? nodeWorkspaceFs;
  return deleteArtifactFile(baseDir, fs, suffix, runId);
}
