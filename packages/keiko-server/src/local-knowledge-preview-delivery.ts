import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type {
  KnowledgeSource,
  KnowledgeSourceScope,
  PdfCitationPreviewReasonCode,
} from "@oscharko-dev/keiko-contracts";
import { listCapsuleSources } from "@oscharko-dev/keiko-local-knowledge";
import { containedRealPathInfo, isDenied } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import type { UiHandlerDeps } from "./deps.js";
import { openStoreForDeps } from "./local-knowledge-grounded-qa.js";
import type { PdfCitationPreviewAuthority } from "./local-knowledge-preview-service.js";

export const MAX_PDF_PREVIEW_BYTES = 1024 * 1024 * 1024;
export const MAX_PDF_PREVIEW_RANGE_BYTES = 4 * 1024 * 1024;
const PDF_PREVIEW_HASH_CHUNK_BYTES = 8 * 1024 * 1024;
const PDF_PREVIEW_STREAM_CHUNK_BYTES = 512 * 1024;

type PreviewSourceResult =
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
  readonly absolutePath: string;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly fileName: string;
  readonly mtimeMs?: number | undefined;
}

interface ExistingDocumentRow {
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

function allowsDocumentPath(scope: KnowledgeSourceScope, documentPath: string): boolean {
  if (scope.kind !== "files") return true;
  return scope.files.includes(documentPath);
}

function resolveSource(
  sources: readonly KnowledgeSource[],
  sourceId: string,
): KnowledgeSource | undefined {
  return sources.find((source) => source.id === sourceId);
}

function verifySourcePath(source: KnowledgeSource, documentPath: string): string | undefined {
  const root = sourceRoot(source.scope);
  if (isDenied(root) || !allowsDocumentPath(source.scope, documentPath)) {
    return undefined;
  }
  const lexical = resolve(root, documentPath);
  let contained: ReturnType<typeof containedRealPathInfo>;
  try {
    contained = containedRealPathInfo(nodeWorkspaceFs, root, lexical);
  } catch {
    return undefined;
  }
  if (normalizeScopePath(contained.realRelative) !== normalizeScopePath(documentPath)) {
    return undefined;
  }
  if (isDenied(normalizeScopePath(contained.realRelative))) {
    return undefined;
  }
  return contained.path;
}

function statSafeSource(absolutePath: string): ReturnType<typeof nodeWorkspaceFs.stat> | undefined {
  let stat: ReturnType<typeof nodeWorkspaceFs.stat>;
  try {
    stat = nodeWorkspaceFs.stat(absolutePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile || stat.isSymbolicLink || (stat.hardLinkCount ?? 1) > 1) {
    return undefined;
  }
  return stat;
}

async function sha256SourceHex(
  absolutePath: string,
  byteLength: number,
): Promise<string | undefined> {
  const readRange = nodeWorkspaceFs.readFileRange;
  if (readRange === undefined) return undefined;
  const hash = createHash("sha256");
  for (let offset = 0; offset < byteLength; offset += PDF_PREVIEW_HASH_CHUNK_BYTES) {
    const length = Math.min(PDF_PREVIEW_HASH_CHUNK_BYTES, byteLength - offset);
    const bytes = await readRange(absolutePath, offset, length);
    if (bytes.byteLength !== length) return undefined;
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function loadCurrentDocument(
  deps: UiHandlerDeps,
  authority: PdfCitationPreviewAuthority,
): {
  readonly document: ExistingDocumentRow | undefined;
  close: () => void;
  readonly sources: readonly KnowledgeSource[];
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
  if (document.status !== "extracted") {
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

function resolveCurrentSource(
  authority: PdfCitationPreviewAuthority,
  document: ExistingDocumentRow,
  sources: readonly KnowledgeSource[],
): PreviewSourceResult {
  const source = resolveSource(sources, authority.citation.lineage.sourceId);
  if (source === undefined) {
    return { kind: "rejected", reason: "preview-source-missing" };
  }
  const absolutePath = verifySourcePath(source, document.document_path);
  if (absolutePath === undefined || !nodeWorkspaceFs.exists(absolutePath)) {
    return { kind: "rejected", reason: "preview-source-missing" };
  }
  const stat = statSafeSource(absolutePath);
  if (stat === undefined) {
    return { kind: "rejected", reason: "preview-source-unreadable" };
  }
  if (stat.size > MAX_PDF_PREVIEW_BYTES) {
    return { kind: "rejected", reason: "preview-source-oversized" };
  }
  if (stat.size !== document.size_bytes) {
    return { kind: "rejected", reason: "document-content-mismatch" };
  }
  return {
    kind: "ok",
    fileName: document.safe_display_name,
    source: {
      absolutePath,
      byteLength: stat.size,
      contentHash: document.content_hash,
      fileName: document.safe_display_name,
      ...(stat.mtimeMs === undefined ? {} : { mtimeMs: stat.mtimeMs }),
    },
  };
}

async function loadVerifiedSource(
  authority: PdfCitationPreviewAuthority,
  document: ExistingDocumentRow,
  sources: readonly KnowledgeSource[],
): Promise<PreviewSourceResult> {
  const resolved = resolveCurrentSource(authority, document, sources);
  if (resolved.kind !== "ok") return resolved;
  const actualHash = await sha256SourceHex(
    resolved.source.absolutePath,
    resolved.source.byteLength,
  );
  if (actualHash === undefined) {
    return { kind: "rejected", reason: "preview-source-unreadable" };
  }
  if (actualHash !== resolved.source.contentHash) {
    return { kind: "rejected", reason: "document-content-mismatch" };
  }
  return resolved;
}

export async function loadVerifiedPdfPreviewSource(
  deps: UiHandlerDeps,
  authority: PdfCitationPreviewAuthority,
): Promise<PreviewSourceResult> {
  const current = loadCurrentDocument(deps, authority);
  try {
    const metadataFailure = validateDocumentMetadata(authority, current.document);
    if (metadataFailure !== undefined) {
      return { kind: "rejected", reason: metadataFailure };
    }
    if (current.document === undefined) {
      return { kind: "rejected", reason: "preview-source-missing" };
    }
    return await loadVerifiedSource(authority, current.document, current.sources);
  } finally {
    current.close();
  }
}

function sourceMatchesSession(
  current: PdfCitationPreviewSource,
  expected: PdfCitationPreviewSource,
): boolean {
  return (
    current.absolutePath === expected.absolutePath &&
    current.byteLength === expected.byteLength &&
    current.contentHash === expected.contentHash &&
    current.mtimeMs === expected.mtimeMs
  );
}

export function loadPdfPreviewSourceForSession(
  deps: UiHandlerDeps,
  authority: PdfCitationPreviewAuthority,
  expected: PdfCitationPreviewSource,
): PreviewSourceResult {
  const current = loadCurrentDocument(deps, authority);
  try {
    const metadataFailure = validateDocumentMetadata(authority, current.document);
    if (metadataFailure !== undefined) {
      return { kind: "rejected", reason: metadataFailure };
    }
    if (current.document === undefined) {
      return { kind: "rejected", reason: "preview-source-missing" };
    }
    const resolved = resolveCurrentSource(authority, current.document, current.sources);
    if (resolved.kind !== "ok") return resolved;
    if (!sourceMatchesSession(resolved.source, expected)) {
      return { kind: "rejected", reason: "document-content-mismatch" };
    }
    return resolved;
  } finally {
    current.close();
  }
}

export async function readPdfPreviewSourceRange(
  source: PdfCitationPreviewSource,
  start: number,
  length: number,
): Promise<Uint8Array | undefined> {
  const boundedLength = Math.min(length, PDF_PREVIEW_STREAM_CHUNK_BYTES);
  const bytes = await nodeWorkspaceFs.readFileRange?.(source.absolutePath, start, boundedLength);
  if (bytes?.byteLength !== boundedLength) {
    return undefined;
  }
  return bytes;
}

export function pdfPreviewStreamChunkBytes(): number {
  return PDF_PREVIEW_STREAM_CHUNK_BYTES;
}
