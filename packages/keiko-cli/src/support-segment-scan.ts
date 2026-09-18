// Streaming access to the Activity Log store for `keiko support query`, `manifest` and selective
// export (#3531).
//
// `listActivityLogStoreFiles` enumerates the store WITHOUT opening any file (closed grammar,
// `lstat` only), so a query can decide from manifests alone which segment bodies it never needs.
// `ActivityLogScanner` is the one place a body is opened: through the hardened, state-dir-rooted
// safe-artifact open, streamed by the bounded line reader, classified by the analyzer's own
// per-line classifier, and summarized into an in-memory manifest as it passes. Every opened name is
// recorded, which is what lets tests prove that manifest-pruned bodies are never opened.
// `ensureSegmentManifests` validates the stored manifest of every sealed segment and rebuilds the
// missing, torn, stale or foreign-catalog ones; legacy files get an in-memory manifest per pass and
// active segments (still growing) are never pruned.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_LOG_DIRECTORY_NAME,
  orderActivityLogFileNames,
  readableActivityLogFileNames,
  type ActivityLogFileName,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { openSafeArtifactFile } from "@oscharko-dev/keiko-security/fs-hardening";
import { ActivityLogReadError, readActivityLogFileLines } from "./activity-log-line-reader.js";
import { classifyLine, type LineClassification } from "./support-analyze.js";
import {
  SegmentManifestBuilder,
  ensureSegmentManifestDirectory,
  listStoredSegmentManifests,
  loadSegmentManifest,
  manifestMatchesCatalog,
  readStoredSegmentManifest,
  removeStoredSegmentManifest,
  storedSegmentManifestExists,
  writeStoredSegmentManifest,
  type LoadedSegmentManifest,
  type SegmentManifest,
} from "./support-segment-manifest.js";

export interface ActivityLogStoreFile {
  readonly name: string;
  readonly path: string;
  readonly kind: ActivityLogFileName["kind"];
  readonly segmentId: string | undefined;
  readonly sizeBytes: number;
  // Position in the one logical log (legacy archives, legacy current file, then segments).
  readonly order: number;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

// A name retention removed after the listing reads as absent; any other failure propagates.
function regularFileSize(path: string): number | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isFile() === true ? stat.size : undefined;
}

/** Every readable Activity Log file of `stateDir` in logical-log order; opens no file. */
export function listActivityLogStoreFiles(stateDir: string): readonly ActivityLogStoreFile[] {
  const directory = join(stateDir, ACTIVITY_LOG_DIRECTORY_NAME);
  let names: readonly string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const files: ActivityLogStoreFile[] = [];
  for (const file of readableActivityLogFileNames(orderActivityLogFileNames(names))) {
    const path = join(directory, file.name);
    const sizeBytes = regularFileSize(path);
    if (sizeBytes === undefined) continue;
    files.push({
      name: file.name,
      path,
      kind: file.kind,
      segmentId: file.kind === "active" || file.kind === "sealed" ? file.segmentId : undefined,
      sizeBytes,
      order: files.length,
    });
  }
  return files;
}

export interface ScannedLine {
  readonly file: ActivityLogStoreFile;
  readonly index: number;
  readonly text: string;
  readonly byteLength: number;
  readonly classification: LineClassification;
}

export interface ActivityLogScannerDeps {
  // Test seam: how one store file is opened. The default is the hardened safe-artifact open.
  readonly openFile?: ((file: ActivityLogStoreFile, stateDir: string) => number) | undefined;
}

function openStoreFile(file: ActivityLogStoreFile, stateDir: string): number {
  return openSafeArtifactFile(file.path, {
    artifactClass: "activity-log",
    mode: "read",
    trustedRoot: stateDir,
  });
}

/** Streams store files; records every opened and unreadable name and the bytes it read. */
export class ActivityLogScanner {
  public readonly opened = new Set<string>();
  public readonly unreadable = new Set<string>();
  public scannedBytes = 0;
  public scannedLines = 0;
  public openCount = 0;
  private readonly lastManifests = new Map<string, SegmentManifest>();

