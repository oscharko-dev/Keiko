// Per-file extraction (Epic #189, Issue #194). Given a discovered file, a parser registry,
// and an open KnowledgeStore, this module:
//
//   1. Resolves the file's realPath through the WorkspaceFs port and re-asserts the
//      realpath-containment gate (defence in depth — the walker already filtered, but a
//      consumer calling extractDocument() directly must not bypass the boundary).
//   2. Reads bytes via WorkspaceFs.readFileBytes (the boundary-checked byte-read path).
//   3. Computes the content hash (SHA-256 hex) over the raw bytes.
//   4. Detects the incremental fast-path: if a documents row with the same id already has
//      this content_hash AND status="extracted"/"unsupported", we skip the parse entirely
//      and leave last_extracted_at untouched.
//   5. Resolves a parser through the registry; rejects an oversized file BEFORE we hand it
//      to the parser (the OVERSIZED_FILE diagnostic is the same code parsers emit).
//   6. Inside a single transaction: REPLACEs the documents row, deletes prior dependent
//      rows, then inserts the new pages/sections/parsed_units/diagnostics.

import { createHash } from "node:crypto";

import type {
  DocumentId,
  DocumentRecord,
  KnowledgeCapsuleId,
  KnowledgeSource,
  ParserDiagnostic,
  ParserResult,
} from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";

import type {
  AsyncParserAdapter,
  ParserAdapter,
  ParserOptions,
  ParserRegistry,
  ParserSelectionInput,
} from "../parsers/index.js";
import { buildParserOptions, unsupportedParser } from "../parsers/index.js";
import type { InternalParserResult } from "../parsers/types.js";
import { redactDiagnosticMessage } from "../privacy/diagnostic-redactor.js";
import type { KnowledgeStore } from "../store.js";
import { basenameOf, extensionOf, mediaTypeFor } from "./media-type.js";
import {
  deleteDependentRows,
  insertDiagnosticRow,
  insertDocumentRow,
  insertDocumentTextRow,
  insertPageRow,
  insertParsedUnitRow,
  insertSectionRow,
  readExistingDocumentRow,
} from "./persist.js";
import {
  documentIdFor,
  type DiscoveredFile,
  type DiscoveryError,
  type ExtractionOutcome,
  type ExtractionResult,
} from "./types.js";

export interface ExtractDocumentParams {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly source: KnowledgeSource;
  readonly file: DiscoveredFile;
  readonly parserOptions?: ParserOptions;
}

export interface ExtractDocumentDeps {
  readonly fs: WorkspaceFs;
  readonly store: KnowledgeStore;
  readonly parserRegistry: ParserRegistry;
}

// ─── Path helpers (re-derived to keep extract.ts self-contained for the realpath gate) ──
// On Windows, WorkspaceFs.realPath() may return backslash-separated paths
// (e.g. C:\Users\workspace\file). Normalise both sides to forward slashes so
// containment checks work cross-platform.
function normaliseSep(p: string): string {
  return p.replace(/\\/g, "/");
}

function isContained(absoluteRoot: string, absolutePath: string): boolean {
  const normRoot = normaliseSep(absoluteRoot);
  const normPath = normaliseSep(absolutePath);
  if (normPath === normRoot) return true;
  const prefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  return normPath.startsWith(prefix);
}

function joinAbs(root: string, rel: string): string {
  if (root.endsWith("/")) return `${root}${rel}`;
  return `${root}/${rel}`;
}

