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
// Integrity: load() recomputes each persisted screen hash from the stored, redacted IR + image
// sha256, verifies each PNG side-file against the stored sha256/byteLength, and then recomputes the
// snapshot integrity hash. Tampered or truncated records are rejected at the read boundary. The
// optional #752 artifacts (`links`, `tokens`) stay out of the drift hash but carry separate artifact
// hashes when present; old un-hashed optional artifacts are omitted on load instead of being trusted.
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
  type Dirent,
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
  type FigmaSnapshotArtifactHashes,
  type FigmaSnapshotLinkRow,
  type FigmaSnapshotRecord,
  type FigmaSnapshotScreenRow,
  type FigmaSnapshotSkippedScreenRow,
} from "./schema.js";

const QI_DIR_MODE = 0o700;
const SNAPSHOT_SUFFIX = ".figma-snapshot.json";
const SIDE_FILE_SUBDIR = "figma-snapshots";
const MAX_SIDE_FILE_NAME_LENGTH = 128;
const SIDE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;

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

const sha256Bytes = (input: Uint8Array): string => createHash("sha256").update(input).digest("hex");

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

const hashArtifact = (value: unknown): string => sha256Hex(canonical(value));

// Hash-neutral IR projection (mirrors figmaSnapshotHash.ts in keiko-server). The store accepts
// `irJson` as opaque JSON, so malformed legacy/tampered shapes fall back to the raw JSON projection;
// valid Screen-IR gets the exact same hash-neutral field pruning as the builder.
const HASH_NEUTRAL_IR_KEYS = new Set([
  "textColor",
  "backgroundColor",
  "layout",
  "sizing",
  "cornerRadius",
  "typography",
]);

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stripHashNeutralChild = (child: unknown): unknown =>
  isJsonObject(child) ? stripHashNeutralFields(child) : child;

const stripHashNeutralFields = (node: Record<string, unknown>): Record<string, unknown> => {
  const entries = Object.entries(node).filter(
    ([key]) => key !== "children" && !HASH_NEUTRAL_IR_KEYS.has(key),
  );
  const rawChildren = node.children;
  return {
    ...Object.fromEntries(entries),
    children: Array.isArray(rawChildren)
      ? (rawChildren as readonly unknown[]).map(stripHashNeutralChild)
      : [],
  };
};

const hashStableIr = (irJson: unknown): unknown => {
  if (!isJsonObject(irJson) || !isJsonObject(irJson.root)) return irJson;
  return { ...irJson, root: stripHashNeutralFields(irJson.root) };
};

const recomputeScreenIntegrityHash = (screen: FigmaSnapshotScreenRow): string =>
  sha256Hex(
    canonical({
      imageSha256: screen.image.sha256,
      ir: hashStableIr(screen.irJson),
      screenId: screen.screenId,
    }),
  );

const artifactHashesFor = (record: {
  readonly links?: readonly FigmaSnapshotLinkRow[];
  readonly tokens?: unknown;
}): FigmaSnapshotArtifactHashes | undefined => {
  const hashes: FigmaSnapshotArtifactHashes = {
    ...(record.links !== undefined ? { links: hashArtifact(record.links) } : {}),
    ...(record.tokens !== undefined ? { tokens: hashArtifact(record.tokens) } : {}),
  };
  return hashes.links === undefined && hashes.tokens === undefined ? undefined : hashes;
};

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

const rehashRecord = (record: FigmaSnapshotRecord): FigmaSnapshotRecord => {
  const screens = record.screens.map((screen) => ({
    ...screen,
    integrityHash: recomputeScreenIntegrityHash(screen),
  }));
  const rehashed = { ...record, screens };
  return { ...rehashed, integrityHash: recomputeSnapshotIntegrityHash(rehashed) };
};

const EXTERNAL_LINK_TARGET = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:|data:|javascript:)/iu;

const isExternalLinkTarget = (targetNodeId: string): boolean =>
  targetNodeId.startsWith("url:") || EXTERNAL_LINK_TARGET.test(targetNodeId);

const safeLinkRows = (
  links: readonly FigmaSnapshotLinkRow[] | undefined,
): readonly FigmaSnapshotLinkRow[] | undefined =>
  links?.filter((link) => !isExternalLinkTarget(link.targetNodeId));

const omitUnverifiedArtifacts = (
  record: FigmaSnapshotRecord,
  omitLinks: boolean,
  omitTokens: boolean,
): FigmaSnapshotRecord => {
  if (!omitLinks && !omitTokens) return record;
  const omitted = new Set<string>([
    ...(omitLinks ? ["links"] : []),
    ...(omitTokens ? ["tokens"] : []),
  ]);
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !omitted.has(key)),
  ) as FigmaSnapshotRecord;
};

type ArtifactKind = "links" | "tokens";

