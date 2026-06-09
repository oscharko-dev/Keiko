// Immutable Figma Snapshot evidence store (Epic #750, Issue #753, ADR-0023 "extend, don't fork").
//
// Persists an assembled Figma Snapshot as a WRITE-ONCE JSON record `<runId>.figma-snapshot.json`
// under the evidence `qi/` subdir, with the rendered PNG bytes written as binary side-files under
// `qi/figma-snapshots/<runId>/`. It reuses the existing keiko-evidence discipline verbatim — the
// realpath-contained QI dir, the atomic O_EXCL side-file writer, the QI redaction wrapper, and the
// runId validator — and adds NO new persistence layer.
//
// Immutability: unlike the MUTABLE candidate companion, this record is the evidence artifact, so it
// is write-once. `record` refuses to overwrite an existing snapshot (O_EXCL on the JSON temp +
// an explicit pre-check) — a re-snapshot is a new run, never a mutation of an old one.
//
// Redaction: the whole record (including the design-content IR) is passed through
// `redactQualityIntelligenceEvidence` before write. The token is never present by construction
// (the server builder never places it on the in-memory snapshot); redaction is defense-in-depth.

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
import { join } from "node:path";
import {
  assertContainedRealPath,
  resolveWithinWorkspace,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertValidRunId } from "@oscharko-dev/keiko-security";
import { EvidenceReadError, EvidenceWriteError } from "../../errors.js";
import { writeSideFile } from "../../side-file.js";
import { redactQualityIntelligenceEvidence } from "../redaction.js";
import { QI_SUBDIR } from "../store.js";
import {
  FIGMA_SNAPSHOT_SCHEMA_VERSION,
  validateFigmaSnapshotRecord,
  type FigmaSnapshotRecord,
  type FigmaSnapshotScreenRow,
  type FigmaSnapshotSkippedScreenRow,
} from "./schema.js";

const QI_DIR_MODE = 0o700;
const SNAPSHOT_SUFFIX = ".figma-snapshot.json";
const SIDE_FILE_SUBDIR = "figma-snapshots";

export interface RecordFigmaSnapshotScreenInput {
  readonly screenId: string;
  readonly irJson: unknown;
  readonly integrityHash: string;
  readonly image: { readonly mimeType: "image/png"; readonly bytes: Uint8Array };
}

export interface RecordFigmaSnapshotInput {
  readonly runId: string;
  readonly provenance: {
    readonly fileKey: string;
    readonly nodeId: string;
    readonly version: string | undefined;
    readonly fetchedAt: string;
  };
  readonly integrityHash: string;
  readonly screens: readonly RecordFigmaSnapshotScreenInput[];
  readonly skippedScreens: readonly FigmaSnapshotSkippedScreenRow[];
}

export interface RecordFigmaSnapshotResult {
  readonly recordPath: string;
  readonly sideFileDir: string;
}

export interface FigmaSnapshotStore {
  readonly record: (input: RecordFigmaSnapshotInput) => RecordFigmaSnapshotResult;
  readonly load: (runId: string) => FigmaSnapshotRecord | undefined;
  readonly location: (runId: string) => string;
}

export interface FigmaSnapshotStoreOptions {
  readonly fs?: WorkspaceFs;
  readonly randomSuffix?: () => string;
}

