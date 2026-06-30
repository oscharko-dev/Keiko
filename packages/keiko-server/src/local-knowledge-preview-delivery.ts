import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type {
  KnowledgeCapsuleId,
  KnowledgeSource,
  KnowledgeSourceScope,
  PdfCitationPreviewReasonCode,
} from "@oscharko-dev/keiko-contracts";
import {
  listCapsuleSources,
  MAX_PDF_DOCUMENT_BLOB_BYTES,
  PDF_DOCUMENT_BLOB_MEDIA_TYPE,
  readPdfDocumentBlob,
  writePdfDocumentBlob,
  type KnowledgeStore,
  type PdfDocumentBlobRecord,
} from "@oscharko-dev/keiko-local-knowledge";
import { containedRealPathInfo, isDenied } from "@oscharko-dev/keiko-workspace";
import {
  nodeWorkspaceFs,
  type WorkspaceFileReader,
} from "@oscharko-dev/keiko-workspace/internal/fs";

import type { UiHandlerDeps } from "./deps.js";
import { openStoreForDeps } from "./local-knowledge-grounded-qa.js";
import type { PdfCitationPreviewAuthority } from "./local-knowledge-preview-service.js";

export const MAX_PDF_PREVIEW_BYTES = 1024 * 1024 * 1024;
export const MAX_PDF_PREVIEW_RANGE_BYTES = 4 * 1024 * 1024;
const PDF_PREVIEW_HASH_CHUNK_BYTES = 8 * 1024 * 1024;
const PDF_PREVIEW_STREAM_CHUNK_BYTES = 512 * 1024;
const MAX_PDF_PREVIEW_VERIFY_CONCURRENCY = 2;
const MAX_PDF_PREVIEW_VERIFY_QUEUE = 16;

let activePreviewVerifySlots = 0;
const queuedPreviewVerifySlots: (() => void)[] = [];

export type PdfPreviewSourceResult =
  | {
      readonly kind: "ok";
      readonly fileName: string;
      readonly source: PdfCitationPreviewSource;
    }
  | {
      readonly kind: "rejected";
      readonly reason: PdfCitationPreviewReasonCode;
    };

export interface PdfCitationPreviewSource {
  readonly absolutePath?: string | undefined;
  readonly byteLength: number;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly contentHash: string;
  readonly documentId: string;
  readonly fileName: string;
  readonly kind: "blob" | "filesystem";
  readonly mtimeMs?: number | undefined;
  readonly sourceId: string;
  readonly sourceRoot?: string | undefined;
  readonly storageKind?: "plaintext" | "sealed" | undefined;
}

interface ExistingDocumentRow {
  readonly blob_ref: string | null;
  readonly content_hash: string;
  readonly document_path: string;
  readonly media_type: string;
  readonly safe_display_name: string;
  readonly size_bytes: number;
  readonly source_id: string;
  readonly status: string;
}

function sourceRoot(scope: KnowledgeSourceScope): string {
  return scope.kind === "folder" || scope.kind === "files" ? scope.rootPath : scope.repositoryRoot;
}

function normalizeScopePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/u, "");
}

function normalizeScopePathLower(value: string): string {
  return normalizeScopePath(value).toLowerCase();
}

function allowsDocumentPath(scope: KnowledgeSourceScope, documentPath: string): boolean {
  if (scope.kind !== "files") return true;
  const expected = normalizeScopePathLower(documentPath);
  return scope.files.some((file) => normalizeScopePathLower(file) === expected);
}

function resolveSource(
  sources: readonly KnowledgeSource[],
  sourceId: string,
): KnowledgeSource | undefined {
  return sources.find((source) => source.id === sourceId);
}

function safeScopePathSegments(documentPath: string): readonly string[] | undefined {
  const normalized = normalizeScopePath(documentPath);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  return segments;
}

function resolveCaseInsensitivePath(root: string, documentPath: string): string | undefined {
  const segments = safeScopePathSegments(documentPath);
  if (segments === undefined) return undefined;
  let current = root;
  for (const segment of segments) {
    let entries: ReturnType<typeof nodeWorkspaceFs.readDir>;
    try {
      entries = nodeWorkspaceFs.readDir(current);
    } catch {
      return undefined;
    }
    const exact = entries.find((entry) => entry.name === segment);
    const match =
      exact ?? entries.find((entry) => entry.name.toLowerCase() === segment.toLowerCase());
    if (match === undefined) return undefined;
    current = resolve(current, match.name);
  }
  return current;
}

