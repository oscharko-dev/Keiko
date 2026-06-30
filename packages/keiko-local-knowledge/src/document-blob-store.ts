import { createHash } from "node:crypto";

import type {
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY } from "@oscharko-dev/keiko-contracts";

import { KnowledgeStoreError } from "./errors.js";
import type { KnowledgeStore } from "./store.js";

export const PDF_DOCUMENT_BLOB_MEDIA_TYPE = "application/pdf";
export const MAX_PDF_DOCUMENT_BLOB_BYTES =
  DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY.largeFileThresholdBytes;

const INSERT_BLOB_SQL = [
  "INSERT OR IGNORE INTO document_blobs (",
  "  capsule_id, content_hash, byte_length, media_type, storage_kind, seal_version, blob_bytes,",
  "  created_at, created_source_id, created_document_id",
  ") VALUES (",
  "  :capsule_id, :content_hash, :byte_length, :media_type, :storage_kind, :seal_version, :blob_bytes,",
  "  :created_at, :created_source_id, :created_document_id",
  ")",
].join(" ");

const UPDATE_DOCUMENT_BLOB_REF_SQL =
  "UPDATE documents SET blob_ref = :content_hash WHERE capsule_id = :capsule_id AND id = :document_id";

const SELECT_DOCUMENT_BLOB_SQL = [
  "SELECT",
  "  d.id AS document_id, d.source_id AS source_id, d.content_hash AS document_content_hash,",
  "  d.size_bytes AS document_size_bytes, d.media_type AS document_media_type,",
  "  d.safe_display_name AS safe_display_name, d.blob_ref AS blob_ref,",
  "  b.content_hash AS blob_content_hash, b.byte_length AS blob_byte_length,",
  "  b.media_type AS blob_media_type, b.storage_kind AS storage_kind,",
  "  b.seal_version AS seal_version, b.blob_bytes AS blob_bytes, b.created_at AS created_at,",
  "  b.created_source_id AS created_source_id, b.created_document_id AS created_document_id",
  "FROM documents d",
  "LEFT JOIN document_blobs b ON b.capsule_id = d.capsule_id AND b.content_hash = d.blob_ref",
  "WHERE d.capsule_id = :capsule_id AND d.id = :document_id",
].join(" ");

const SELECT_DOCUMENT_BLOB_BY_HASH_SQL = [
  "SELECT",
  "  content_hash AS blob_content_hash, byte_length AS blob_byte_length,",
  "  media_type AS blob_media_type, storage_kind AS storage_kind,",
  "  seal_version AS seal_version, blob_bytes AS blob_bytes, created_at AS created_at,",
  "  created_source_id AS created_source_id, created_document_id AS created_document_id",
  "FROM document_blobs",
  "WHERE capsule_id = :capsule_id AND content_hash = :content_hash",
].join(" ");

type SqlValue = string | number | null | Uint8Array;

export interface PdfDocumentBlobInput {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId | string;
  readonly documentId: DocumentId | string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface PdfDocumentBlobMetadata {
  readonly byteLength: number;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly documentId: string;
  readonly mediaType: string;
  readonly sealVersion?: string | undefined;
  readonly sourceId: string;
  readonly storageKind: "plaintext" | "sealed";
}

export interface PdfDocumentBlobRecord extends PdfDocumentBlobMetadata {
  readonly bytes: Uint8Array;
  readonly fileName: string;
}

export type PdfDocumentBlobWriteResult =
  | { readonly kind: "stored"; readonly metadata: PdfDocumentBlobMetadata }
  | { readonly kind: "skipped"; readonly reason: "hash-mismatch" | "not-pdf" | "oversized" };

export type PdfDocumentBlobReadResult =
  | { readonly kind: "ok"; readonly blob: PdfDocumentBlobRecord }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: "hash-mismatch" | "malformed" };

interface DocumentBlobRow {
  readonly document_id: string;
  readonly source_id: string;
  readonly document_content_hash: string;
  readonly document_size_bytes: number;
  readonly document_media_type: string;
  readonly safe_display_name: string;
  readonly blob_ref: string | null;
  readonly blob_content_hash: string | null;
  readonly blob_byte_length: number | null;
  readonly blob_media_type: string | null;
  readonly storage_kind: "plaintext" | "sealed" | null;
  readonly seal_version: string | null;
  readonly blob_bytes: Uint8Array | null;
  readonly created_at: number | null;
  readonly created_source_id: string | null;
  readonly created_document_id: string | null;
}