  public constructor(
    private readonly stateDir: string,
    private readonly deps: ActivityLogScannerDeps = {},
  ) {}

  /** The manifest derived by the most recent complete scan of `file`, if any. */
  public manifestOf(file: ActivityLogStoreFile): SegmentManifest | undefined {
    return this.lastManifests.get(file.name);
  }

  public *scan(file: ActivityLogStoreFile): Generator<ScannedLine> {
    const open = this.deps.openFile ?? openStoreFile;
    const builder = new SegmentManifestBuilder(file.segmentId ?? "legacy");
    this.opened.add(file.name);
    this.openCount += 1;
    this.lastManifests.delete(file.name);
    const lines = readActivityLogFileLines(() => open(file, this.stateDir), {
      onChunk: (chunk) => {
        this.scannedBytes += chunk.length;
        builder.observeChunk(chunk);
      },
    });
    let index = 0;
    try {
      for (const line of lines) {
        const classification = classifyLine(line.text, index, !line.terminated, {});
        builder.observeLine(line, classification);
        this.scannedLines += 1;
        yield { file, index, text: line.text, byteLength: line.byteLength, classification };
        index += 1;
      }
    } catch (error) {
      if (!(error instanceof ActivityLogReadError)) throw error;
      this.unreadable.add(file.name);
      return;
    }
    this.lastManifests.set(file.name, builder.finish());
  }

  /** Streams `file` to its end without retaining anything but its derived manifest. */
  public drain(file: ActivityLogStoreFile): SegmentManifest | undefined {
    for (const line of this.scan(file)) void line;
    return this.manifestOf(file);
  }
}

// ─── Manifest maintenance ──────────────────────────────────────────────────────────────────────

export type SegmentManifestTrigger = "query" | "export" | "rebuild" | "verify";

export interface SegmentManifestPassStats {
  readonly trigger: SegmentManifestTrigger;
  segmentCount: number;
  reusedCount: number;
  builtCount: number;
  replacedCount: number;
  removedOrphanCount: number;
  unreadableCount: number;
  writeFailedCount: number;
  verifiedCount: number;
  mismatchCount: number;
  // Sealed segments with no stored manifest yet: built on demand by the next query, not an error.
  missingCount: number;
  manifestBytes: number;
  persisted: boolean;
}

export interface SegmentManifestPass {
  // Manifests by file name, for every sealed segment and legacy file that could be read.
  readonly manifests: ReadonlyMap<string, LoadedSegmentManifest>;
  readonly stats: SegmentManifestPassStats;
}

function emptyStats(trigger: SegmentManifestTrigger, persisted: boolean): SegmentManifestPassStats {
  return {
    trigger,
    segmentCount: 0,
    reusedCount: 0,
    builtCount: 0,
    replacedCount: 0,
    removedOrphanCount: 0,
    unreadableCount: 0,
    writeFailedCount: 0,
    verifiedCount: 0,
    mismatchCount: 0,
    missingCount: 0,
    manifestBytes: 0,
    persisted,
  };
}

function reusableManifest(
  directory: string | undefined,
  file: ActivityLogStoreFile,
  rebuild: boolean,
): { readonly manifest: SegmentManifest | undefined; readonly existed: boolean } {
  if (directory === undefined || file.segmentId === undefined) {
    return { manifest: undefined, existed: false };
  }
  const stored = readStoredSegmentManifest(directory, file.segmentId);
  const current =
    stored !== undefined &&
    manifestMatchesCatalog(stored) &&
    stored.segment.sizeBytes === file.sizeBytes;
  return { manifest: current && !rebuild ? stored : undefined, existed: stored !== undefined };
}

function persistManifest(
  directory: string | undefined,
  manifest: SegmentManifest,
  existed: boolean,
  stats: SegmentManifestPassStats,
): void {
  if (directory === undefined) return;
  try {
    stats.manifestBytes += writeStoredSegmentManifest(directory, manifest);
    if (existed) stats.replacedCount += 1;
    else stats.builtCount += 1;
  } catch {
    // The manifest still serves this pass from memory; the next pass retries the write.
    stats.writeFailedCount += 1;
  }
}