function verifyArtifactHash(
  kind: ArtifactKind,
  value: unknown,
  actualHash: string | undefined,
  runId: string,
): boolean {
  if (value === undefined) {
    if (actualHash !== undefined) {
      throw new EvidenceReadError(
        `Figma snapshot integrity check failed for run ${runId}: ${kind} artifact missing`,
      );
    }
    return false;
  }
  if (actualHash === undefined) return true;
  if (actualHash !== hashArtifact(value)) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: ${kind} artifact hash mismatch`,
    );
  }
  return false;
}

function verifyOptionalArtifactHashes(
  record: FigmaSnapshotRecord,
  runId: string,
): FigmaSnapshotRecord {
  const actual = record.artifactHashes;
  const omitLinks = verifyArtifactHash("links", record.links, actual?.links, runId);
  const omitTokens = verifyArtifactHash("tokens", record.tokens, actual?.tokens, runId);

  // Older records predate artifact hashes. The optional fields remain schema-valid, but we do not
  // trust them for downstream generation without their own tamper evidence.
  return omitUnverifiedArtifacts(record, omitLinks, omitTokens);
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

function runIdFromSnapshotName(name: string): string | undefined {
  if (!name.endsWith(SNAPSHOT_SUFFIX)) return undefined;
  const runId = name.slice(0, -SNAPSHOT_SUFFIX.length);
  try {
    assertValidRunId(runId);
    return runId;
  } catch {
    return undefined;
  }
}

interface SnapshotRecordFile {
  readonly runId: string;
  readonly path: string;
}

function snapshotRecordFiles(baseDir: string): readonly SnapshotRecordFile[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: SnapshotRecordFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const runId = runIdFromSnapshotName(entry.name);
    if (runId === undefined) continue;
    files.push({ runId, path: join(baseDir, entry.name) });
  }
  return files;
}

// Write-once: create a temp file, then hard-link it into the final target. `linkSync` is the
// exclusive commit: it fails with EEXIST if another recorder created the target after the
// pre-check, unlike `rename`, which would overwrite the winner on POSIX.
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
    try {
      linkSync(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new EvidenceWriteError("Figma snapshot already exists for this run (write-once)");
      }
      throw error;
    }
    rmSync(temp, { force: true });
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
  const links = safeLinkRows(input.links);
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
    ...(links !== undefined ? { links } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    integrityHash: input.integrityHash,
    redactionSummary: { totalStringsScanned: 0, stringsRedacted: 0, patternsMatched: {} },
  };
  const { redacted, summary } = redactQualityIntelligenceEvidence(draft);
  const rehashed = rehashRecord(redacted);
  const artifactHashes = artifactHashesFor(rehashed);
  return {
    ...rehashed,
    ...(artifactHashes !== undefined ? { artifactHashes } : {}),
    redactionSummary: summary,
  };
}

function isAllowedSideFileName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_SIDE_FILE_NAME_LENGTH) return false;
  return !name.startsWith(".") && SIDE_FILE_NAME_PATTERN.test(name);
}

function verifyScreenIntegrity(screen: FigmaSnapshotScreenRow, runId: string): void {
  const expected = recomputeScreenIntegrityHash(screen);
  if (screen.integrityHash !== expected) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: screen ${screen.screenId} hash mismatch`,
    );
  }
}

function verifyScreenImageSideFile(
  ctx: StoreCtx,
  runId: string,
  screen: FigmaSnapshotScreenRow,
): void {
  const name = screen.image.relativePath;
  if (!isAllowedSideFileName(name)) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: invalid image side-file path`,
    );
  }
  const runDir = join(ctx.sideFileBase, runId);
  let realRunDir: string;
  try {
    realRunDir = ctx.fs.realPath(runDir);
  } catch {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: image side-file directory missing`,
    );
  }
  const lexical = resolveWithinWorkspace(realRunDir, name);
  const absolute = assertContainedRealPath(ctx.fs, realRunDir, lexical, name);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: image side-file missing`,
    );
  }
  const bytes = readFileSync(absolute);
  if (bytes.byteLength !== screen.image.byteLength || sha256Bytes(bytes) !== screen.image.sha256) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: image side-file hash mismatch`,
    );
  }
}

function verifyPersistedScreens(ctx: StoreCtx, rec: FigmaSnapshotRecord, runId: string): void {
  for (const screen of rec.screens) {
    verifyScreenIntegrity(screen, runId);
    verifyScreenImageSideFile(ctx, runId, screen);
  }
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
  const records: { runId: string; fetchedAt: string }[] = [];
  for (const file of snapshotRecordFiles(qiDir)) {
    const fetchedAt = readFetchedAt(file.path);
    // Unparseable records are skipped — do not evict conservatively.
    if (fetchedAt !== undefined) records.push({ runId: file.runId, fetchedAt });
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
  // Integrity check: recompute and reject on mismatch. Screen rows are verified before the
  // snapshot-level hash so stale/tampered IR or image refs cannot hide behind an old screen hash.
  verifyPersistedScreens(ctx, rec, runId);
  const expected = recomputeSnapshotIntegrityHash(rec);
  if (rec.integrityHash !== expected) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: hash mismatch`,
    );
  }
  return verifyOptionalArtifactHashes(rec, runId);
}

function listByScopeOp(
  ctx: StoreCtx,
  fileKey: string,
  nodeId: string,
): readonly FigmaSnapshotScopeEntry[] {
  const realBase = realBaseForRead(ctx.qiDir, ctx.fs);
  if (realBase === undefined) return [];
  const results: FigmaSnapshotScopeEntry[] = [];
  for (const file of snapshotRecordFiles(realBase)) {
    const entry = parseScopeEntry(file.path, fileKey, nodeId);
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
