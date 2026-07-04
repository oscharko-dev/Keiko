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
// optional artifacts (`links`, `tokens`, `metrics`) stay out of the drift hash but carry separate
// artifact hashes when present; old un-hashed optional artifacts are omitted on load instead of being
// trusted.
//
// Retention: `enforceFigmaSnapshotRetention` deletes snapshot records + their side-file dirs in
// lock-step with the provided policy. Wiring: call it where the other QI retention enforcement
// runs (the orchestrator that calls `deleteQualityIntelligenceRun` for each expired run).
//
// Orphan cleanup: `sweepOrphanedFigmaSnapshotSideDirs` removes side-file dirs (and stray *.tmp
// files) that have no matching record. It is lazy/once — the store calls it on first use so stale
// dirs from a previously interrupted record() are cleaned up without a separate boot step.

import { createHash, randomUUID } from "node:crypto";
import { type Dirent, linkSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertValidRunId } from "@oscharko-dev/keiko-security";
import {
  fsyncDirectoryContaining,
  replaceViaDurableTempFile,
  writeDurableUtf8TempFile,
} from "../../durable-write.js";
import { EvidenceReadError, EvidenceWriteError } from "../../errors.js";
import {
  existingOwnedDirectory,
  ownedChildPath,
  prepareOwnedDirectory,
  removeOwnedRunDirectory,
} from "../../fs-safety.js";
import { writeSideFile } from "../../side-file.js";
import { redactQualityIntelligenceEvidence } from "../redaction.js";
import { QI_SUBDIR } from "../store.js";
import {
  FIGMA_SNAPSHOT_SCHEMA_VERSION,
  validateFigmaSnapshotRecord,
  type FigmaSnapshotArtifactHashes,
  type FigmaSnapshotImageRef,
  type FigmaSnapshotLinkRow,
  type FigmaSnapshotMetrics,
  type FigmaSnapshotRecord,
  type FigmaSnapshotScreenRow,
  type FigmaSnapshotStructuralScreenRow,
  type FigmaSnapshotSkippedScreenRow,
} from "./schema.js";

const QI_DIR_MODE = 0o700;
const SNAPSHOT_SUFFIX = ".figma-snapshot.json";
const SNAPSHOT_MANAGEMENT_SUFFIX = ".figma-snapshot.management.json";
const FIGMA_SNAPSHOT_MANAGEMENT_SCHEMA_VERSION = 1 as const;
const SIDE_FILE_SUBDIR = "figma-snapshots";
const MAX_SIDE_FILE_NAME_LENGTH = 128;
const SIDE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;
const MAX_SNAPSHOT_DISPLAY_NAME_LENGTH = 120;

export interface RecordFigmaSnapshotScreenInput {
  readonly screenId: string;
  readonly irJson: unknown;
  readonly integrityHash: string;
  readonly image: { readonly mimeType: "image/png"; readonly bytes: Uint8Array };
}