function containedSourcePath(
  root: string,
  candidate: string,
  documentPath: string,
): string | undefined {
  let contained: ReturnType<typeof containedRealPathInfo>;
  try {
    contained = containedRealPathInfo(nodeWorkspaceFs, root, candidate);
  } catch {
    return undefined;
  }
  const actual = normalizeScopePath(contained.realRelative);
  const expected = normalizeScopePath(documentPath);
  if (actual !== expected && actual.toLowerCase() !== expected.toLowerCase()) {
    return undefined;
  }
  if (isDenied(actual)) {
    return undefined;
  }
  return contained.path;
}

function verifySourcePath(source: KnowledgeSource, documentPath: string): string | undefined {
  const root = sourceRoot(source.scope);
  if (isDenied(root) || !allowsDocumentPath(source.scope, documentPath)) {
    return undefined;
  }
  const lexical = resolve(root, documentPath);
  const containedLexical = containedSourcePath(root, lexical, documentPath);
  if (containedLexical !== undefined) return containedLexical;
  const caseResolved = resolveCaseInsensitivePath(root, documentPath);
  return caseResolved === undefined
    ? undefined
    : containedSourcePath(root, caseResolved, documentPath);
}

function statSafeSource(absolutePath: string): ReturnType<typeof nodeWorkspaceFs.stat> | undefined {
  let stat: ReturnType<typeof nodeWorkspaceFs.stat>;
  try {
    stat = nodeWorkspaceFs.stat(absolutePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile || stat.isSymbolicLink) {
    return undefined;
  }
  return stat;
}

async function acquirePreviewVerifySlot(): Promise<boolean> {
  if (activePreviewVerifySlots < MAX_PDF_PREVIEW_VERIFY_CONCURRENCY) {
    activePreviewVerifySlots += 1;
    return true;
  }
  if (queuedPreviewVerifySlots.length >= MAX_PDF_PREVIEW_VERIFY_QUEUE) {
    return false;
  }
  await new Promise<void>((resolve) => {
    queuedPreviewVerifySlots.push(resolve);
  });
  return true;
}

function releasePreviewVerifySlot(): void {
  const next = queuedPreviewVerifySlots.shift();
  if (next !== undefined) {
    next();
    return;
  }
  activePreviewVerifySlots -= 1;
}

async function withPreviewVerifySlot<T>(work: () => Promise<T>): Promise<T | undefined> {
  const acquired = await acquirePreviewVerifySlot();
  if (!acquired) return undefined;
  try {
    return await work();
  } finally {
    releasePreviewVerifySlot();
  }
}

type Sha256SourceResult =
  | { readonly kind: "ok"; readonly hash: string }
  | { readonly kind: "dehydrated" }
  | { readonly kind: "unreadable" };

async function sha256Source(absolutePath: string, byteLength: number): Promise<Sha256SourceResult> {
  const readRange = nodeWorkspaceFs.readFileRange;
  if (readRange === undefined) return { kind: "unreadable" };
  const hash = createHash("sha256");
  for (let offset = 0; offset < byteLength; offset += PDF_PREVIEW_HASH_CHUNK_BYTES) {
    const length = Math.min(PDF_PREVIEW_HASH_CHUNK_BYTES, byteLength - offset);
    let bytes: Uint8Array;
    try {
      bytes = await readRange(absolutePath, offset, length);
    } catch {
      return { kind: "unreadable" };
    }
    if (bytes.byteLength !== length) return { kind: "dehydrated" };
    hash.update(bytes);
  }
  return { kind: "ok", hash: hash.digest("hex") };
}

function loadCurrentDocument(
  deps: UiHandlerDeps,
  authority: PdfCitationPreviewAuthority,
): {
  readonly document: ExistingDocumentRow | undefined;
  close: () => void;
  readonly sources: readonly KnowledgeSource[];
  readonly store: KnowledgeStore;
} {
  const session = openStoreForDeps(deps);
  const citation = authority.citation;
  const document = session.store._internal.db
    .prepare("SELECT * FROM documents WHERE capsule_id = :capsuleId AND id = :documentId")
    .get({
      capsuleId: String(citation.lineage.capsuleId),
      documentId: String(citation.lineage.documentId),
    }) as ExistingDocumentRow | undefined;
  return {
    document,
    close: (): void => {
      session.close();
    },
    sources: listCapsuleSources(session.store, citation.lineage.capsuleId),
    store: session.store,
  };
}

function validateDocumentMetadata(
  authority: PdfCitationPreviewAuthority,
  document: ExistingDocumentRow | undefined,
): PdfCitationPreviewReasonCode | undefined {
  const citation = authority.citation;
  if (document?.source_id !== citation.lineage.sourceId) {
    return "preview-source-missing";
  }
  if (document.status !== "extracted" && document.status !== "extracted-image") {
    return "document-not-ready";
  }
  if (document.media_type !== "application/pdf") {
    return "document-not-pdf";
  }
  if (document.content_hash !== citation.documentContentHash) {
    return "document-content-mismatch";
  }
  if (document.size_bytes > MAX_PDF_PREVIEW_BYTES) {
    return "preview-source-oversized";
  }
  return undefined;
}

function blobPreviewSource(
  capsuleId: KnowledgeCapsuleId,
  blob: PdfDocumentBlobRecord,
): PdfCitationPreviewSource {
  return {
    byteLength: blob.byteLength,
    capsuleId,
    contentHash: blob.contentHash,
    documentId: blob.documentId,
    fileName: blob.fileName,
    kind: "blob",
    sourceId: blob.sourceId,
    storageKind: blob.storageKind,
  };
}

function resolveBlobSource(
  store: KnowledgeStore,
  authority: PdfCitationPreviewAuthority,
): PdfPreviewSourceResult | undefined {
  const citation = authority.citation;
  const blob = readPdfDocumentBlob(store, citation.lineage.capsuleId, citation.lineage.documentId);
  if (blob.kind === "missing") return undefined;
  if (blob.kind === "unreadable") {
    return { kind: "rejected", reason: "preview-source-unreadable" };
  }
  if (blob.blob.byteLength > MAX_PDF_PREVIEW_BYTES) {
    return { kind: "rejected", reason: "preview-source-oversized" };
  }
  return {
    kind: "ok",
    fileName: blob.blob.fileName,
    source: blobPreviewSource(citation.lineage.capsuleId, blob.blob),
  };
}

function resolveFilesystemSource(
  authority: PdfCitationPreviewAuthority,
  document: ExistingDocumentRow,
  sources: readonly KnowledgeSource[],
): PdfPreviewSourceResult {
  const source = resolveSource(sources, authority.citation.lineage.sourceId);
  if (source === undefined) {
    return { kind: "rejected", reason: "preview-source-missing" };
  }
  const absolutePath = verifySourcePath(source, document.document_path);
  if (absolutePath === undefined || !nodeWorkspaceFs.exists(absolutePath)) {
    return { kind: "rejected", reason: "source-needs-rebind" };
  }
  const stat = statSafeSource(absolutePath);
  if (stat === undefined) {
    return { kind: "rejected", reason: "source-unavailable" };
  }
  if (stat.size > MAX_PDF_PREVIEW_BYTES) {
    return { kind: "rejected", reason: "preview-source-oversized" };
  }
  if (stat.size !== document.size_bytes) {
    return { kind: "rejected", reason: "source-modified" };
  }
  return {
    kind: "ok",
    fileName: document.safe_display_name,
    source: {
      absolutePath,
      byteLength: stat.size,
      capsuleId: authority.citation.lineage.capsuleId,
      contentHash: document.content_hash,
      documentId: String(authority.citation.lineage.documentId),
      fileName: document.safe_display_name,
      kind: "filesystem",
      ...(stat.mtimeMs === undefined ? {} : { mtimeMs: stat.mtimeMs }),
      sourceId: String(authority.citation.lineage.sourceId),
      sourceRoot: sourceRoot(source.scope),
    },
  };
}

function resolveCurrentSource(
  store: KnowledgeStore,
  authority: PdfCitationPreviewAuthority,
  document: ExistingDocumentRow,
  sources: readonly KnowledgeSource[],
): PdfPreviewSourceResult {
  const blob = resolveBlobSource(store, authority);
  if (blob !== undefined) return blob;
  return resolveFilesystemSource(authority, document, sources);
}

async function captureFilesystemSourceBlob(
  store: KnowledgeStore,
  source: PdfCitationPreviewSource,
): Promise<PdfCitationPreviewSource | undefined> {
  if (source.kind !== "filesystem" || source.absolutePath === undefined) return undefined;
  if (source.byteLength > MAX_PDF_DOCUMENT_BLOB_BYTES) return undefined;
  const readFileBytes = nodeWorkspaceFs.readFileBytes;
  if (readFileBytes === undefined) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = await readFileBytes(source.absolutePath, source.byteLength);
  } catch {
    return undefined;
  }
  if (bytes.byteLength !== source.byteLength) return undefined;
  try {
    const stored = writePdfDocumentBlob(store, {
      byteLength: source.byteLength,
      bytes,
      capsuleId: source.capsuleId,
      contentHash: source.contentHash,
      documentId: source.documentId,
      mediaType: PDF_DOCUMENT_BLOB_MEDIA_TYPE,
      sourceId: source.sourceId,
    });
    if (stored.kind !== "stored") return undefined;
    const blob = readPdfDocumentBlob(store, source.capsuleId, source.documentId);
    return blob.kind === "ok" ? blobPreviewSource(source.capsuleId, blob.blob) : undefined;
  } catch {
    return undefined;
  }
}