interface CompleteDocumentBlobRow extends DocumentBlobRow {
  readonly blob_byte_length: number;
  readonly blob_content_hash: string;
  readonly blob_media_type: string;
  readonly blob_ref: string;
  readonly created_at: number;
  readonly storage_kind: "plaintext" | "sealed";
}

interface DocumentBlobByHashRow {
  readonly blob_byte_length: number;
  readonly blob_content_hash: string;
  readonly blob_media_type: string;
  readonly storage_kind: "plaintext" | "sealed";
  readonly seal_version: string | null;
  readonly blob_bytes: Uint8Array;
  readonly created_at: number;
  readonly created_source_id: string;
  readonly created_document_id: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isEligiblePdfBlob(input: PdfDocumentBlobInput): PdfDocumentBlobWriteResult | undefined {
  if (input.mediaType !== PDF_DOCUMENT_BLOB_MEDIA_TYPE) {
    return { kind: "skipped", reason: "not-pdf" };
  }
  if (input.byteLength > MAX_PDF_DOCUMENT_BLOB_BYTES) {
    return { kind: "skipped", reason: "oversized" };
  }
  if (input.bytes.byteLength !== input.byteLength || sha256Hex(input.bytes) !== input.contentHash) {
    return { kind: "skipped", reason: "hash-mismatch" };
  }
  return undefined;
}

function blobStorageKind(store: KnowledgeStore): "plaintext" | "sealed" {
  return store._internal.contentCipher.isEncrypted ? "sealed" : "plaintext";
}

function blobSealVersion(store: KnowledgeStore): string | null {
  return store._internal.contentCipher.isEncrypted ? "aes-256-gcm/v1" : null;
}

export function persistPdfDocumentBlobInTransaction(
  store: KnowledgeStore,
  input: PdfDocumentBlobInput,
): PdfDocumentBlobWriteResult {
  const ineligible = isEligiblePdfBlob(input);
  if (ineligible !== undefined) return ineligible;
  const storageKind = blobStorageKind(store);
  const sealVersion = blobSealVersion(store);
  const createdAt = store._internal.now();
  const storedBytes = store._internal.contentCipher.sealBlob(input.bytes);
  store._internal.db.prepare(INSERT_BLOB_SQL).run({
    capsule_id: String(input.capsuleId),
    content_hash: input.contentHash,
    byte_length: input.byteLength,
    media_type: input.mediaType,
    storage_kind: storageKind,
    seal_version: sealVersion,
    blob_bytes: storedBytes,
    created_at: createdAt,
    created_source_id: String(input.sourceId),
    created_document_id: String(input.documentId),
  } satisfies Record<string, SqlValue>);
  store._internal.db.prepare(UPDATE_DOCUMENT_BLOB_REF_SQL).run({
    capsule_id: String(input.capsuleId),
    document_id: String(input.documentId),
    content_hash: input.contentHash,
  });
  return {
    kind: "stored",
    metadata: {
      byteLength: input.byteLength,
      contentHash: input.contentHash,
      createdAt,
      documentId: String(input.documentId),
      mediaType: input.mediaType,
      ...(sealVersion === null ? {} : { sealVersion }),
      sourceId: String(input.sourceId),
      storageKind,
    },
  };
}

export function writePdfDocumentBlob(
  store: KnowledgeStore,
  input: PdfDocumentBlobInput,
): PdfDocumentBlobWriteResult {
  store._internal.db.exec("BEGIN");
  try {
    const result = persistPdfDocumentBlobInTransaction(store, input);
    store._internal.db.exec("COMMIT");
    return result;
  } catch (cause) {
    store._internal.db.exec("ROLLBACK");
    throw cause;
  }
}

function openedBlobBytes(store: KnowledgeStore, row: DocumentBlobRow): Uint8Array {
  if (row.blob_bytes === null || row.storage_kind === null) {
    throw new KnowledgeStoreError("PDF document blob row is incomplete");
  }
  if (row.storage_kind === "sealed" && !store._internal.contentCipher.isEncrypted) {
    throw new KnowledgeStoreError("sealed PDF document blob requires an encrypted store handle");
  }
  if (row.storage_kind === "plaintext" && store._internal.contentCipher.isEncrypted) {
    throw new KnowledgeStoreError("encrypted Local Knowledge store contains unsealed PDF blob");
  }
  return row.storage_kind === "sealed"
    ? store._internal.contentCipher.openBlob(row.blob_bytes)
    : row.blob_bytes;
}

function isCompletePdfBlobRow(row: DocumentBlobRow): row is CompleteDocumentBlobRow {
  return (
    row.blob_ref === row.document_content_hash &&
    row.blob_content_hash === row.document_content_hash &&
    row.blob_byte_length !== null &&
    row.blob_media_type !== null &&
    row.document_media_type === PDF_DOCUMENT_BLOB_MEDIA_TYPE &&
    row.blob_media_type === PDF_DOCUMENT_BLOB_MEDIA_TYPE &&
    row.storage_kind !== null &&
    row.created_at !== null
  );
}

function verifiedBlobBytes(
  store: KnowledgeStore,
  row: CompleteDocumentBlobRow,
): PdfDocumentBlobReadResult | Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = openedBlobBytes(store, row);
  } catch {
    return { kind: "unreadable", reason: "malformed" };
  }
  if (
    bytes.byteLength !== row.blob_byte_length ||
    row.blob_byte_length !== row.document_size_bytes ||
    sha256Hex(bytes) !== row.blob_content_hash
  ) {
    return { kind: "unreadable", reason: "hash-mismatch" };
  }
  return bytes;
}