export interface RecordFigmaSnapshotStructuralScreenInput {
  readonly screenId: string;
  readonly reason: string;
  readonly irJson: unknown;
  readonly integrityHash: string;
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
  /** Structural Screen-IR for skipped/non-rendered screens. Optional for callers predating this. */
  readonly structuralScreens?: readonly RecordFigmaSnapshotStructuralScreenInput[];
  // `reason` is typed as string (not FigmaSnapshotSkipReason) so the routes layer can pass
  // FigmaSkippedScreenReason from keiko-server without a cross-package import; the store casts
  // it to FigmaSnapshotSkipReason internally when building the persisted row.
  readonly skippedScreens: readonly { readonly screenId: string; readonly reason: string }[];
  /** Raw inter-screen transitions for the navigation/flow graph (#811). Optional + additive. */
  readonly links?: readonly FigmaSnapshotLinkRow[];
  /** Deterministic design-tokens artifact (#752), opaque, for design-to-code (#755). Optional. */
  readonly tokens?: unknown;
  /** Numeric operational metrics (#760). Optional for older snapshots. */
  readonly metrics?: FigmaSnapshotMetrics;
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

/**
 * Mutable operator-facing management metadata for a write-once snapshot record.
 *
 * Stored separately from `<runId>.figma-snapshot.json` so a human rename never mutates the
 * immutable evidence artifact or its integrity hash graph.
 */
export interface FigmaSnapshotUserMetadata {
  readonly displayName?: string;
  readonly updatedAt: string;
}

export interface UpdateFigmaSnapshotUserMetadataInput {
  /** Empty string or null clears the display name. */
  readonly displayName?: string | null | undefined;
  /** Injectable for tests and audited routes; defaults to the current time. */
  readonly updatedAt?: string | undefined;
}

export interface DeleteFigmaSnapshotResult {
  readonly runId: string;
  readonly recordDeleted: boolean;
  readonly sideFileDirDeleted: boolean;
  readonly metadataDeleted: boolean;
}

export interface FigmaSnapshotImageBytes {
  readonly mimeType: "image/png";
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface FigmaSnapshotStore {
  readonly record: (input: RecordFigmaSnapshotInput) => RecordFigmaSnapshotResult;
  readonly load: (runId: string) => FigmaSnapshotRecord | undefined;
  /**
   * Loads and verifies the JSON snapshot record and hash graph without reading every image side-file.
   * Callers that stream one image must then verify that requested side-file with loadImage().
   */
  readonly loadMetadata: (runId: string) => FigmaSnapshotRecord | undefined;
  readonly loadImage: (runId: string, image: FigmaSnapshotImageRef) => FigmaSnapshotImageBytes;
  /** Loads mutable user metadata without touching the immutable evidence record. */
  readonly loadUserMetadata: (runId: string) => FigmaSnapshotUserMetadata | undefined;
  /** Upserts mutable user metadata next to the immutable record. */
  readonly updateUserMetadata: (
    runId: string,
    input: UpdateFigmaSnapshotUserMetadataInput,
  ) => FigmaSnapshotUserMetadata;
  /** Deletes the immutable record, rendered side-files, and mutable management metadata together. */
  readonly deleteSnapshot: (runId: string) => DeleteFigmaSnapshotResult;
  readonly location: (runId: string) => string;
  /**
   * List all snapshot records for a specific Figma scope, sorted by `fetchedAt` descending
   * (most-recent first). Reads only the record headers — cheap scan. Unparseable files are
   * skipped silently. Used by drift work (#735) to find existing snapshots for re-comparison.
   */
  readonly listByScope: (fileKey: string, nodeId: string) => readonly FigmaSnapshotScopeEntry[];
  /**
   * List the most recent snapshot run ids across all scopes, sorted by `fetchedAt` descending.
   * Reads only the record headers and skips unparseable files silently.
   */
  readonly listRecent: (limit?: number) => readonly string[];
}

export interface FigmaSnapshotStoreOptions {
  readonly fs?: WorkspaceFs;
  readonly randomSuffix?: () => string;
  /**
   * Count-based retention applied ONCE per store instance from the lazy sweep seam (Issue #1323
   * AC4 — make retention operational). Figma snapshot records carry no retention policy id; they
   * are evicted oldest-first by `fetchedAt` beyond `maxRecords`. Omitted → the conservative default
   * cap ({@link DEFAULT_FIGMA_SNAPSHOT_MAX_RECORDS}) is used so a normal local set is never silently
   * purged. A non-positive `maxRecords` disables retention entirely.
   */
  readonly retention?: { readonly maxRecords?: number } | undefined;
  /** Injectable clock for the module-level re-sweep interval (GEN-PERF-PERSISTENCE-010). Tests only. */
  readonly now?: () => number;
}

// GEN-PERF-PERSISTENCE-010 — the store is constructed per HTTP request, so a per-instance `swept`
// flag meant every request re-ran sweepOrphanedSideDirs + enforceFigmaSnapshotRetention (each of
// which reads every record). Track the last successful sweep per evidence dir at MODULE scope with a
// time-based re-sweep interval, so sweep+retention runs at most once per interval across the many
// short-lived stores for the same dir — not once per request. Correctness is preserved: the same
// sweep + same maxRecords retention still run, just amortised; evidence side-file containment is
// unchanged (the sweep/retention functions themselves are untouched).
const FIGMA_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const figmaSnapshotLastSweptAt = new Map<string, number>();

// Test-observable counter of ACTUAL sweep+retention passes (incremented once per real sweep, not
// per store instance). A regression test asserts many per-request stores for the same evidence dir
// within the interval bump this at most once (GEN-PERF-PERSISTENCE-010).
export const __figmaSnapshotSweepStats = { sweeps: 0 };

// Test-only: clear the module-level re-sweep registry + counter so a suite starts from a cold state.
export function __resetFigmaSnapshotSweepRegistryForTests(): void {
  figmaSnapshotLastSweptAt.clear();
  __figmaSnapshotSweepStats.sweeps = 0;
}

/**
 * Conservative default Figma-snapshot retention cap. Chosen to match the QI `qi:standard-90d`
 * profile's `maxRunArtifacts` (500) — the least-destructive value that still bounds growth, so
 * wiring retention on by default does NOT surprise an operator with an aggressive small cap (ADR-0048).
 * Deployments raise/lower it via `FigmaSnapshotStoreOptions.retention.maxRecords`.
 */
export const DEFAULT_FIGMA_SNAPSHOT_MAX_RECORDS = 500;

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

const recomputeStructuralScreenIntegrityHash = (screen: FigmaSnapshotStructuralScreenRow): string =>
  sha256Hex(
    canonical({
      ir: hashStableIr(screen.irJson),
      screenId: screen.screenId,
      structuralOnly: true,
    }),
  );

const artifactHashesFor = (record: {
  readonly links?: readonly FigmaSnapshotLinkRow[];
  readonly tokens?: unknown;
  readonly metrics?: FigmaSnapshotMetrics;
}): FigmaSnapshotArtifactHashes | undefined => {
  const hashes: FigmaSnapshotArtifactHashes = {
    ...(record.links !== undefined ? { links: hashArtifact(record.links) } : {}),
    ...(record.tokens !== undefined ? { tokens: hashArtifact(record.tokens) } : {}),
    ...(record.metrics !== undefined ? { metrics: hashArtifact(record.metrics) } : {}),
  };
  return hashes.links === undefined && hashes.tokens === undefined && hashes.metrics === undefined
    ? undefined
    : hashes;
};

// Recompute the snapshot-level integrity hash from a loaded record.
// This exactly mirrors hashSnapshot() in figmaSnapshotHash.ts:
//   sha256( canonical({ screens: sorted [{integrityHash,screenId}], snapshotSchemaVersion, version }) )
// fetchedAt and links/tokens are excluded by design (non-identity metadata).
function recomputeSnapshotIntegrityHash(record: FigmaSnapshotRecord): string {
  const screens = [...record.screens, ...(record.structuralScreens ?? [])]
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
  const structuralScreens = record.structuralScreens?.map((screen) => ({
    ...screen,
    integrityHash: recomputeStructuralScreenIntegrityHash(screen),
  }));
  const rehashed = {
    ...record,
    screens,
    ...(structuralScreens !== undefined ? { structuralScreens } : {}),
  };
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
  omitMetrics: boolean,
): FigmaSnapshotRecord => {
  if (!omitLinks && !omitTokens && !omitMetrics) return record;
  const omitted = new Set<string>([
    ...(omitLinks ? ["links"] : []),
    ...(omitTokens ? ["tokens"] : []),
    ...(omitMetrics ? ["metrics"] : []),
  ]);
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !omitted.has(key)),
  ) as FigmaSnapshotRecord;
};