function removeOrphanManifests(
  directory: string | undefined,
  sealedIds: ReadonlySet<string>,
  stats: SegmentManifestPassStats,
): void {
  if (directory === undefined) return;
  for (const entry of listStoredSegmentManifests(directory)) {
    if (sealedIds.has(entry.segmentId)) continue;
    try {
      removeStoredSegmentManifest(directory, entry.name);
      stats.removedOrphanCount += 1;
    } catch {
      // Counted and persisted by support.manifest.rebuilt; the next pass retries the removal.
      stats.writeFailedCount += 1;
    }
  }
}

export interface SegmentManifestPassOptions {
  readonly trigger: SegmentManifestTrigger;
  // False keeps every manifest in memory (a read-only analysis); true maintains the store.
  readonly persist: boolean;
  // True ignores every stored manifest and derives each one again from its segment.
  readonly rebuild: boolean;
}

function sealedManifest(
  file: ActivityLogStoreFile,
  directory: string | undefined,
  scanner: ActivityLogScanner,
  options: SegmentManifestPassOptions,
  stats: SegmentManifestPassStats,
): SegmentManifest | undefined {
  const stored = reusableManifest(directory, file, options.rebuild);
  if (stored.manifest !== undefined) {
    stats.reusedCount += 1;
    return stored.manifest;
  }
  const built = scanner.drain(file);
  if (built === undefined) {
    stats.unreadableCount += 1;
    return undefined;
  }
  persistManifest(directory, built, stored.existed, stats);
  return built;
}

/**
 * Brings the manifest store in line with the sealed segments `files` lists: reuses every valid
 * manifest, derives the missing or invalid ones by streaming their segment once, and removes the
 * manifests of segments retention already deleted. Legacy files are summarized in memory only.
 */
export function ensureSegmentManifests(
  stateDir: string,
  files: readonly ActivityLogStoreFile[],
  scanner: ActivityLogScanner,
  options: SegmentManifestPassOptions,
): SegmentManifestPass {
  const directory = options.persist ? ensureSegmentManifestDirectory(stateDir) : undefined;
  const stats = emptyStats(options.trigger, directory !== undefined);
  const manifests = new Map<string, LoadedSegmentManifest>();
  const sealedIds = new Set<string>();
  for (const file of files) {
    if (file.kind === "active") continue;
    let manifest: SegmentManifest | undefined;
    if (file.kind === "sealed" && file.segmentId !== undefined) {
      stats.segmentCount += 1;
      sealedIds.add(file.segmentId);
      manifest = sealedManifest(file, directory, scanner, options, stats);
    } else {
      manifest = scanner.drain(file);
    }
    if (manifest !== undefined) manifests.set(file.name, loadSegmentManifest(manifest));
  }
  removeOrphanManifests(directory, sealedIds, stats);
  return { manifests, stats };
}

/**
 * Re-derives the manifest of every sealed segment and compares it byte for byte with the stored
 * one, without writing anything: `verifiedCount` match, `mismatchCount` differ (corrupt or
 * stale), and `missingCount` have no stored manifest yet (the next query derives them).
 */
export function verifySegmentManifests(
  stateDir: string,
  files: readonly ActivityLogStoreFile[],
  scanner: ActivityLogScanner,
): SegmentManifestPassStats {
  const directory = ensureSegmentManifestDirectory(stateDir);
  const stats = emptyStats("verify", false);
  for (const file of files) {
    if (file.kind !== "sealed" || file.segmentId === undefined) continue;
    stats.segmentCount += 1;
    const derived = scanner.drain(file);
    if (derived === undefined) {
      stats.unreadableCount += 1;
      continue;
    }
    if (directory === undefined || !storedSegmentManifestExists(directory, file.segmentId)) {
      stats.missingCount += 1;
      continue;
    }
    // A stored name that does not parse, or parses to another digest, is corrupt or stale.
    const stored = readStoredSegmentManifest(directory, file.segmentId);
    if (stored?.digest === derived.digest) stats.verifiedCount += 1;
    else stats.mismatchCount += 1;
  }
  return stats;
}
