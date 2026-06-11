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
//
// Integrity: load() recomputes the snapshot integrity hash and rejects a record whose persisted
// `integrityHash` disagrees — tampered or truncated records are rejected at the read boundary.
// NOTE: the PNG side-files are NOT re-hashed on load (they are served separately); the per-screen
// `sha256` stored in the record serves as the tamper-evidence for each image.
//
// Retention: `enforceFigmaSnapshotRetention` deletes snapshot records + their side-file dirs in
// lock-step with the provided policy. Wiring: call it where the other QI retention enforcement
// runs (the orchestrator that calls `deleteQualityIntelligenceRun` for each expired run).
//
// Orphan cleanup: `sweepOrphanedFigmaSnapshotSideDirs` removes side-file dirs (and stray *.tmp
// files) that have no matching record. It is lazy/once — the store calls it on first use so stale
// dirs from a previously interrupted record() are cleaned up without a separate boot step.

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
  type FigmaSnapshotLinkRow,
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
  // `reason` is typed as string (not FigmaSnapshotSkipReason) so the routes layer can pass
  // FigmaSkippedScreenReason from keiko-server without a cross-package import; the store casts
  // it to FigmaSnapshotSkipReason internally when building the persisted row.
  readonly skippedScreens: readonly { readonly screenId: string; readonly reason: string }[];
  /** Raw inter-screen transitions for the navigation/flow graph (#811). Optional + additive. */
  readonly links?: readonly FigmaSnapshotLinkRow[];
  /** Deterministic design-tokens artifact (#752), opaque, for design-to-code (#755). Optional. */
  readonly tokens?: unknown;
}

export interface RecordFigmaSnapshotResult {
  readonly recordPath: string;
  readonly sideFileDir: string;
}

/** Summary entry returned by {@link FigmaSnapshotStore.listByScope}. */
export interface FigmaSnapshotScopeEntry {
  readonly runId: string;
  readonly fetchedAt: string;
  readonly integrityHash: string;
}

export interface FigmaSnapshotStore {
  readonly record: (input: RecordFigmaSnapshotInput) => RecordFigmaSnapshotResult;
  readonly load: (runId: string) => FigmaSnapshotRecord | undefined;
  readonly location: (runId: string) => string;
  /**
   * List all snapshot records for a specific Figma scope, sorted by `fetchedAt` descending
   * (most-recent first). Reads only the record headers — cheap scan. Unparseable files are
   * skipped silently. Used by drift work (#735) to find existing snapshots for re-comparison.
   */
  readonly listByScope: (fileKey: string, nodeId: string) => readonly FigmaSnapshotScopeEntry[];
}

export interface FigmaSnapshotStoreOptions {
  readonly fs?: WorkspaceFs;
  readonly randomSuffix?: () => string;
}

// ─── Integrity hash (mirrors figmaSnapshotHash.ts — inlined so keiko-evidence does not depend
//     on the private keiko-server package). MUST stay bit-identical with the server builder. ────

const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

// Stable stringify: keys emitted in sorted order at every depth (mirrors canonical() in hash.ts).
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as unknown[]).map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
  return `{${entries.join(",")}}`;
}

// Recompute the snapshot-level integrity hash from a loaded record.
// This exactly mirrors hashSnapshot() in figmaSnapshotHash.ts:
//   sha256( canonical({ screens: sorted [{integrityHash,screenId}], snapshotSchemaVersion, version }) )
// fetchedAt and links/tokens are excluded by design (non-identity metadata).
function recomputeSnapshotIntegrityHash(record: FigmaSnapshotRecord): string {
  const screens = [...record.screens]
    .sort((a, b) => (a.screenId < b.screenId ? -1 : a.screenId > b.screenId ? 1 : 0))
    .map((s) => ({ integrityHash: s.integrityHash, screenId: s.screenId }));
  return sha256Hex(
    canonical({
      screens,
      snapshotSchemaVersion: record.figmaSnapshotSchemaVersion,
      version: record.provenance.version ?? null,
    }),
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────

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
    skippedScreens: input.skippedScreens as readonly FigmaSnapshotSkippedScreenRow[],
    // Omit `links`/`tokens` entirely when absent so an older snapshot stays byte-minimal and the
    // optional fields never serialise as `undefined` (exactOptionalPropertyTypes-safe).
    ...(input.links !== undefined ? { links: input.links } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    integrityHash: input.integrityHash,
    redactionSummary: { totalStringsScanned: 0, stringsRedacted: 0, patternsMatched: {} },
  };
  const { redacted, summary } = redactQualityIntelligenceEvidence(draft);
  return { ...redacted, redactionSummary: summary };
}

// Parse one raw JSON string from a snapshot record file into a scope entry, or null when the
// file does not belong to the requested scope or cannot be parsed.
function parseScopeEntry(
  filePath: string,
  fileKey: string,
  nodeId: string,
): FigmaSnapshotScopeEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const prov = parsed.provenance as Record<string, unknown> | undefined;
    if (!prov?.fileKey || prov.fileKey !== fileKey || prov.nodeId !== nodeId) return null;
    const runId = typeof parsed.runId === "string" ? parsed.runId : undefined;
    if (runId === undefined) return null;
    const fetchedAt = typeof prov.fetchedAt === "string" ? prov.fetchedAt : "";
    const integrityHash = typeof parsed.integrityHash === "string" ? parsed.integrityHash : "";
    return { runId, fetchedAt, integrityHash };
  } catch {
    return null;
  }
}