type ArtifactKind = "links" | "tokens" | "metrics";

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
  const omitMetrics = verifyArtifactHash("metrics", record.metrics, actual?.metrics, runId);

  // Older records predate artifact hashes. The optional fields remain schema-valid, but we do not
  // trust them for downstream generation without their own tamper evidence.
  return omitUnverifiedArtifacts(record, omitLinks, omitTokens, omitMetrics);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────

function realBaseForWrite(baseDir: string, fs: WorkspaceFs): string {
  return prepareOwnedDirectory(baseDir, fs, "Figma snapshot directory", { mode: QI_DIR_MODE });
}

function realBaseForRead(baseDir: string, fs: WorkspaceFs): string | undefined {
  return existingOwnedDirectory(baseDir, fs, "Figma snapshot directory");
}

function containedRecordPath(runId: string, realBase: string, _fs: WorkspaceFs): string {
  assertValidRunId(runId);
  const name = `${runId}${SNAPSHOT_SUFFIX}`;
  return ownedChildPath(realBase, name);
}

function containedManagementPath(runId: string, realBase: string, _fs: WorkspaceFs): string {
  assertValidRunId(runId);
  const name = `${runId}${SNAPSHOT_MANAGEMENT_SUFFIX}`;
  return ownedChildPath(realBase, name);
}

