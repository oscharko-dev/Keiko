// Repository refresh fingerprints (Issue #2569, ADR-0152 D8).
//
// Tracked files use Git's canonical blob object id, computed in-process from working-tree bytes.
// Untracked files, non-Git roots, unsupported Git-index formats, and files above the bounded byte
// cap use a content-free size+mtime identity. No per-file process is launched and no source bytes
// enter diagnostics, evidence, or persisted run summaries.

import { createHash } from "node:crypto";

import {
  isSafeStorageReference,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
  type KnowledgeSourceScope,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";

import { isContained, walkSource } from "../discovery/walk.js";
import type { DiscoveryOptions } from "../discovery/types.js";
import type { KnowledgeStore } from "../store.js";

const MAX_GIT_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_GIT_BLOB_FINGERPRINT_BYTES = 64 * 1024 * 1024;
const GIT_INDEX_HEADER_BYTES = 12;
const GIT_INDEX_ENTRY_FIXED_BYTES = 62;
const GIT_INDEX_EXTENDED_FLAG = 0x4000;

export type RepositoryFingerprintKind = "git-blob-sha1" | "file-state";

export interface RepositoryFileFingerprint {
  readonly relativePath: string;
  readonly contentFingerprint: string;
  readonly fingerprintKind: RepositoryFingerprintKind;
  readonly byteLength: number;
  readonly mtimeMs?: number;
}

export interface RepositoryFingerprintScan {
  readonly fingerprints: readonly RepositoryFileFingerprint[];
  readonly rejectedEntries: number;
  readonly usedGitIndex: boolean;
}

export interface ScanRepositoryFingerprintsOptions {
  readonly fs: WorkspaceFs;
  readonly scope: Extract<KnowledgeSourceScope, { readonly kind: "repository" }>;
  readonly discovery: DiscoveryOptions;
  readonly trackedPaths?: ReadonlySet<string>;
}

function joinAbsolute(root: string, relativePath: string): string {
  return root.endsWith("/") ? `${root}${relativePath}` : `${root}/${relativePath}`;
}

function uint16(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 2 > bytes.byteLength) return undefined;
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function uint32(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function nulOffset(bytes: Uint8Array, start: number): number | undefined {
  for (let index = start; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0) return index;
  }
  return undefined;
}

function decodeGitPath(bytes: Uint8Array, start: number, end: number): string | undefined {
  try {
    const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
    return isSafeStorageReference(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

interface ParsedIndexEntry {
  readonly path: string;
  readonly nextOffset: number;
}

function parseIndexEntry(
  bytes: Uint8Array,
  entryOffset: number,
  version: number,
): ParsedIndexEntry | undefined {
  const flags = uint16(bytes, entryOffset + 60);
  if (flags === undefined) return undefined;
  const extendedBytes = version >= 3 && (flags & GIT_INDEX_EXTENDED_FLAG) !== 0 ? 2 : 0;
  const pathStart = entryOffset + GIT_INDEX_ENTRY_FIXED_BYTES + extendedBytes;
  const pathEnd = nulOffset(bytes, pathStart);
  if (pathEnd === undefined) return undefined;
  const path = decodeGitPath(bytes, pathStart, pathEnd);
  if (path === undefined) return undefined;
  const entryLength = pathEnd + 1 - entryOffset;
  const nextOffset = entryOffset + Math.ceil(entryLength / 8) * 8;
  return { path, nextOffset };
}

export function parseGitIndexTrackedPaths(bytes: Uint8Array): ReadonlySet<string> | undefined {
  if (bytes.byteLength < GIT_INDEX_HEADER_BYTES) return undefined;
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "DIRC") return undefined;
  const version = uint32(bytes, 4);
  const entryCount = uint32(bytes, 8);
  if ((version !== 2 && version !== 3) || entryCount === undefined || entryCount > 1_000_000) {
    return undefined;
  }
  const paths = new Set<string>();
  let offset = GIT_INDEX_HEADER_BYTES;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = parseIndexEntry(bytes, offset, version);
    if (entry === undefined) return undefined;
    paths.add(entry.path);
    offset = entry.nextOffset;
  }
  return paths;
}

async function readBoundedFile(
  fs: WorkspaceFs,
  absolutePath: string,
  size: number,
  limit: number,
): Promise<Uint8Array | undefined> {
  if (size < 0 || size > limit || fs.readFileBytes === undefined) return undefined;
  try {
    const bytes = await fs.readFileBytes(absolutePath, size + 1);
    return bytes.byteLength === size ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function trackedPathsFromGitIndex(
  fs: WorkspaceFs,
  rootPath: string,
): Promise<ReadonlySet<string> | undefined> {
  const gitDirectory = joinAbsolute(rootPath, ".git");
  try {
    const rootRealPath = fs.realPath(rootPath);
    const gitStat = fs.stat(gitDirectory);
    const gitRealPath = fs.realPath(gitDirectory);
    if (!gitStat.isDirectory || gitStat.isSymbolicLink || !isContained(rootRealPath, gitRealPath)) {
      return undefined;
    }
    const indexPath = joinAbsolute(gitDirectory, "index");
    const indexStat = fs.stat(indexPath);
    const indexRealPath = fs.realPath(indexPath);
    if (!indexStat.isFile || !isContained(gitRealPath, indexRealPath)) return undefined;
    const bytes = await readBoundedFile(fs, indexPath, indexStat.size, MAX_GIT_INDEX_BYTES);
    return bytes === undefined ? undefined : parseGitIndexTrackedPaths(bytes);
  } catch {
    return undefined;
  }
}

function gitBlobFingerprint(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${String(bytes.byteLength)}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function fileStateFingerprint(size: number, mtimeMs: number | undefined): string {
  return createHash("sha256")
    .update(`file-state-v1\0${String(size)}\0${String(mtimeMs ?? -1)}`, "utf8")
    .digest("hex");
}

async function fingerprintFile(
  fs: WorkspaceFs,
  rootPath: string,
  relativePath: string,
  size: number,
  trackedPaths: ReadonlySet<string> | undefined,
): Promise<RepositoryFileFingerprint | undefined> {
  try {
    const absolutePath = joinAbsolute(rootPath, relativePath);
    const stat = fs.stat(absolutePath);
    if (!stat.isFile) return undefined;
    if (trackedPaths?.has(relativePath) === true) {
      const bytes = await readBoundedFile(fs, absolutePath, size, MAX_GIT_BLOB_FINGERPRINT_BYTES);
      if (bytes !== undefined) {
        return {
          relativePath,
          contentFingerprint: gitBlobFingerprint(bytes),
          fingerprintKind: "git-blob-sha1",
          byteLength: size,
          ...(stat.mtimeMs === undefined ? {} : { mtimeMs: stat.mtimeMs }),
        };
      }
    }
    return {
      relativePath,
      contentFingerprint: fileStateFingerprint(size, stat.mtimeMs),
      fingerprintKind: "file-state",
      byteLength: size,
      ...(stat.mtimeMs === undefined ? {} : { mtimeMs: stat.mtimeMs }),
    };
  } catch {
    return undefined;
  }
}

export async function scanRepositoryFingerprints(
  options: ScanRepositoryFingerprintsOptions,
): Promise<RepositoryFingerprintScan> {
  const inferred =
    options.trackedPaths ??
    (await trackedPathsFromGitIndex(options.fs, options.scope.repositoryRoot));
  const fingerprints: RepositoryFileFingerprint[] = [];
  let rejectedEntries = 0;
  for (const result of walkSource(options.fs, options.scope, options.discovery)) {
    if (result.kind === "error") {
      rejectedEntries += 1;
      continue;
    }
    const fingerprint = await fingerprintFile(
      options.fs,
      options.scope.repositoryRoot,
      result.file.relativePath,
      result.file.sizeBytes,
      inferred,
    );
    if (fingerprint === undefined) rejectedEntries += 1;
    else fingerprints.push(fingerprint);
  }
  return {
    fingerprints,
    rejectedEntries,
    usedGitIndex: options.trackedPaths !== undefined || inferred !== undefined,
  };
}

interface StoredFingerprintRow {
  readonly relative_path: string;
  readonly content_fingerprint: string;
  readonly fingerprint_kind: RepositoryFingerprintKind;
  readonly byte_length: number;
  readonly mtime_ms: number | null;
}

function fromStoredFingerprint(row: StoredFingerprintRow): RepositoryFileFingerprint {
  return {
    relativePath: row.relative_path,
    contentFingerprint: row.content_fingerprint,
    fingerprintKind: row.fingerprint_kind,
    byteLength: row.byte_length,
    ...(row.mtime_ms === null ? {} : { mtimeMs: row.mtime_ms }),
  };
}

export function readRepositoryFileFingerprints(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): ReadonlyMap<string, RepositoryFileFingerprint> {
  const rows = store._internal.db
    .prepare(
      `SELECT relative_path, content_fingerprint, fingerprint_kind, byte_length, mtime_ms
       FROM repository_file_fingerprints
       WHERE capsule_id = :capsule_id AND source_id = :source_id
       ORDER BY relative_path ASC`,
    )
    .all({
      capsule_id: capsuleId,
      source_id: sourceId,
    }) as unknown as readonly StoredFingerprintRow[];
  return new Map(rows.map((row) => [row.relative_path, fromStoredFingerprint(row)]));
}

export function replaceRepositoryFileFingerprints(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
  fingerprints: readonly RepositoryFileFingerprint[],
  runId: string,
  beforeReplace?: () => void,
): void {
  const db = store._internal.db;
  const insert = db.prepare(
    `INSERT INTO repository_file_fingerprints (
       capsule_id, source_id, relative_path, content_fingerprint, fingerprint_kind,
       byte_length, mtime_ms, run_id
     ) VALUES (
       :capsule_id, :source_id, :relative_path, :content_fingerprint, :fingerprint_kind,
       :byte_length, :mtime_ms, :run_id
     )`,
  );
  db.exec("BEGIN");
  try {
    beforeReplace?.();
    db.prepare(
      "DELETE FROM repository_file_fingerprints WHERE capsule_id = :c AND source_id = :s",
    ).run({ c: capsuleId, s: sourceId });
    for (const fingerprint of fingerprints) {
      insert.run({
        capsule_id: capsuleId,
        source_id: sourceId,
        relative_path: fingerprint.relativePath,
        content_fingerprint: fingerprint.contentFingerprint,
        fingerprint_kind: fingerprint.fingerprintKind,
        byte_length: fingerprint.byteLength,
        mtime_ms: fingerprint.mtimeMs ?? null,
        run_id: runId,
      });
    }
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

export function repositoryFingerprintSetDigest(
  fingerprints: readonly RepositoryFileFingerprint[],
): string {
  const hash = createHash("sha256");
  for (const item of [...fingerprints].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update(item.relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(item.contentFingerprint, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}