function verifiedBlobBytesByHash(
  store: KnowledgeStore,
  row: DocumentBlobByHashRow,
): PdfDocumentBlobReadResult | Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = openedBlobBytes(store, {
      blob_bytes: row.blob_bytes,
      storage_kind: row.storage_kind,
    } as DocumentBlobRow);
  } catch {
    return { kind: "unreadable", reason: "malformed" };
  }
  if (bytes.byteLength !== row.blob_byte_length || sha256Hex(bytes) !== row.blob_content_hash) {
    return { kind: "unreadable", reason: "hash-mismatch" };
  }
  return bytes;
}

function blobReadOk(row: CompleteDocumentBlobRow, bytes: Uint8Array): PdfDocumentBlobReadResult {
  return {
    kind: "ok",
    blob: {
      bytes,
      byteLength: row.blob_byte_length,
      contentHash: row.blob_content_hash,
      createdAt: row.created_at,
      documentId: row.document_id,
      fileName: row.safe_display_name,
      mediaType: row.blob_media_type,
      ...(row.seal_version === null ? {} : { sealVersion: row.seal_version }),
      sourceId: row.source_id,
      storageKind: row.storage_kind,
    },
  };
}

function blobByHashReadOk(
  row: DocumentBlobByHashRow,
  bytes: Uint8Array,
  override?: {
    readonly documentId?: DocumentId | string;
    readonly fileName?: string;
    readonly sourceId?: KnowledgeSourceId | string;
  },
): PdfDocumentBlobReadResult {
  return {
    kind: "ok",
    blob: {
      bytes,
      byteLength: row.blob_byte_length,
      contentHash: row.blob_content_hash,
      createdAt: row.created_at,
      documentId: override?.documentId ?? row.created_document_id,
      fileName: override?.fileName ?? row.created_document_id,
      mediaType: row.blob_media_type,
      ...(row.seal_version === null ? {} : { sealVersion: row.seal_version }),
      sourceId: override?.sourceId ?? row.created_source_id,
      storageKind: row.storage_kind,
    },
  };
}

export function readPdfDocumentBlob(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId | string,
): PdfDocumentBlobReadResult {
  const row = store._internal.db.prepare(SELECT_DOCUMENT_BLOB_SQL).get({
    capsule_id: String(capsuleId),
    document_id: String(documentId),
  }) as DocumentBlobRow | undefined;
  if (row?.blob_ref == null || row.blob_content_hash === null) {
    return { kind: "missing" };
  }
  if (!isCompletePdfBlobRow(row)) {
    return { kind: "unreadable", reason: "malformed" };
  }
  const bytes = verifiedBlobBytes(store, row);
  return bytes instanceof Uint8Array ? blobReadOk(row, bytes) : bytes;
}

export function readPdfDocumentBlobByContentHash(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  contentHash: string,
  override?: {
    readonly documentId?: DocumentId | string;
    readonly fileName?: string;
    readonly sourceId?: KnowledgeSourceId | string;
  },
): PdfDocumentBlobReadResult {
  const row = store._internal.db.prepare(SELECT_DOCUMENT_BLOB_BY_HASH_SQL).get({
    capsule_id: String(capsuleId),
    content_hash: contentHash,
  }) as DocumentBlobByHashRow | undefined;
  if (row === undefined) return { kind: "missing" };
  if (row.blob_media_type !== PDF_DOCUMENT_BLOB_MEDIA_TYPE) {
    return { kind: "unreadable", reason: "malformed" };
  }
  const bytes = verifiedBlobBytesByHash(store, row);
  return bytes instanceof Uint8Array ? blobByHashReadOk(row, bytes, override) : bytes;
}
