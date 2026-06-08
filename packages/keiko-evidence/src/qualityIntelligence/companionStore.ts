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
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  assertContainedRealPath,
  resolveWithinWorkspace,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertValidRunId } from "@oscharko-dev/keiko-security";
import { EvidenceReadError, EvidenceWriteError } from "../errors.js";
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
  try {
    mkdirSync(baseDir, { recursive: true, mode: QI_DIR_MODE });
    return fs.realPath(baseDir);
  } catch (error) {
    throw new EvidenceWriteError(
      `cannot create QI companion directory: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function realBaseForRead(baseDir: string, fs: WorkspaceFs): string | undefined {
  if (!fs.exists(baseDir)) return undefined;
  try {
    return fs.realPath(baseDir);
  } catch (error) {
    throw new EvidenceReadError(
      `cannot read QI companion directory: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function containedPath(runId: string, suffix: string, realBase: string, fs: WorkspaceFs): string {
  assertValidRunId(runId);
  const name = `${runId}${suffix}`;
  const lexical = resolveWithinWorkspace(realBase, name);
  return assertContainedRealPath(fs, realBase, lexical, name);
}

function atomicWrite(target: string, json: string, randomSuffix: () => string): void {
  const temp = `${target}.${randomSuffix()}.tmp`;
  try {
    writeFileSync(temp, json, { encoding: "utf8", flag: "wx" });
    try {
      chmodSync(temp, 0o600);
    } catch {
      // non-fatal: not all filesystems support chmod (e.g. Windows)
    }
    renameSync(temp, target);
  } catch (error) {
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
  const target = containedPath(runId, suffix, realBase, fs);
  if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) return false;
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
      const target = containedPath(runId, suffix, realBase, fs);
      rmSync(target, { force: true });
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
        : containedPath(runId, suffix, realBase, fs);
    },
  };
}
