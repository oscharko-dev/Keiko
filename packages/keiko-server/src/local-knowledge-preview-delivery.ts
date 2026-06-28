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

export const MAX_PDF_PREVIEW_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_PREVIEW_RANGE_BYTES = 4 * 1024 * 1024;

type PreviewSourceResult =
  | {
      readonly kind: "ok";
      readonly bytes: Uint8Array;
      readonly fileName: string;
    }
  | {
      readonly kind: "rejected";
      readonly reason: PdfCitationPreviewReasonCode;
    };

interface ExistingDocumentRow {
  readonly content_hash: string;
  readonly document_path: string;
  readonly media_type: string;
  readonly safe_display_name: string;
  readonly size_bytes: number;
  readonly source_id: string;
  readonly status: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

async function readSourceBytes(
  absolutePath: string,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  let stat: ReturnType<typeof nodeWorkspaceFs.stat>;
  try {
    stat = nodeWorkspaceFs.stat(absolutePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile || stat.isSymbolicLink || (stat.hardLinkCount ?? 1) > 1) {
    return undefined;
  }
  if (stat.size > maxBytes) {
    return new Uint8Array(maxBytes + 1);
  }
  const bytes = await nodeWorkspaceFs.readFileBytes?.(absolutePath, stat.size);
  return bytes;
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
  return undefined;
}

async function loadVerifiedSourceBytes(
  authority: PdfCitationPreviewAuthority,
  document: ExistingDocumentRow,
  sources: readonly KnowledgeSource[],
): Promise<PreviewSourceResult> {
  const source = resolveSource(sources, authority.citation.lineage.sourceId);
  if (source === undefined) {
    return { kind: "rejected", reason: "preview-source-missing" };
  }
  const absolutePath = verifySourcePath(source, document.document_path);
  if (absolutePath === undefined || !nodeWorkspaceFs.exists(absolutePath)) {
    return { kind: "rejected", reason: "preview-source-missing" };
  }
  const bytes = await readSourceBytes(absolutePath, MAX_PDF_PREVIEW_BYTES);
  if (bytes === undefined) {
    return { kind: "rejected", reason: "preview-source-unreadable" };
  }
  if (bytes.byteLength > MAX_PDF_PREVIEW_BYTES) {
    return { kind: "rejected", reason: "preview-source-oversized" };
  }
  const expectedHash = authority.citation.documentContentHash;
  if (document.content_hash !== expectedHash || sha256Hex(bytes) !== expectedHash) {
    return { kind: "rejected", reason: "document-content-mismatch" };
  }
  return { kind: "ok", bytes, fileName: document.safe_display_name };
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
    return await loadVerifiedSourceBytes(authority, current.document, current.sources);
  } finally {
    current.close();
  }
}