async function loadVerifiedSource(
  store: KnowledgeStore,
  authority: PdfCitationPreviewAuthority,
  document: ExistingDocumentRow,
  sources: readonly KnowledgeSource[],
): Promise<PdfPreviewSourceResult> {
  const resolved = resolveCurrentSource(store, authority, document, sources);
  if (resolved.kind !== "ok") return resolved;
  if (resolved.source.kind === "blob") return resolved;
  if (resolved.source.absolutePath === undefined) {
    return { kind: "rejected", reason: "preview-source-unreadable" };
  }
  const absolutePath = resolved.source.absolutePath;
  const actualHash = await withPreviewVerifySlot(() =>
    sha256Source(absolutePath, resolved.source.byteLength),
  );
  if (actualHash === undefined) {
    return { kind: "rejected", reason: "preview-source-unreadable" };
  }
  if (actualHash.kind === "dehydrated") {
    return { kind: "rejected", reason: "source-dehydrated" };
  }
  if (actualHash.kind === "unreadable") {
    return { kind: "rejected", reason: "preview-source-unreadable" };
  }
  if (actualHash.hash !== resolved.source.contentHash) {
    return { kind: "rejected", reason: "source-modified" };
  }
  const captured = await captureFilesystemSourceBlob(store, {
    ...resolved.source,
    documentId: String(authority.citation.lineage.documentId),
  });
  return captured === undefined
    ? resolved
    : { kind: "ok", fileName: resolved.fileName, source: captured };
}