function containedSideFileRunDir(ctx: StoreCtx, runId: string): string {
  assertValidRunId(runId);
  const realQiBase = realBaseForRead(ctx.qiDir, ctx.fs) ?? realBaseForWrite(ctx.qiDir, ctx.fs);
  const sideBase = ownedChildPath(realQiBase, SIDE_FILE_SUBDIR);
  const realSideBase = existingOwnedDirectory(sideBase, ctx.fs, "Figma snapshot side-file root", {
    parentReal: realQiBase,
  });
  return ownedChildPath(realSideBase ?? sideBase, runId);
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

function runIdFromManagementName(name: string): string | undefined {
  if (!name.endsWith(SNAPSHOT_MANAGEMENT_SUFFIX)) return undefined;
  const runId = name.slice(0, -SNAPSHOT_MANAGEMENT_SUFFIX.length);
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
    writeDurableUtf8TempFile(temp, json);
    try {
      linkSync(temp, target);
      fsyncDirectoryContaining(target);
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

function atomicWriteMutable(target: string, json: string, randomSuffix: () => string): void {
  const temp = `${target}.${randomSuffix()}.tmp`;
  try {
    replaceViaDurableTempFile(target, temp, json);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new EvidenceWriteError(
      `Figma snapshot management metadata write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function normalizeDisplayName(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim().replace(/\s+/gu, " ");
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_SNAPSHOT_DISPLAY_NAME_LENGTH) {
    throw new EvidenceWriteError("Figma snapshot display name is too long");
  }
  if (hasControlCharacter(trimmed)) {
    throw new EvidenceWriteError("Figma snapshot display name contains control characters");
  }
  return trimmed;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function userMetadataRecord(
  value: unknown,
  expectedRunId: string,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.figmaSnapshotManagementSchemaVersion !== FIGMA_SNAPSHOT_MANAGEMENT_SCHEMA_VERSION) {
    return undefined;
  }
  return record.runId === expectedRunId ? record : undefined;
}

function metadataUpdatedAt(record: Record<string, unknown>): string | undefined {
  return typeof record.updatedAt === "string" && record.updatedAt.length > 0
    ? record.updatedAt
    : undefined;
}

function metadataDisplayName(record: Record<string, unknown>): string | undefined | null {
  if (record.displayName === undefined) return undefined;
  if (typeof record.displayName !== "string") return null;
  try {
    return normalizeDisplayName(record.displayName);
  } catch {
    return null;
  }
}

function parseUserMetadata(
  value: unknown,
  expectedRunId: string,
): FigmaSnapshotUserMetadata | undefined {
  const record = userMetadataRecord(value, expectedRunId);
  if (record === undefined) return undefined;
  const updatedAt = metadataUpdatedAt(record);
  if (updatedAt === undefined) return undefined;
  const displayName = metadataDisplayName(record);
  if (displayName === null) return undefined;
  return displayName === undefined ? { updatedAt } : { displayName, updatedAt };
}

function metadataToJson(runId: string, metadata: FigmaSnapshotUserMetadata): string {
  return JSON.stringify({
    figmaSnapshotManagementSchemaVersion: FIGMA_SNAPSHOT_MANAGEMENT_SCHEMA_VERSION,
    runId,
    ...(metadata.displayName !== undefined ? { displayName: metadata.displayName } : {}),
    updatedAt: metadata.updatedAt,
  });
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
    ...(input.structuralScreens !== undefined
      ? {
          structuralScreens: input.structuralScreens as readonly FigmaSnapshotStructuralScreenRow[],
        }
      : {}),
    // Omit `links`/`tokens` entirely when absent so an older snapshot stays byte-minimal and the
    // optional fields never serialise as `undefined` (exactOptionalPropertyTypes-safe).
    ...(links !== undefined ? { links } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    ...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
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

function verifyStructuralScreenIntegrity(
  screen: FigmaSnapshotStructuralScreenRow,
  runId: string,
): void {
  const expected = recomputeStructuralScreenIntegrityHash(screen);
  if (screen.integrityHash !== expected) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: structural screen ${screen.screenId} hash mismatch`,
    );
  }
}

// eslint-disable-next-line max-lines-per-function -- keep side-file path, ownership, and hash checks in one auditable read path.
function readVerifiedScreenImageSideFile(
  ctx: StoreCtx,
  runId: string,
  image: FigmaSnapshotImageRef,
): Buffer {
  const name = image.relativePath;
  if (!isAllowedSideFileName(name)) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: invalid image side-file path`,
    );
  }
  const realQiBase = realBaseForRead(ctx.qiDir, ctx.fs);
  if (realQiBase === undefined) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: image side-file directory missing`,
    );
  }
  const realSideBase = existingOwnedDirectory(
    ctx.sideFileBase,
    ctx.fs,
    "Figma snapshot side-file root",
    { parentReal: realQiBase },
  );
  if (realSideBase === undefined) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: image side-file directory missing`,
    );
  }
  const realRunDir = existingOwnedDirectory(
    ownedChildPath(realSideBase, runId),
    ctx.fs,
    "Figma snapshot side-file run directory",
    { parentReal: realSideBase },
  );
  if (realRunDir === undefined) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: image side-file directory missing`,
    );
  }
  const absolute = ownedChildPath(realRunDir, name);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: image side-file missing`,
    );
  }
  const bytes = readFileSync(absolute);
  if (bytes.byteLength !== image.byteLength || sha256Bytes(bytes) !== image.sha256) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: image side-file hash mismatch`,
    );
  }
  return bytes;
}

