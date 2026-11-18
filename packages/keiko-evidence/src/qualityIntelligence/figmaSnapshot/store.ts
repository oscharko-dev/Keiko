// Immutable Figma Snapshot evidence store (Epic #750, Issue #753, ADR-0023 "extend, don't fork").
//
// Persists an assembled Figma Snapshot as a WRITE-ONCE JSON record `<runId>.figma-snapshot.json`
// under the evidence `qi/` subdir, with the rendered PNG bytes written as binary side-files under
// `qi/figma-snapshots/<runId>/`. It reuses the existing keiko-evidence discipline verbatim — the
// realpath-contained QI dir, the atomic O_EXCL side-file writer, the QI redaction wrapper, and the
// runId validator — and adds NO new persistence layer.
//
// Immutability: reserve a per-run image directory, durably write the images, then publish the
// write-once JSON. The JSON's appearance is the commit point, including for concurrent readers.
//
// Redaction: the whole record (including the design-content IR) uses the shared QI redactor with
// the Figma tree's depth bound. The server builder keeps the PAT out of the snapshot.
//
// Integrity: load() recomputes each persisted screen hash from the stored, redacted IR + image
// sha256, verifies each PNG side-file against the stored sha256/byteLength, and then recomputes the
// snapshot integrity hash. Tampered or truncated records are rejected at the read boundary. The
// complete record carries its own hash so metadata and optional styling cannot drift unnoticed.
// Old records remain readable with their original drift and optional artifact hashes.
//
// Retention: `enforceFigmaSnapshotRetention` deletes snapshot records + their side-file dirs in
// lock-step with the provided policy. Wiring: call it where the other QI retention enforcement
// runs (the orchestrator that calls `deleteQualityIntelligenceRun` for each expired run).
//
// Orphan cleanup is lazy and rate-limited. A later store operation reaps stale directories and
// temporary files left by interrupted writes.

import { createHash, randomUUID } from "node:crypto";
import {
  type Dirent,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertValidRunId } from "@oscharko-dev/keiko-security";
import {
  fsyncDirectoryContaining,
  PostRenameFsyncError,
  replaceViaDurableTempFile,
  writeDurableUtf8TempFile,
} from "../../durable-write.js";
import { EvidenceReadError, EvidenceWriteError } from "../../errors.js";
import {
  existingOwnedDirectory,
  ownedChildPath,
  prepareOwnedDirectory,
  removeOwnedRunDirectory,
  resolveOwnedRunDirectoryForDeletion,
} from "../../fs-safety.js";
import { writeSideFile } from "../../side-file.js";
import { redactFigmaSnapshotEvidence } from "../redaction.js";
import { QI_SUBDIR } from "../store.js";
import {
  FIGMA_SNAPSHOT_SCHEMA_VERSION,
  isFigmaSnapshotImageRef,
  isFigmaSnapshotProvenance,
  isSha256,
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
  /** Bounded acquisition coverage. Optional for older snapshots. */
  readonly coverage?: FigmaSnapshotRecord["coverage"];
}

export interface RecordFigmaSnapshotResult {
  readonly recordPath: string;
  readonly sideFileDir: string;
}

/** Summary entry returned by {@link FigmaSnapshotStore.listByScope}. */
interface FigmaSnapshotScopeEntry {
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
   * (most-recent first). Checks record headers and skips unparseable files. Used by drift work
   * (#735) to find existing snapshots for re-comparison.
   */
  readonly listByScope: (fileKey: string, nodeId: string) => readonly FigmaSnapshotScopeEntry[];
  /**
   * List the most recent snapshot run ids across all scopes, sorted by `fetchedAt` descending.
   * Checks record headers and skips unparseable files.
   */
  readonly listRecent: (limit?: number) => readonly string[];
}

type ReportSnapshotFailure = (stage: "read-header" | "orphan-sweep" | "retention") => void;

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
  /** Reports recoverable faults without exposing stored content, filesystem paths, or run IDs. */
  readonly reportFailure?: ReportSnapshotFailure;
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

// ─── Sort comparators ─────────────────────────────────────────────────────────────────────────
// Plain lexicographic (code-unit) `<`/`>` comparison — deliberately not `localeCompare`, so
// ordering never shifts with locale/collation. Shared by every stable-sort call site below
// (screenId, fetchedAt ascending, fetchedAt descending) instead of re-inlining a nested ternary.

const compareAscending = (a: string, b: string): number => compareStrings(a, b);

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
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
  return `{${entries.join(",")}}`;
}