// ─── Orphan sweep ─────────────────────────────────────────────────────────────────────────────

// Removes side-file dirs and stray *.tmp files under sideFileBase that have no matching record
// in qiDir. Called lazily once per store instance to clean up dirs left by an interrupted
// record() call (side-files written, JSON write failed).
function sweepOrphanedSideDirs(qiDir: string, sideFileBase: string): void {
  const sideBaseStat = lstatSync(sideFileBase, { throwIfNoEntry: false });
  if (!sideBaseStat?.isDirectory()) return;
  let entries: string[];
  try {
    entries = readdirSync(sideFileBase);
  } catch {
    return; // non-fatal: best-effort sweep
  }
  for (const name of entries) {
    // Remove stray temp files at the top level of sideFileBase.
    if (name.endsWith(".tmp")) {
      rmSync(join(sideFileBase, name), { force: true });
      continue;
    }
    // Each subdirectory name should equal a runId that has a matching record.
    const recordPath = join(qiDir, `${name}${SNAPSHOT_SUFFIX}`);
    const hasRecord = lstatSync(recordPath, { throwIfNoEntry: false })?.isFile() === true;
    if (!hasRecord) {
      const runDir = join(sideFileBase, name);
      const stat = lstatSync(runDir, { throwIfNoEntry: false });
      if (stat?.isDirectory() === true) {
        rmSync(runDir, { recursive: true, force: true });
      }
    }
  }
}

// Read the fetchedAt timestamp from one snapshot file, or undefined when unparseable.
function readFetchedAt(filePath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const prov = parsed.provenance as Record<string, unknown> | undefined;
    return typeof prov?.fetchedAt === "string" ? prov.fetchedAt : "";
  } catch {
    return undefined;
  }
}

// ─── Retention ───────────────────────────────────────────────────────────────────────────────

export interface FigmaSnapshotRetentionProfile {
  /** Maximum number of snapshots to keep (newest first by fetchedAt). */
  readonly maxRecords: number;
}

/**
 * Enforce store-level retention for Figma snapshot records. Deletes the RECORD first, then the
 * side-file dir, so a partially-retained snapshot is never in a state where the record is gone
 * but the side-files remain (the side-files are unreachable without the record). A retained
 * record's side-dir is never touched.
 *
 * Wiring: call this alongside `deleteQualityIntelligenceRun` in the QI retention orchestrator
 * (#274). The profiles are intentionally separate because snapshot retention may differ from
 * run-manifest retention (snapshots are larger, longer-lived evidence artifacts).
 */
export function enforceFigmaSnapshotRetention(
  evidenceDir: string,
  profile: FigmaSnapshotRetentionProfile,
): void {
  const qiDir = join(evidenceDir, QI_SUBDIR);
  const sideFileBase = join(qiDir, SIDE_FILE_SUBDIR);
  const dirStat = lstatSync(qiDir, { throwIfNoEntry: false });
  if (!dirStat?.isDirectory()) return;
  // Scan for snapshot records and sort by fetchedAt ascending so we remove the oldest first.
  let entries: string[];
  try {
    entries = readdirSync(qiDir);
  } catch {
    return;
  }
  const records: { runId: string; fetchedAt: string }[] = [];
  for (const name of entries) {
    if (!name.endsWith(SNAPSHOT_SUFFIX)) continue;
    const runId = name.slice(0, -SNAPSHOT_SUFFIX.length);
    const fetchedAt = readFetchedAt(join(qiDir, name));
    // Unparseable records are skipped — do not evict conservatively.
    if (fetchedAt !== undefined) records.push({ runId, fetchedAt });
  }
  // Sort oldest first (ascending fetchedAt) so we evict the oldest beyond the cap.
  records.sort((a, b) => (a.fetchedAt < b.fetchedAt ? -1 : a.fetchedAt > b.fetchedAt ? 1 : 0));
  const toEvict = records.slice(0, Math.max(0, records.length - profile.maxRecords));
  for (const { runId } of toEvict) {
    // Delete record first — after this the side-dir is unreachable by any normal path.
    rmSync(join(qiDir, `${runId}${SNAPSHOT_SUFFIX}`), { force: true });
    // Best-effort: remove the side-file dir; failure is non-fatal (it is orphaned, not
    // linked to a live record, and will be removed by the next sweepOrphanedSideDirs pass).
    const runDir = join(sideFileBase, runId);
    const stat = lstatSync(runDir, { throwIfNoEntry: false });
    if (stat?.isDirectory() === true) {
      rmSync(runDir, { recursive: true, force: true });
    }
  }
}