function scopeRoot(source: KnowledgeSource): string {
  const { scope } = source;
  if (scope.kind === "folder") return scope.rootPath;
  if (scope.kind === "repository") return scope.repositoryRoot;
  return scope.rootPath;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeDisplay(relativePath: string): string {
  const base = basenameOf(relativePath);
  return base.length === 0 ? relativePath : base;
}

function redactionPrefixFor(source: KnowledgeSource): string {
  return scopeRoot(source);
}

function redactMessage(message: string, source: KnowledgeSource): string {
  return redactDiagnosticMessage(message, redactionPrefixFor(source));
}

function redactDiagnostic(diagnostic: ParserDiagnostic, source: KnowledgeSource): ParserDiagnostic {
  return {
    ...diagnostic,
    message: redactMessage(diagnostic.message, source),
  };
}

function redactDiagnostics(
  diagnostics: readonly ParserDiagnostic[],
  source: KnowledgeSource,
): readonly ParserDiagnostic[] {
  return diagnostics.map((diagnostic) => redactDiagnostic(diagnostic, source));
}

function redactParserResult(
  parserResult: InternalParserResult,
  source: KnowledgeSource,
): InternalParserResult {
  return {
    ...parserResult,
    diagnostics: redactDiagnostics(parserResult.diagnostics, source),
  };
}

// ─── Failure / unsupported helpers ───────────────────────────────────────────
function buildFailureResult(
  params: ExtractDocumentParams,
  documentId: DocumentId,
  error: DiscoveryError,
): ExtractionResult {
  const redactedMessage = redactMessage(error.message, params.source);
  const diagnostic: ParserDiagnostic = {
    severity: "error",
    code: error.code,
    message: redactedMessage,
    documentId,
  };
  const document: DocumentRecord = {
    id: documentId,
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    documentPath: params.file.relativePath,
    sizeBytes: params.file.sizeBytes,
    mediaType: mediaTypeFor(extensionOf(params.file.relativePath)),
    contentHash: "",
    parser: { parserId: "none", parserVersion: "0" },
    lastExtractedAt: 0,
    status: "failed",
    safeDisplayName: safeDisplay(params.file.relativePath),
  };
  const outcome: ExtractionOutcome = {
    kind: "failed",
    document,
    error: { ...error, message: redactedMessage },
  };
  return {
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: params.file.relativePath,
    outcome,
    diagnostics: [diagnostic],
  };
}

// ─── Persist helpers (run inside the per-file transaction) ───────────────────
function persistDependentRows(
  deps: ExtractDocumentDeps,
  capsuleId: KnowledgeCapsuleId,
  documentId: DocumentId,
  parserResult: InternalParserResult,
  now: () => number,
): void {
  const db = deps.store._internal.db;
  deleteDependentRows(db, capsuleId, documentId);
  if (parserResult.normalizedText !== undefined) {
    insertDocumentTextRow(db, capsuleId, documentId, parserResult.normalizedText);
  }
  for (const page of parserResult.pages) insertPageRow(db, capsuleId, page);
  for (const section of parserResult.sections) insertSectionRow(db, capsuleId, section);
  parserResult.units.forEach((unit, index) => {
    insertParsedUnitRow(db, capsuleId, `${String(documentId)}#u${String(index)}`, unit);
  });
  parserResult.diagnostics.forEach((diagnostic, index) => {
    insertDiagnosticRow(db, {
      id: `${String(documentId)}#d${String(index)}`,
      capsuleId,
      diagnostic,
      createdAt: now(),
    });
  });
}

function buildDocumentRecord(input: {
  readonly documentId: DocumentId;
  readonly params: ExtractDocumentParams;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly parserResult: ParserResult;
  readonly status: DocumentRecord["status"];
}): DocumentRecord {
  return {
    id: input.documentId,
    capsuleId: input.params.capsuleId,
    sourceId: input.params.source.id,
    documentPath: input.params.file.relativePath,
    sizeBytes: input.params.file.sizeBytes,
    mediaType: input.mediaType,
    contentHash: input.contentHash,
    parser: input.parserResult.parser,
    lastExtractedAt: input.parserResult.extractedAt,
    status: input.status,
    safeDisplayName: safeDisplay(input.params.file.relativePath),
  };
}

function persistDocumentAndDependents(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  documentId: DocumentId,
  document: DocumentRecord,
  parserResult: InternalParserResult,
  now: () => number,
): void {
  const db = deps.store._internal.db;
  db.exec("BEGIN");
  try {
    insertDocumentRow(db, {
      id: documentId,
      capsuleId: params.capsuleId,
      sourceId: String(params.source.id),
      documentPath: document.documentPath,
      sizeBytes: document.sizeBytes,
      mediaType: document.mediaType,
      contentHash: document.contentHash,
      parserId: document.parser.parserId,
      parserVersion: document.parser.parserVersion,
      lastExtractedAt: document.lastExtractedAt,
      status: document.status,
      safeDisplayName: document.safeDisplayName,
    });
    persistDependentRows(deps, params.capsuleId, documentId, parserResult, now);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

// ─── Path/IO gate ────────────────────────────────────────────────────────────
interface ResolvedTarget {
  readonly absolutePath: string;
}

function resolveTargetPath(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
): ResolvedTarget | DiscoveryError {
  const root = scopeRoot(params.source);
  const absolute = joinAbs(root, params.file.relativePath);
  let real: string;
  try {
    real = deps.fs.realPath(absolute);
  } catch (cause) {
    return {
      code: "READ_FAILED",
      message: `realPath failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      relativePath: params.file.relativePath,
    };
  }
  if (!isContained(root, real)) {
    return {
      code: "PATH_ESCAPE",
      message: `realpath escapes scope root: ${params.file.relativePath}`,
      relativePath: params.file.relativePath,
    };
  }
  // Normalise to forward slashes so subsequent IO calls (readFileBytes, stat) receive
  // a consistent path even when realPath returned a Windows backslash path.
  return { absolutePath: normaliseSep(real) };
}

async function readBytes(
  deps: ExtractDocumentDeps,
  absolutePath: string,
  maxBytes: number,
): Promise<Uint8Array | DiscoveryError> {
  const reader = deps.fs.readFileBytes;
  if (reader === undefined) {
    return { code: "READ_FAILED", message: "WorkspaceFs.readFileBytes is unavailable" };
  }
  try {
    return await reader(absolutePath, maxBytes);
  } catch (cause) {
    return {
      code: "READ_FAILED",
      message: `readFileBytes failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

// ─── Incremental fast-path ───────────────────────────────────────────────────
function readUnchangedFastPath(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  documentId: DocumentId,
  contentHash: string,
): ExtractionResult | undefined {
  const existing = readExistingDocumentRow(deps.store._internal.db, params.capsuleId, documentId);
  if (existing === undefined) return undefined;
  if (existing.content_hash !== contentHash) return undefined;
  if (existing.status === "failed") return undefined;
  const document: DocumentRecord = {
    id: documentId,
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    documentPath: existing.document_path,
    sizeBytes: existing.size_bytes,
    mediaType: existing.media_type,
    contentHash: existing.content_hash,
    parser: {
      parserId: existing.parser_id,
      parserVersion: existing.parser_version,
    },
    lastExtractedAt: existing.last_extracted_at,
    status: existing.status as DocumentRecord["status"],
    safeDisplayName: existing.safe_display_name,
  };
  return {
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: params.file.relativePath,
    outcome: { kind: "skipped", document, reason: "unchanged" },
    diagnostics: [],
  };
}

// ─── Top-level entry point ───────────────────────────────────────────────────
function selectionInput(
  documentId: DocumentId,
  relativePath: string,
  bytes: Uint8Array,
): ParserSelectionInput {
  const extension = extensionOf(relativePath);
  return {
    documentId,
    bytes,
    extension,
    mediaType: mediaTypeFor(extension),
  };
}

function statusForResult(result: ParserResult): DocumentRecord["status"] {
  return result.parser.parserId === "unsupported" ? "unsupported" : "extracted";
}

const SOURCE_TEXT_PARSER_IDS: ReadonlySet<string> = new Set(["text", "json", "csv", "html"]);

function decodeUtf8ForStorage(bytes: Uint8Array): string {
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return raw.length > 0 && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function normalizedTextForPersistence(
  parserResult: InternalParserResult,
  bytes: Uint8Array,
): string | undefined {
  if (parserResult.normalizedText !== undefined) {
    return parserResult.normalizedText;
  }
  if (!SOURCE_TEXT_PARSER_IDS.has(parserResult.parser.parserId)) {
    return undefined;
  }
  if (parserResult.units.length === 0) {
    return undefined;
  }
  return decodeUtf8ForStorage(bytes);
}

function withPersistedNormalizedText(
  parserResult: InternalParserResult,
  bytes: Uint8Array,
): InternalParserResult {
  const normalizedText = normalizedTextForPersistence(parserResult, bytes);
  return normalizedText === undefined ? parserResult : { ...parserResult, normalizedText };
}

function hasAsyncParse(adapter: ParserAdapter | AsyncParserAdapter): adapter is AsyncParserAdapter {
  return typeof (adapter as { readonly parseAsync?: unknown }).parseAsync === "function";
}

async function runParser(
  deps: ExtractDocumentDeps,
  documentId: DocumentId,
  params: ExtractDocumentParams,
  bytes: Uint8Array,
  options: ParserOptions,
): Promise<InternalParserResult> {
  const input = selectionInput(documentId, params.file.relativePath, bytes);
  const resolution = deps.parserRegistry.resolve(input);
  const adapter = resolution.kind === "matched" ? resolution.adapter : unsupportedParser;
  if (hasAsyncParse(adapter)) {
    return adapter.parseAsync(input, options);
  }
  return adapter.parse(input, options);
}

async function runParserForPersistence(
  deps: ExtractDocumentDeps,
  documentId: DocumentId,
  params: ExtractDocumentParams,
  bytes: Uint8Array,
  options: ParserOptions,
): Promise<InternalParserResult> {
  const result = await runParser(deps, documentId, params, bytes, options);
  return withPersistedNormalizedText(result, bytes);
}

function persistExtractedDocument(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  documentId: DocumentId,
  document: DocumentRecord,
  parserResult: InternalParserResult,
): void {
  persistDocumentAndDependents(
    deps,
    params,
    documentId,
    document,
    parserResult,
    deps.store._internal.now,
  );
}

export async function extractDocument(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
): Promise<ExtractionResult> {
  const documentId = documentIdFor({
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: params.file.relativePath,
  });
  const resolved = resolveTargetPath(deps, params);
  if ("code" in resolved) {
    return buildFailureResult(params, documentId, resolved);
  }
  const options = params.parserOptions ?? buildParserOptions();
  if (params.file.sizeBytes > options.maxBytes) {
    return buildOversizedFailure(deps, params, documentId, options);
  }
  const bytes = await readBytes(deps, resolved.absolutePath, options.maxBytes);
  if (!(bytes instanceof Uint8Array)) {
    return buildFailureResult(params, documentId, bytes);
  }
  const contentHash = hashBytes(bytes);
  const fast = readUnchangedFastPath(deps, params, documentId, contentHash);
  if (fast !== undefined) return fast;
  const parserResult = await runParserForPersistence(deps, documentId, params, bytes, options);
  const redactedParserResult = redactParserResult(parserResult, params.source);
  const status = statusForResult(redactedParserResult);
  const document = buildDocumentRecord({
    documentId,
    params,
    mediaType: mediaTypeFor(extensionOf(params.file.relativePath)),
    contentHash,
    parserResult: redactedParserResult,
    status,
  });
  persistExtractedDocument(deps, params, documentId, document, redactedParserResult);
  return {
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: params.file.relativePath,
    outcome: { kind: "persisted", document },
    diagnostics: redactedParserResult.diagnostics,
  };
}

function oversizedDocumentRecord(
  params: ExtractDocumentParams,
  documentId: DocumentId,
  lastExtractedAt: number,
): DocumentRecord {
  return {
    id: documentId,
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    documentPath: params.file.relativePath,
    sizeBytes: params.file.sizeBytes,
    mediaType: mediaTypeFor(extensionOf(params.file.relativePath)),
    contentHash: "",
    parser: { parserId: "none", parserVersion: "0" },
    lastExtractedAt,
    status: "failed",
    safeDisplayName: safeDisplay(params.file.relativePath),
  };
}

function persistOversizedRow(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  documentId: DocumentId,
  document: DocumentRecord,
  diagnostic: ParserDiagnostic,
  now: () => number,
): void {
  const db = deps.store._internal.db;
  db.exec("BEGIN");
  try {
    insertDocumentRow(db, {
      id: documentId,
      capsuleId: params.capsuleId,
      sourceId: String(params.source.id),
      documentPath: document.documentPath,
      sizeBytes: document.sizeBytes,
      mediaType: document.mediaType,
      contentHash: document.contentHash,
      parserId: document.parser.parserId,
      parserVersion: document.parser.parserVersion,
      lastExtractedAt: document.lastExtractedAt,
      status: document.status,
      safeDisplayName: document.safeDisplayName,
    });
    deleteDependentRows(db, params.capsuleId, documentId);
    insertDiagnosticRow(db, {
      id: `${String(documentId)}#d0`,
      capsuleId: params.capsuleId,
      diagnostic,
      createdAt: now(),
    });
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

function buildOversizedFailure(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  documentId: DocumentId,
  options: ParserOptions,
): ExtractionResult {
  const now = deps.store._internal.now;
  const message = redactMessage(
    `file size ${String(params.file.sizeBytes)} exceeds maxBytes=${String(options.maxBytes)}`,
    params.source,
  );
  const diagnostic: ParserDiagnostic = {
    severity: "error",
    code: "OVERSIZED_FILE",
    message,
    documentId,
  };
  const document = oversizedDocumentRecord(params, documentId, now());
  persistOversizedRow(deps, params, documentId, document, diagnostic, now);
  return {
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: params.file.relativePath,
    outcome: {
      kind: "failed",
      document,
      error: { code: "OVERSIZED_FILE", message },
    },
    diagnostics: [diagnostic],
  };
}