const hashArtifact = (value: unknown): string => sha256Hex(canonical(value));

function hashRecordContent({ contentHash: _contentHash, ...content }: FigmaSnapshotRecord): string {
  return sha256Hex(JSON.stringify(content));
}

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
    .sort((a, b) => compareAscending(a.screenId, b.screenId))
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

function snapshotRecordName(runId: string): string {
  return `${runId}${SNAPSHOT_SUFFIX}`;
}

function containedRecordPath(runId: string, realBase: string, _fs: WorkspaceFs): string {
  assertValidRunId(runId);
  return ownedChildPath(realBase, snapshotRecordName(runId));
}

function containedManagementPath(runId: string, realBase: string, _fs: WorkspaceFs): string {
  assertValidRunId(runId);
  const name = `${runId}${SNAPSHOT_MANAGEMENT_SUFFIX}`;
  return ownedChildPath(realBase, name);
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
class PublishedSnapshotSyncError extends EvidenceWriteError {}

function atomicWriteOnce(
  target: string,
  json: string,
  randomSuffix: () => string,
  beforePublish: () => void,
): void {
  assertSnapshotAbsent(target);
  const temp = `${target}.${randomSuffix()}.tmp`;
  let tempWritten = false;
  try {
    writeDurableUtf8TempFile(temp, json);
    tempWritten = true;
    beforePublish();
    linkSync(temp, target);
  } catch (error) {
    if (tempWritten || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      rmSync(temp, { force: true });
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new EvidenceWriteError("Figma snapshot already exists for this run (write-once)");
    }
    if (error instanceof EvidenceWriteError) throw error;
    throw new EvidenceWriteError("Figma snapshot write failed");
  }
  try {
    rmSync(temp, { force: true });
    fsyncDirectoryContaining(target);
  } catch {
    // The record is already visible. Keep its images even if directory durability is unconfirmed.
    throw new PublishedSnapshotSyncError("Figma snapshot was published but could not be synced");
  }
}

function atomicWriteMutable(target: string, json: string, randomSuffix: () => string): void {
  const temp = `${target}.${randomSuffix()}.tmp`;
  try {
    replaceViaDurableTempFile(target, temp, json);
  } catch (error) {
    // Post-rename fsync failure = content is durable on the target, only the parent-dir metadata
    // fsync is unconfirmed. Do not clean the (already gone) temp; do not claim the write failed.
    // See KEIKO-0388 / KEIKO-1034.
    if (error instanceof PostRenameFsyncError) {
      throw new EvidenceWriteError(
        `Figma snapshot management metadata parent-directory fsync failed after durable rename: ${error.message}`,
      );
    }
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
    const code = value.codePointAt(i);
    if (code === undefined || code <= 0x1f || code === 0x7f) return true;
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
    ...(input.coverage !== undefined ? { coverage: input.coverage } : {}),
    integrityHash: input.integrityHash,
    redactionSummary: { totalStringsScanned: 0, stringsRedacted: 0, patternsMatched: {} },
  };
  const { redacted, summary } = redactFigmaSnapshotEvidence(draft);
  const rehashed = rehashRecord(redacted);
  const artifactHashes = artifactHashesFor(rehashed);
  const record = {
    ...rehashed,
    ...(artifactHashes !== undefined ? { artifactHashes } : {}),
    redactionSummary: summary,
  };
  if (!validateFigmaSnapshotRecord(record).ok) {
    throw new EvidenceWriteError("Figma snapshot record has an invalid schema");
  }
  return { ...record, contentHash: hashRecordContent(record) };
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
  if (!isFigmaSnapshotImageRef(image)) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: invalid image side-file reference`,
    );
  }
  const name = image.relativePath;
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
  if (stat?.isFile() !== true) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: image side-file missing`,
    );
  }
  if (stat.size !== image.byteLength) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: image side-file hash mismatch`,
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

function verifyPersistedScreenMetadata(rec: FigmaSnapshotRecord, runId: string): void {
  for (const screen of rec.screens) verifyScreenIntegrity(screen, runId);
  for (const screen of rec.structuralScreens ?? []) verifyStructuralScreenIntegrity(screen, runId);
}

interface SnapshotHeader extends FigmaSnapshotScopeEntry {
  readonly fileKey: string;
  readonly nodeId: string;
  readonly fetchedAtMs: number;
}

function readSnapshotHeader(
  file: SnapshotRecordFile,
  reportFailure: ReportSnapshotFailure | undefined,
): SnapshotHeader | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file.path, "utf8"));
    if (!isJsonObject(parsed) || parsed.runId !== file.runId) return undefined;
    if (parsed.figmaSnapshotSchemaVersion !== FIGMA_SNAPSHOT_SCHEMA_VERSION) return undefined;
    const { provenance, integrityHash } = parsed;
    if (!isFigmaSnapshotProvenance(provenance) || !isSha256(integrityHash)) return undefined;
    const { fileKey, nodeId, fetchedAt } = provenance;
    return {
      runId: file.runId,
      fileKey,
      nodeId,
      fetchedAt,
      fetchedAtMs: Date.parse(fetchedAt),
      integrityHash,
    };
  } catch {
    reportFailure?.("read-header");
    return undefined;
  }
}

function snapshotHeaders(
  baseDir: string,
  reportFailure: ReportSnapshotFailure | undefined,
): SnapshotHeader[] {
  const headers: SnapshotHeader[] = [];
  for (const file of snapshotRecordFiles(baseDir)) {
    const header = readSnapshotHeader(file, reportFailure);
    if (header !== undefined) headers.push(header);
  }
  return headers;
}

function newestSnapshotFirst(a: SnapshotHeader, b: SnapshotHeader): number {
  return b.fetchedAtMs - a.fetchedAtMs || compareAscending(a.runId, b.runId);
}

// ─── Orphan sweep ─────────────────────────────────────────────────────────────────────────────

function snapshotRecordExists(qiDir: string, runId: string): boolean {
  const recordPath = join(qiDir, snapshotRecordName(runId));
  return lstatSync(recordPath, { throwIfNoEntry: false })?.isFile() === true;
}

const LEGACY_ATTEMPT_NAME = /^\.attempt-[0-9a-f-]{36}$/u;
const SNAPSHOT_TEMP_SUFFIX = /\.[0-9a-f-]{36}\.tmp$/u;

function sweepSideFileBaseEntries(qiDir: string, fs: WorkspaceFs, cutoff: number): void {
  const sideBase = existingOwnedDirectory(
    ownedChildPath(qiDir, SIDE_FILE_SUBDIR),
    fs,
    "Figma snapshot side-file root",
    { parentReal: qiDir },
  );
  if (sideBase === undefined) return;
  for (const entry of readdirSync(sideBase, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (
      runIdFromSnapshotName(snapshotRecordName(entry.name)) === undefined &&
      !LEGACY_ATTEMPT_NAME.test(entry.name)
    )
      continue;
    const stat = lstatSync(ownedChildPath(sideBase, entry.name), { throwIfNoEntry: false });
    if (stat === undefined || stat.mtimeMs >= cutoff || snapshotRecordExists(qiDir, entry.name))
      continue;
    removeOwnedRunDirectory(sideBase, entry.name, fs, "Figma snapshot side-file", {
      containmentRoot: qiDir,
    });
  }
}

function sweepRecordSidecars(qiDir: string, cutoff: number): void {
  const qiEntries = readdirSync(qiDir, { withFileTypes: true });
  for (const entry of qiEntries) {
    if (!entry.isFile()) continue;
    if (SNAPSHOT_TEMP_SUFFIX.test(entry.name)) {
      sweepSnapshotTempFile(qiDir, entry.name, cutoff);
      continue;
    }
    const runId = runIdFromManagementName(entry.name);
    if (runId === undefined) continue;
    if (!snapshotRecordExists(qiDir, runId)) {
      rmSync(ownedChildPath(qiDir, entry.name), { force: true });
    }
  }
}

function sweepSnapshotTempFile(qiDir: string, name: string, cutoff: number): void {
  const targetName = name.replace(SNAPSHOT_TEMP_SUFFIX, "");
  if (
    runIdFromSnapshotName(targetName) === undefined &&
    runIdFromManagementName(targetName) === undefined
  )
    return;
  const target = ownedChildPath(qiDir, name);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat?.isFile() === true && stat.mtimeMs < cutoff) rmSync(target, { force: true });
}

// A new image directory may belong to another live writer. Leave it in place until the next sweep
// interval, then remove it if a record still has not been published.
function sweepOrphanedSideDirs(qiDir: string, fs: WorkspaceFs, cutoff: number): void {
  sweepSideFileBaseEntries(qiDir, fs, cutoff);
  sweepRecordSidecars(qiDir, cutoff);
}

function listRecentOp(ctx: StoreCtx, limit = 12): readonly string[] {
  ctx.ensureSwept();
  const realBase = realBaseForRead(ctx.qiDir, ctx.fs);
  if (realBase === undefined) return [];
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : 12;
  return snapshotHeaders(realBase, ctx.reportFailure)
    .sort(newestSnapshotFirst)
    .slice(0, boundedLimit)
    .map((record) => record.runId);
}

// ─── Retention ───────────────────────────────────────────────────────────────────────────────

export interface FigmaSnapshotRetentionProfile {
  /** Maximum number of snapshots to keep (newest first by fetchedAt). */
  readonly maxRecords: number;
}

/**
 * Enforce store-level retention for Figma snapshot records. The side-file directory must pass
 * containment checks before the store removes the snapshot. Corrupt headers stay untouched.
 *
 * Wiring: call this alongside `deleteQualityIntelligenceRun` in the QI retention orchestrator
 * (#274). The profiles are intentionally separate because snapshot retention may differ from
 * run-manifest retention (snapshots are larger, longer-lived evidence artifacts).
 */
export function enforceFigmaSnapshotRetention(
  evidenceDir: string,
  profile: FigmaSnapshotRetentionProfile,
  reportFailure?: ReportSnapshotFailure,
): void {
  const qiDir = join(evidenceDir, QI_SUBDIR);
  const realQiDir = existingOwnedDirectory(qiDir, nodeWorkspaceFs, "Figma snapshot directory");
  if (realQiDir === undefined) return;
  if (!Number.isSafeInteger(profile.maxRecords) || profile.maxRecords <= 0) return;
  const records = snapshotHeaders(realQiDir, reportFailure).sort(newestSnapshotFirst);
  const toEvict = records.slice(profile.maxRecords).reverse();
  for (const { runId } of toEvict) {
    deleteOwnedSnapshot(realQiDir, runId, nodeWorkspaceFs);
  }
}

// ─── Store operation helpers (extracted to keep the factory under the line-count limit) ─────────

interface StoreCtx {
  readonly qiDir: string;
  readonly sideFileBase: string;
  readonly fs: WorkspaceFs;
  readonly randomSuffix: () => string;
  readonly reportFailure: ReportSnapshotFailure | undefined;
  readonly ensureSwept: () => void;
}

function reserveSideFileDirectory(path: string): () => boolean {
  try {
    mkdirSync(path, { mode: QI_DIR_MODE });
  } catch {
    throw new EvidenceWriteError("Figma snapshot image directory could not be reserved");
  }
  const reserved = lstatSync(path);
  return (): boolean => {
    const current = lstatSync(path, { throwIfNoEntry: false });
    return (
      current?.isDirectory() === true &&
      current.dev === reserved.dev &&
      current.ino === reserved.ino
    );
  };
}

function assertSideFilesPresent(dir: string, screens: readonly FigmaSnapshotScreenRow[]): void {
  for (const { image } of screens) {
    const stat = lstatSync(ownedChildPath(dir, image.relativePath), { throwIfNoEntry: false });
    if (stat?.isFile() !== true || stat.size !== image.byteLength) {
      throw new EvidenceWriteError("Figma snapshot image disappeared before publication");
    }
  }
}

function recordOp(ctx: StoreCtx, input: RecordFigmaSnapshotInput): RecordFigmaSnapshotResult {
  assertValidRunId(input.runId);
  ctx.ensureSwept();
  const realBase = realBaseForWrite(ctx.qiDir, ctx.fs);
  const recordPath = containedRecordPath(input.runId, realBase, ctx.fs);
  assertSnapshotAbsent(recordPath);
  const realSideFileBase = prepareOwnedDirectory(
    join(realBase, SIDE_FILE_SUBDIR),
    ctx.fs,
    "Figma snapshot side-file root",
    { parentReal: realBase },
  );
  const sideFileDir = ownedChildPath(realSideFileBase, input.runId);
  const ownsSideFileDir = reserveSideFileDirectory(sideFileDir);
  try {
    const rows = writeScreenSideFiles(
      realSideFileBase,
      input.runId,
      input.screens,
      ctx.fs,
      ctx.randomSuffix,
    );
    const record = assembleRecord(input, rows);
    // Persist directory entries before the JSON can expose the already-synced image files.
    fsyncDirectoryContaining(sideFileDir);
    fsyncDirectoryContaining(realSideFileBase);
    atomicWriteOnce(recordPath, JSON.stringify(record), ctx.randomSuffix, () => {
      if (!ownsSideFileDir()) {
        throw new EvidenceWriteError(
          "Figma snapshot image directory disappeared before publication",
        );
      }
      assertSideFilesPresent(sideFileDir, rows);
    });
  } catch (error) {
    if (!(error instanceof PublishedSnapshotSyncError) && ownsSideFileDir()) {
      rmSync(sideFileDir, { recursive: true, force: true });
    }
    throw error;
  }
  return { recordPath, sideFileDir };
}

function loadOp(ctx: StoreCtx, runId: string): FigmaSnapshotRecord | undefined {
  const record = loadMetadataOp(ctx, runId);
  if (record === undefined) return undefined;
  for (const { image } of record.screens) readVerifiedScreenImageSideFile(ctx, runId, image);
  return record;
}

function loadMetadataOp(ctx: StoreCtx, runId: string): FigmaSnapshotRecord | undefined {
  assertValidRunId(runId);
  ctx.ensureSwept();
  const realBase = realBaseForRead(ctx.qiDir, ctx.fs);
  if (realBase === undefined) return undefined;
  const target = containedRecordPath(runId, realBase, ctx.fs);
  if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new EvidenceReadError("Figma snapshot could not be read as valid JSON");
  }
  if (!validateFigmaSnapshotRecord(parsed).ok) {
    throw new EvidenceReadError("Figma snapshot record has an invalid schema");
  }
  const rec = parsed as FigmaSnapshotRecord;
  if (rec.runId !== runId) throw new EvidenceReadError("Figma snapshot record run ID mismatch");
  verifyPersistedScreenMetadata(rec, runId);
  const expected = recomputeSnapshotIntegrityHash(rec);
  if (rec.integrityHash !== expected) {
    throw new EvidenceReadError(
      `Figma snapshot integrity check failed for run ${runId}: hash mismatch`,
    );
  }
  const verified = verifyOptionalArtifactHashes(rec, runId);
  return verifyRecordContent(rec, verified);
}

function verifyRecordContent(
  stored: FigmaSnapshotRecord,
  verified: FigmaSnapshotRecord,
): FigmaSnapshotRecord {
  if (stored.contentHash !== undefined && stored.contentHash !== hashRecordContent(stored)) {
    throw new EvidenceReadError("Figma snapshot stored content hash mismatch");
  }
  if (stored.contentHash === undefined && verified.coverage !== undefined) {
    const { coverage: _coverage, ...legacy } = verified;
    return legacy;
  }
  return verified;
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
    containedManagementPath(runId, realBase, ctx.fs),
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

  return deleteOwnedSnapshot(realBase, runId, ctx.fs);
}

function deleteOwnedSnapshot(
  realBase: string,
  runId: string,
  fs: WorkspaceFs,
): DeleteFigmaSnapshotResult {
  const recordPath = containedRecordPath(runId, realBase, fs);
  const metadataPath = containedManagementPath(runId, realBase, fs);
  const recordDeleted = lstatSync(recordPath, { throwIfNoEntry: false })?.isFile() === true;
  if (!recordDeleted) {
    return { runId, recordDeleted: false, sideFileDirDeleted: false, metadataDeleted: false };
  }
  const metadataDeleted = lstatSync(metadataPath, { throwIfNoEntry: false })?.isFile() === true;
  const sideFileDir = resolveOwnedRunDirectoryForDeletion(
    ownedChildPath(realBase, SIDE_FILE_SUBDIR),
    runId,
    fs,
    "Figma snapshot side-file",
    { containmentRoot: realBase },
  );

  // Validate containment first and durably remove the publish marker before deleting its images.
  rmSync(recordPath, { force: true });
  fsyncDirectoryContaining(recordPath);
  rmSync(metadataPath, { force: true });
  if (sideFileDir !== undefined) rmSync(sideFileDir, { recursive: true, force: true });

  return { runId, recordDeleted, sideFileDirDeleted: sideFileDir !== undefined, metadataDeleted };
}

function listByScopeOp(
  ctx: StoreCtx,
  fileKey: string,
  nodeId: string,
): readonly FigmaSnapshotScopeEntry[] {
  ctx.ensureSwept();
  const realBase = realBaseForRead(ctx.qiDir, ctx.fs);
  if (realBase === undefined) return [];
  return snapshotHeaders(realBase, ctx.reportFailure)
    .filter((entry) => entry.fileKey === fileKey && entry.nodeId === nodeId)
    .sort(newestSnapshotFirst)
    .map(({ runId, fetchedAt, integrityHash }) => ({ runId, fetchedAt, integrityHash }));
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
  const reportFailure = options.reportFailure ?? ((): void => undefined);
  let swept = false;
  const ctx: StoreCtx = {
    qiDir,
    sideFileBase,
    fs: options.fs ?? nodeWorkspaceFs,
    randomSuffix: options.randomSuffix ?? randomUUID,
    reportFailure,
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
      try {
        const realQiDir = realBaseForRead(qiDir, ctx.fs);
        if (realQiDir !== undefined)
          sweepOrphanedSideDirs(realQiDir, ctx.fs, nowMs - FIGMA_SWEEP_INTERVAL_MS);
      } catch {
        reportFailure("orphan-sweep");
      }
      // Issue #1323 AC4 — make retention operational. Runs once per store instance (the sweep is
      // already guarded against concurrent re-entry by `swept`). A non-positive cap disables it so
      // a deployment can opt out without removing the call site. Best-effort: `ensureSwept` runs at
      // the head of read ops too, so a transient eviction fault (e.g. rmSync EPERM/EBUSY) must never
      // surface as a read error; it is swallowed and retried on the next store instance.
      if (Number.isFinite(maxRecords) && maxRecords > 0) {
        try {
          enforceFigmaSnapshotRetention(evidenceDir, { maxRecords }, reportFailure);
        } catch {
          reportFailure("retention");
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