// ─── Store operation helpers (extracted to keep the factory under the line-count limit) ─────────

interface StoreCtx {
  readonly qiDir: string;
  readonly sideFileBase: string;
  readonly fs: WorkspaceFs;
  readonly randomSuffix: () => string;
  readonly ensureSwept: () => void;
}

function recordOp(ctx: StoreCtx, input: RecordFigmaSnapshotInput): RecordFigmaSnapshotResult {
  assertValidRunId(input.runId);
  ctx.ensureSwept();
  const realBase = realBaseForWrite(ctx.qiDir, ctx.fs);
  const recordPath = containedRecordPath(input.runId, realBase, ctx.fs);
  // Write-once pre-check BEFORE any side-file is written so a rejected re-record leaves no
  // partial render bytes behind. `atomicWriteOnce` re-checks via O_EXCL to close the TOCTOU gap.
  assertSnapshotAbsent(recordPath);
  let rows: readonly FigmaSnapshotScreenRow[];
  try {
    rows = writeScreenSideFiles(
      ctx.sideFileBase,
      input.runId,
      input.screens,
      ctx.fs,
      ctx.randomSuffix,
    );
  } catch (error) {
    // Side-file write failed: best-effort remove the run's side-dir so it is not orphaned.
    rmSync(join(ctx.sideFileBase, input.runId), { recursive: true, force: true });
    throw error;
  }
  try {
    atomicWriteOnce(recordPath, JSON.stringify(assembleRecord(input, rows)), ctx.randomSuffix);
  } catch (error) {
    // Record write failed after side-files succeeded: remove side-dir to avoid orphaning.
    rmSync(join(ctx.sideFileBase, input.runId), { recursive: true, force: true });
    throw error;
  }
  return { recordPath, sideFileDir: join(ctx.sideFileBase, input.runId) };
}

function loadOp(ctx: StoreCtx, runId: string): FigmaSnapshotRecord | undefined {
  assertValidRunId(runId);
  ctx.ensureSwept();
  const realBase = realBaseForRead(ctx.qiDir, ctx.fs);
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
  const rec = parsed as FigmaSnapshotRecord;
  // Integrity check: recompute and reject on mismatch. The PNG side-files are NOT re-hashed
  // on load — each screen's `sha256` field is the tamper evidence for the image bytes.
  const expected = recomputeSnapshotIntegrityHash(rec);
  if (rec.integrityHash !== expected) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: hash mismatch`,
    );
  }
  return rec;
}

function listByScopeOp(
  ctx: StoreCtx,
  fileKey: string,
  nodeId: string,
): readonly FigmaSnapshotScopeEntry[] {
  const realBase = realBaseForRead(ctx.qiDir, ctx.fs);
  if (realBase === undefined) return [];
  let entries: string[];
  try {
    entries = readdirSync(realBase);
  } catch {
    return [];
  }
  const results: FigmaSnapshotScopeEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith(SNAPSHOT_SUFFIX)) continue;
    const entry = parseScopeEntry(join(realBase, name), fileKey, nodeId);
    if (entry !== null) results.push(entry);
  }
  results.sort((a, b) => (a.fetchedAt > b.fetchedAt ? -1 : a.fetchedAt < b.fetchedAt ? 1 : 0));
  return results;
}

// ─── Store factory ────────────────────────────────────────────────────────────────────────────

export function createNodeFigmaSnapshotStore(
  evidenceDir: string,
  options: FigmaSnapshotStoreOptions = {},
): FigmaSnapshotStore {
  const qiDir = join(evidenceDir, QI_SUBDIR);
  const sideFileBase = join(qiDir, SIDE_FILE_SUBDIR);
  let swept = false;
  const ctx: StoreCtx = {
    qiDir,
    sideFileBase,
    fs: options.fs ?? nodeWorkspaceFs,
    randomSuffix: options.randomSuffix ?? randomUUID,
    ensureSwept(): void {
      if (swept) return;
      swept = true;
      sweepOrphanedSideDirs(qiDir, sideFileBase);
    },
  };
  return {
    record: (input) => recordOp(ctx, input),
    load: (runId) => loadOp(ctx, runId),
    location: (runId): string => {
      assertValidRunId(runId);
      const realBase = realBaseForRead(qiDir, ctx.fs);
      return realBase === undefined
        ? join(qiDir, `${runId}${SNAPSHOT_SUFFIX}`)
        : containedRecordPath(runId, realBase, ctx.fs);
    },
    listByScope: (fileKey, nodeId) => listByScopeOp(ctx, fileKey, nodeId),
  };
}