export async function loadVerifiedPdfPreviewSource(
  deps: UiHandlerDeps,
  authority: PdfCitationPreviewAuthority,
): Promise<PdfPreviewSourceResult> {
  const current = loadCurrentDocument(deps, authority);
  try {
    const metadataFailure = validateDocumentMetadata(authority, current.document);
    if (metadataFailure !== undefined) {
      return { kind: "rejected", reason: metadataFailure };
    }
    if (current.document === undefined) {
      return { kind: "rejected", reason: "preview-source-missing" };
    }
    return await loadVerifiedSource(current.store, authority, current.document, current.sources);
  } finally {
    current.close();
  }
}

export function probePdfPreviewSourceAvailability(
  store: KnowledgeStore,
  authority: PdfCitationPreviewAuthority,
): PdfPreviewSourceResult {
  const citation = authority.citation;
  const document = store._internal.db
    .prepare("SELECT * FROM documents WHERE capsule_id = :capsuleId AND id = :documentId")
    .get({
      capsuleId: String(citation.lineage.capsuleId),
      documentId: String(citation.lineage.documentId),
    }) as ExistingDocumentRow | undefined;
  const metadataFailure = validateDocumentMetadata(authority, document);
  if (metadataFailure !== undefined) {
    return { kind: "rejected", reason: metadataFailure };
  }
  if (document === undefined) {
    return { kind: "rejected", reason: "preview-source-missing" };
  }
  return resolveCurrentSource(
    store,
    authority,
    document,
    listCapsuleSources(store, citation.lineage.capsuleId),
  );
}

