// Repository refresh fingerprints (Issue #2569, ADR-0152 D8).
//
// Tracked files use Git's canonical blob object id, computed in-process from working-tree bytes.
// Every other indexable file uses SHA-256 over those bytes; size and mtime remain body-free
// observations, never identity. Reads are chunked and bounded. No per-file process is launched and
// no source bytes enter diagnostics, evidence, or persisted run summaries.

import { createHash, type Hash } from "node:crypto";

import type {
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  KnowledgeSourceScope,
} from "@oscharko-dev/keiko-contracts";
import { isSafeStorageReference } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-paths";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";

import { isContained, walkSource } from "../discovery/walk.js";
import type { DiscoveryOptions } from "../discovery/types.js";
import { compareFingerprintKeys } from "../fingerprint-diff.js";
import { DEFAULT_MAX_BYTES } from "../parsers/types.js";
import type { KnowledgeStore } from "../store.js";

const MAX_GIT_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_SINGLE_READ_BYTES = 64 * 1024 * 1024;
const FINGERPRINT_CHUNK_BYTES = 1024 * 1024;
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
  // False means the fingerprints are only a partial view and must never replace a prior baseline
  // or drive removal. PATH_ESCAPE is an intentional per-entry rejection and remains complete.
  readonly complete: boolean;
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

/**
 * Git's blob object id for `bytes`: `sha1("blob <byteLength>\0" + content)`.
 *
 * SHA-1 is not a security choice here, it is git's object format. The value is useful only insofar
 * as it equals what `git hash-object` reports for the same bytes, which is what lets the pod ask
 * git's own index whether a tracked file changed. A stronger digest would produce a value that
 * matches nothing git records and would defeat the comparison outright.
 *
 * This is the single owner of the computation. The writer below and the server's freshness check
 * must agree exactly: if they ever drifted, every tracked file would look changed on every pass and
 * the incremental skip that the repository pod exists to provide would silently degrade to a full
 * re-embed while still reporting success.
 */
export function gitBlobFingerprint(bytes: Uint8Array): string {
  return repositoryContentFingerprint(bytes, "git-blob-sha1");
}

export function repositoryContentFingerprint(
  bytes: Uint8Array,
  kind: RepositoryFingerprintKind,
): string {
  if (kind === "file-state") {
    return createHash("sha256").update(bytes).digest("hex");
  }
  return createHash("sha1")
    .update(`blob ${String(bytes.byteLength)}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

async function hashRanges(
  readRange: (startByte: number, length: number) => Promise<Uint8Array>,
  size: number,
  hash: Hash,
): Promise<boolean> {
  for (let offset = 0; offset < size; offset += FINGERPRINT_CHUNK_BYTES) {
    const length = Math.min(FINGERPRINT_CHUNK_BYTES, size - offset);
    const bytes = await readRange(offset, length);
    if (bytes.byteLength !== length) return false;
    hash.update(bytes);
  }
  return true;
}

async function hashWithOpenReader(
  fs: WorkspaceFs,
  absolutePath: string,
  size: number,
  hash: Hash,
): Promise<boolean> {
  if (fs.openFileReader === undefined) return false;
  let complete: boolean;
  const reader = await fs.openFileReader(absolutePath);
  try {
    complete = await hashRanges(reader.readRange, size, hash);
  } finally {
    try {
      await reader.close();
    } catch {
      complete = false;
    }
  }
  return complete;
}

async function hashFileContent(
  fs: WorkspaceFs,
  absolutePath: string,
  size: number,
  hash: Hash,
): Promise<boolean> {
  if (!Number.isSafeInteger(size) || size < 0 || size > DEFAULT_MAX_BYTES) return false;
  try {
    if (fs.openFileReader !== undefined) {
      return await hashWithOpenReader(fs, absolutePath, size, hash);
    }
    if (fs.readFileRange !== undefined) {
      return await hashRanges(
        (start, length) =>
          fs.readFileRange?.(absolutePath, start, length) ??
          Promise.reject(new Error("range reader unavailable")),
        size,
        hash,
      );
    }
    if (fs.readFileBytes === undefined || size > MAX_SINGLE_READ_BYTES) return false;
    const bytes = await fs.readFileBytes(absolutePath, size + 1);
    if (bytes.byteLength !== size) return false;
    hash.update(bytes);
    return true;
  } catch {
    return false;
  }
}

function isStableFile(
  before: ReturnType<WorkspaceFs["stat"]>,
  after: ReturnType<WorkspaceFs["stat"]>,
): boolean {
  if (!after.isFile || before.size !== after.size) return false;
  if (before.mtimeMs !== undefined && after.mtimeMs !== before.mtimeMs) return false;
  return before.ctimeMs === undefined || after.ctimeMs === before.ctimeMs;
}

function createFingerprintHash(tracked: boolean, size: number): Hash {
  const hash = createHash(tracked ? "sha1" : "sha256");
  if (tracked) hash.update(`blob ${String(size)}\0`, "utf8");
  return hash;
}

function fileFingerprint(
  relativePath: string,
  size: number,
  mtimeMs: number | undefined,
  tracked: boolean,
  contentFingerprint: string,
): RepositoryFileFingerprint {
  const fingerprint: RepositoryFileFingerprint = {
    relativePath,
    contentFingerprint,
    fingerprintKind: tracked ? "git-blob-sha1" : "file-state",
    byteLength: size,
  };
  return mtimeMs === undefined ? fingerprint : { ...fingerprint, mtimeMs };
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
    if (!stat.isFile || stat.size !== size) return undefined;
    const tracked = trackedPaths?.has(relativePath) === true;
    const hash = createFingerprintHash(tracked, size);
    if (!(await hashFileContent(fs, absolutePath, size, hash))) return undefined;
    const after = fs.stat(absolutePath);
    if (!isStableFile(stat, after)) return undefined;
    return fileFingerprint(relativePath, size, stat.mtimeMs, tracked, hash.digest("hex"));
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
  let complete = true;
  for (const result of walkSource(options.fs, options.scope, options.discovery)) {
    if (result.kind === "error") {
      rejectedEntries += 1;
      if (result.error.code !== "PATH_ESCAPE") complete = false;
      continue;
    }
    const fingerprint = await fingerprintFile(
      options.fs,
      options.scope.repositoryRoot,
      result.file.relativePath,
      result.file.sizeBytes,
      inferred,
    );
    if (fingerprint === undefined) {
      rejectedEntries += 1;
      complete = false;
    } else {
      fingerprints.push(fingerprint);
    }
  }
  return {
    fingerprints,
    rejectedEntries,
    complete,
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
    compareFingerprintKeys(left.relativePath, right.relativePath),
  )) {
    hash.update(item.relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(item.contentFingerprint, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}