function verifyScreenImageSideFile(
  ctx: StoreCtx,
  runId: string,
  screen: FigmaSnapshotScreenRow,
): void {
  readVerifiedScreenImageSideFile(ctx, runId, screen.image);
}

function verifyPersistedScreens(ctx: StoreCtx, rec: FigmaSnapshotRecord, runId: string): void {
  for (const screen of rec.screens) {
    verifyScreenIntegrity(screen, runId);
    verifyScreenImageSideFile(ctx, runId, screen);
  }
  for (const screen of rec.structuralScreens ?? []) verifyStructuralScreenIntegrity(screen, runId);
}

function verifyPersistedScreenMetadata(rec: FigmaSnapshotRecord, runId: string): void {
  for (const screen of rec.screens) verifyScreenIntegrity(screen, runId);
  for (const screen of rec.structuralScreens ?? []) verifyStructuralScreenIntegrity(screen, runId);
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

function snapshotRecordExists(qiDir: string, runId: string): boolean {
  const recordPath = join(qiDir, `${runId}${SNAPSHOT_SUFFIX}`);
  return lstatSync(recordPath, { throwIfNoEntry: false })?.isFile() === true;
}

function sweepSideFileBaseEntry(qiDir: string, sideFileBase: string, name: string): void {
  if (name.endsWith(".tmp")) {
    rmSync(join(sideFileBase, name), { force: true });
    return;
  }
  if (snapshotRecordExists(qiDir, name)) return;
  const runDir = join(sideFileBase, name);
  const stat = lstatSync(runDir, { throwIfNoEntry: false });
  if (stat?.isDirectory() === true) rmSync(runDir, { recursive: true, force: true });
}

function sweepSideFileBaseEntries(qiDir: string, sideFileBase: string): void {
  const sideBaseStat = lstatSync(sideFileBase, { throwIfNoEntry: false });
  if (!sideBaseStat?.isDirectory()) return;
  let entries: string[];
  try {
    entries = readdirSync(sideFileBase);
  } catch {
    return; // non-fatal: best-effort sweep
  }
  for (const name of entries) sweepSideFileBaseEntry(qiDir, sideFileBase, name);
}

function sweepManagementMetadataFiles(qiDir: string): void {
  let qiEntries: Dirent[];
  try {
    qiEntries = readdirSync(qiDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of qiEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const runId = runIdFromManagementName(entry.name);
    if (runId === undefined) continue;
    if (!snapshotRecordExists(qiDir, runId)) rmSync(join(qiDir, entry.name), { force: true });
  }
}

// Removes side-file dirs, stray *.tmp files, and orphaned mutable management sidecars that have no
// matching record in qiDir. Called lazily once per store instance to clean up interrupted writes.
function sweepOrphanedSideDirs(qiDir: string, sideFileBase: string): void {
  sweepSideFileBaseEntries(qiDir, sideFileBase);
  sweepManagementMetadataFiles(qiDir);
}

// Read the fetchedAt timestamp from one snapshot file, or undefined when missing/unparseable.
function readFetchedAt(filePath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const prov = parsed.provenance as Record<string, unknown> | undefined;
    if (typeof prov?.fetchedAt !== "string" || prov.fetchedAt.trim() === "") {
      return undefined;
    }
    return Number.isNaN(Date.parse(prov.fetchedAt)) ? undefined : prov.fetchedAt;
  } catch {
    return undefined;
  }
}

function listRecentOp(ctx: StoreCtx, limit = 12): readonly string[] {
  ctx.ensureSwept();
  const realBase = realBaseForRead(ctx.qiDir, ctx.fs);
  if (realBase === undefined) return [];
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : 12;
  const records: { runId: string; fetchedAt: string }[] = [];
  for (const file of snapshotRecordFiles(realBase)) {
    const fetchedAt = readFetchedAt(file.path);
    if (fetchedAt === undefined) continue;
    records.push({ runId: file.runId, fetchedAt });
  }
  records.sort((a, b) => (a.fetchedAt > b.fetchedAt ? -1 : a.fetchedAt < b.fetchedAt ? 1 : 0));
  return records.slice(0, boundedLimit).map((record) => record.runId);
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
  const realQiDir = existingOwnedDirectory(qiDir, nodeWorkspaceFs, "Figma snapshot directory");
  if (realQiDir === undefined) return;
  const sideFileBase = ownedChildPath(realQiDir, SIDE_FILE_SUBDIR);
  // Scan for snapshot records and sort by fetchedAt ascending so we remove the oldest first.
  const records: { runId: string; fetchedAt: string }[] = [];
  for (const file of snapshotRecordFiles(realQiDir)) {
    const fetchedAt = readFetchedAt(file.path);
    // Unparseable records are skipped — do not evict conservatively.
    if (fetchedAt !== undefined) records.push({ runId: file.runId, fetchedAt });
  }
  // Sort oldest first (ascending fetchedAt) so we evict the oldest beyond the cap.
  records.sort((a, b) => (a.fetchedAt < b.fetchedAt ? -1 : a.fetchedAt > b.fetchedAt ? 1 : 0));
  const toEvict = records.slice(0, Math.max(0, records.length - profile.maxRecords));
  for (const { runId } of toEvict) {
    removeOwnedRunDirectory(sideFileBase, runId, nodeWorkspaceFs, "Figma snapshot side-file", {
      containmentRoot: realQiDir,
    });
    rmSync(join(realQiDir, `${runId}${SNAPSHOT_SUFFIX}`), { force: true });
    rmSync(join(realQiDir, `${runId}${SNAPSHOT_MANAGEMENT_SUFFIX}`), { force: true });
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

function loadMetadataOp(ctx: StoreCtx, runId: string): FigmaSnapshotRecord | undefined {
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
  verifyPersistedScreenMetadata(rec, runId);
  const expected = recomputeSnapshotIntegrityHash(rec);
  if (rec.integrityHash !== expected) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: hash mismatch`,
    );
  }
  return verifyOptionalArtifactHashes(rec, runId);
}

function loadImageOp(
  ctx: StoreCtx,
  runId: string,
  image: FigmaSnapshotImageRef,
): FigmaSnapshotImageBytes {
  assertValidRunId(runId);
  ctx.ensureSwept();
  const bytes = readVerifiedScreenImageSideFile(ctx, runId, image);
  return {
    mimeType: image.mimeType,
    bytes,
    sha256: image.sha256,
    byteLength: image.byteLength,
  };
}

function loadUserMetadataOp(ctx: StoreCtx, runId: string): FigmaSnapshotUserMetadata | undefined {
  assertValidRunId(runId);
  ctx.ensureSwept();
  const realBase = realBaseForRead(ctx.qiDir, ctx.fs);
  if (realBase === undefined) return undefined;
  const target = containedManagementPath(runId, realBase, ctx.fs);
  if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) return undefined;
  try {
    return parseUserMetadata(JSON.parse(readFileSync(target, "utf8")), runId);
  } catch {
    return undefined;
  }
}

function updateUserMetadataOp(
  ctx: StoreCtx,
  runId: string,
  input: UpdateFigmaSnapshotUserMetadataInput,
): FigmaSnapshotUserMetadata {
  assertValidRunId(runId);
  const record = loadMetadataOp(ctx, runId);
  if (record === undefined) {
    throw new EvidenceWriteError("Figma snapshot does not exist");
  }
  const existing = loadUserMetadataOp(ctx, runId);
  const nextDisplayName =
    input.displayName === undefined
      ? existing?.displayName
      : normalizeDisplayName(input.displayName);
  const next: FigmaSnapshotUserMetadata = {
    ...(nextDisplayName !== undefined ? { displayName: nextDisplayName } : {}),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
  const realBase = realBaseForWrite(ctx.qiDir, ctx.fs);
  atomicWriteMutable(
    containedManagementPath(record.runId, realBase, ctx.fs),
    metadataToJson(runId, next),
    ctx.randomSuffix,
  );
  return next;
}

function deleteSnapshotOp(ctx: StoreCtx, runId: string): DeleteFigmaSnapshotResult {
  assertValidRunId(runId);
  ctx.ensureSwept();
  const realBase = realBaseForRead(ctx.qiDir, ctx.fs);
  if (realBase === undefined) {
    return { runId, recordDeleted: false, sideFileDirDeleted: false, metadataDeleted: false };
  }

  const recordPath = containedRecordPath(runId, realBase, ctx.fs);
  const metadataPath = containedManagementPath(runId, realBase, ctx.fs);
  const sideFileDir = containedSideFileRunDir(ctx, runId);
  const recordDeleted = lstatSync(recordPath, { throwIfNoEntry: false })?.isFile() === true;
  const metadataDeleted = lstatSync(metadataPath, { throwIfNoEntry: false })?.isFile() === true;
  const sideStat = lstatSync(sideFileDir, { throwIfNoEntry: false });
  const sideFileDirDeleted = sideStat !== undefined;

  rmSync(recordPath, { force: true });
  rmSync(metadataPath, { force: true });
  if (sideStat !== undefined) rmSync(sideFileDir, { recursive: true, force: true });

  return { runId, recordDeleted, sideFileDirDeleted, metadataDeleted };
}

function listByScopeOp(
  ctx: StoreCtx,
  fileKey: string,
  nodeId: string,
): readonly FigmaSnapshotScopeEntry[] {
  ctx.ensureSwept();
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

// eslint-disable-next-line max-lines-per-function -- the store factory builds one shared StoreCtx (including the inline sweep/retention guard) and returns the full FigmaSnapshotStore operation surface; each line is a distinct wired-up operation, so splitting would only relocate the closure without reducing coupling.
export function createNodeFigmaSnapshotStore(
  evidenceDir: string,
  options: FigmaSnapshotStoreOptions = {},
): FigmaSnapshotStore {
  const qiDir = join(evidenceDir, QI_SUBDIR);
  const sideFileBase = join(qiDir, SIDE_FILE_SUBDIR);
  const maxRecords = options.retention?.maxRecords ?? DEFAULT_FIGMA_SNAPSHOT_MAX_RECORDS;
  const now = options.now ?? Date.now;
  let swept = false;
  const ctx: StoreCtx = {
    qiDir,
    sideFileBase,
    fs: options.fs ?? nodeWorkspaceFs,
    randomSuffix: options.randomSuffix ?? randomUUID,
    ensureSwept(): void {
      if (swept) return;
      swept = true;
      // GEN-PERF-PERSISTENCE-010 — skip sweep+retention when another (short-lived) store for the
      // same evidence dir already swept within the interval. Stamped BEFORE the work runs so a
      // concurrent request in the same tick does not double-sweep; a fault below simply lets the
      // next interval retry (the sweep/retention are best-effort and idempotent).
      const nowMs = now();
      const lastSweptAt = figmaSnapshotLastSweptAt.get(qiDir);
      if (lastSweptAt !== undefined && nowMs - lastSweptAt < FIGMA_SWEEP_INTERVAL_MS) {
        return;
      }
      figmaSnapshotLastSweptAt.set(qiDir, nowMs);
      __figmaSnapshotSweepStats.sweeps += 1;
      sweepOrphanedSideDirs(qiDir, sideFileBase);
      // Issue #1323 AC4 — make retention operational. Runs once per store instance (the sweep is
      // already guarded against concurrent re-entry by `swept`). A non-positive cap disables it so
      // a deployment can opt out without removing the call site. Best-effort: `ensureSwept` runs at
      // the head of read ops too, so a transient eviction fault (e.g. rmSync EPERM/EBUSY) must never
      // surface as a read error; it is swallowed and retried on the next store instance.
      if (Number.isFinite(maxRecords) && maxRecords > 0) {
        try {
          enforceFigmaSnapshotRetention(evidenceDir, { maxRecords });
        } catch {
          // ignore; retention is best-effort and re-runs once per fresh store instance
        }
      }
    },
  };
  return {
    record: (input) => recordOp(ctx, input),
    load: (runId) => loadOp(ctx, runId),
    loadMetadata: (runId) => loadMetadataOp(ctx, runId),
    loadImage: (runId, image) => loadImageOp(ctx, runId, image),
    loadUserMetadata: (runId) => loadUserMetadataOp(ctx, runId),
    updateUserMetadata: (runId, input) => updateUserMetadataOp(ctx, runId, input),
    deleteSnapshot: (runId) => deleteSnapshotOp(ctx, runId),
    location: (runId): string => {
      assertValidRunId(runId);
      const realBase = realBaseForRead(qiDir, ctx.fs);
      return realBase === undefined
        ? join(qiDir, `${runId}${SNAPSHOT_SUFFIX}`)
        : containedRecordPath(runId, realBase, ctx.fs);
    },
    listByScope: (fileKey, nodeId) => listByScopeOp(ctx, fileKey, nodeId),
    listRecent: (limit) => listRecentOp(ctx, limit),
  };
}