function realBaseForWrite(baseDir: string, fs: WorkspaceFs): string {
  try {
    mkdirSync(baseDir, { recursive: true, mode: QI_DIR_MODE });
    return fs.realPath(baseDir);
  } catch (error) {
    throw new EvidenceWriteError(
      `cannot create Figma snapshot directory: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function realBaseForRead(baseDir: string, fs: WorkspaceFs): string | undefined {
  if (!fs.exists(baseDir)) return undefined;
  try {
    return fs.realPath(baseDir);
  } catch (error) {
    throw new EvidenceReadError(
      `cannot read Figma snapshot directory: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function containedRecordPath(runId: string, realBase: string, fs: WorkspaceFs): string {
  assertValidRunId(runId);
  const name = `${runId}${SNAPSHOT_SUFFIX}`;
  const lexical = resolveWithinWorkspace(realBase, name);
  return assertContainedRealPath(fs, realBase, lexical, name);
}

function assertSnapshotAbsent(target: string): void {
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    throw new EvidenceWriteError("Figma snapshot already exists for this run (write-once)");
  }
}

// Write-once: O_EXCL ("wx") refuses if a record for this runId already exists, closing the TOCTOU
// gap left by the caller's pre-check.
function atomicWriteOnce(target: string, json: string, randomSuffix: () => string): void {
  assertSnapshotAbsent(target);
  const temp = `${target}.${randomSuffix()}.tmp`;
  try {
    writeFileSync(temp, json, { encoding: "utf8", flag: "wx" });
    try {
      chmodSync(temp, 0o600);
    } catch {
      // non-fatal: not every filesystem supports chmod (e.g. Windows)
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    if (error instanceof EvidenceWriteError) throw error;
    throw new EvidenceWriteError(
      `Figma snapshot write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function writeScreenSideFiles(
  sideFileBase: string,
  runId: string,
  screens: readonly RecordFigmaSnapshotScreenInput[],
  fs: WorkspaceFs,
  randomSuffix: () => string,
): readonly FigmaSnapshotScreenRow[] {
  return screens.map((screen, index) => {
    const name = `screen-${String(index).padStart(4, "0")}.png`;
    const written = writeSideFile(sideFileBase, runId, name, Buffer.from(screen.image.bytes), {
      fs,
      randomSuffix,
    });
    return {
      screenId: screen.screenId,
      irJson: screen.irJson,
      integrityHash: screen.integrityHash,
      image: {
        mimeType: "image/png",
        relativePath: written.relativePath,
        sha256: written.sha256,
        byteLength: written.bytes,
      },
    };
  });
}

function assembleRecord(
  input: RecordFigmaSnapshotInput,
  screenRows: readonly FigmaSnapshotScreenRow[],
): FigmaSnapshotRecord {
  const draft: FigmaSnapshotRecord = {
    figmaSnapshotSchemaVersion: FIGMA_SNAPSHOT_SCHEMA_VERSION,
    runId: input.runId,
    provenance: {
      fileKey: input.provenance.fileKey,
      nodeId: input.provenance.nodeId,
      version: input.provenance.version,
      fetchedAt: input.provenance.fetchedAt,
    },
    screens: screenRows,
    skippedScreens: input.skippedScreens,
    integrityHash: input.integrityHash,
    redactionSummary: { totalStringsScanned: 0, stringsRedacted: 0, patternsMatched: {} },
  };
  const { redacted, summary } = redactQualityIntelligenceEvidence(draft);
  return { ...redacted, redactionSummary: summary };
}

export function createNodeFigmaSnapshotStore(
  evidenceDir: string,
  options: FigmaSnapshotStoreOptions = {},
): FigmaSnapshotStore {
  const qiDir = join(evidenceDir, QI_SUBDIR);
  const sideFileBase = join(qiDir, SIDE_FILE_SUBDIR);
  const fs = options.fs ?? nodeWorkspaceFs;
  const randomSuffix = options.randomSuffix ?? randomUUID;

  const record = (input: RecordFigmaSnapshotInput): RecordFigmaSnapshotResult => {
    assertValidRunId(input.runId);
    const realBase = realBaseForWrite(qiDir, fs);
    const recordPath = containedRecordPath(input.runId, realBase, fs);
    // Write-once pre-check BEFORE any side-file is written, so a rejected re-record leaves no
    // partial render bytes behind. `atomicWriteOnce` re-checks via O_EXCL to close the TOCTOU gap.
    assertSnapshotAbsent(recordPath);
    const rows = writeScreenSideFiles(sideFileBase, input.runId, input.screens, fs, randomSuffix);
    atomicWriteOnce(recordPath, JSON.stringify(assembleRecord(input, rows)), randomSuffix);
    return { recordPath, sideFileDir: join(sideFileBase, input.runId) };
  };

  const load = (runId: string): FigmaSnapshotRecord | undefined => {
    assertValidRunId(runId);
    const realBase = realBaseForRead(qiDir, fs);
    if (realBase === undefined) return undefined;
    const target = join(realBase, `${runId}${SNAPSHOT_SUFFIX}`);
    if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(target, "utf8"));
    } catch (error) {
      throw new EvidenceReadError(
        `Figma snapshot is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    if (!validateFigmaSnapshotRecord(parsed).ok) return undefined;
    return parsed as FigmaSnapshotRecord;
  };

  const location = (runId: string): string => {
    assertValidRunId(runId);
    const realBase = realBaseForRead(qiDir, fs);
    return realBase === undefined
      ? join(qiDir, `${runId}${SNAPSHOT_SUFFIX}`)
      : containedRecordPath(runId, realBase, fs);
  };

  return { record, load, location };
}