function sourceMatchesSession(
  current: PdfCitationPreviewSource,
  expected: PdfCitationPreviewSource,
): boolean {
  if (current.kind !== expected.kind) return false;
  const sharedMatches =
    current.byteLength === expected.byteLength &&
    current.capsuleId === expected.capsuleId &&
    current.contentHash === expected.contentHash &&
    current.documentId === expected.documentId &&
    current.sourceId === expected.sourceId;
  if (current.kind === "blob") {
    return sharedMatches;
  }
  return sharedMatches && sourceFilesystemBindingMatches(current, expected);
}

function sourceFilesystemBindingMatches(
  current: PdfCitationPreviewSource,
  expected: PdfCitationPreviewSource,
): boolean {
  return current.absolutePath === expected.absolutePath && current.sourceRoot === expected.sourceRoot;
}

export function canReuseVerifiedPdfPreviewSource(source: PdfCitationPreviewSource): boolean {
  if (source.kind === "blob") return true;
  if (source.absolutePath === undefined) return false;
  const stat = statSafeSource(source.absolutePath);
  if (stat === undefined) return false;
  if (stat.size !== source.byteLength) return false;
  return (
    source.mtimeMs === undefined || stat.mtimeMs === undefined || stat.mtimeMs === source.mtimeMs
  );
}

export function loadPdfPreviewSourceForSession(
  deps: UiHandlerDeps,
  authority: PdfCitationPreviewAuthority,
  expected: PdfCitationPreviewSource,
): PdfPreviewSourceResult {
  const current = loadCurrentDocument(deps, authority);
  try {
    const metadataFailure = validateDocumentMetadata(authority, current.document);
    if (metadataFailure !== undefined) {
      return { kind: "rejected", reason: metadataFailure };
    }
    if (current.document === undefined) {
      return { kind: "rejected", reason: "preview-source-missing" };
    }
    const resolved = resolveCurrentSource(
      current.store,
      authority,
      current.document,
      current.sources,
    );
    if (resolved.kind !== "ok") return resolved;
    if (!sourceMatchesSession(resolved.source, expected)) {
      return { kind: "rejected", reason: "source-modified" };
    }
    return resolved;
  } finally {
    current.close();
  }
}

export async function openPdfPreviewSourceReader(
  deps: UiHandlerDeps,
  source: PdfCitationPreviewSource,
): Promise<WorkspaceFileReader | undefined> {
  if (source.kind === "blob") {
    const session = openStoreForDeps(deps);
    try {
      const blob = readPdfDocumentBlob(session.store, source.capsuleId, source.documentId);
      if (blob.kind !== "ok") return undefined;
      return memoryPdfPreviewReader(blob.blob.bytes);
    } finally {
      session.close();
    }
  }
  if (source.absolutePath === undefined) return undefined;
  const openFileReader = nodeWorkspaceFs.openFileReader;
  if (openFileReader === undefined) return undefined;
  try {
    return await openFileReader(source.absolutePath);
  } catch {
    return undefined;
  }
}

function memoryPdfPreviewReader(bytes: Uint8Array): WorkspaceFileReader {
  let closed = false;
  return {
    close: (): Promise<void> => {
      closed = true;
      return Promise.resolve();
    },
    readRange: (startByte: number, length: number): Promise<Uint8Array> => {
      if (closed) {
        return Promise.reject(new Error("PDF preview blob reader is closed."));
      }
      const start = Math.max(0, Math.floor(startByte));
      const cap = Math.max(0, Math.floor(length));
      return Promise.resolve(bytes.subarray(start, Math.min(bytes.byteLength, start + cap)));
    },
  };
}

export function pdfPreviewStreamChunkBytes(): number {
  return PDF_PREVIEW_STREAM_CHUNK_BYTES;
}
