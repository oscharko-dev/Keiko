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
  KnowledgeSourceScope,
  ParserDiagnostic,
  ParserResult,
} from "@oscharko-dev/keiko-contracts";
import { isSafeScopePath } from "@oscharko-dev/keiko-contracts";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { isDenied } from "@oscharko-dev/keiko-workspace";

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
import { compileGlobList, matchesAny, type CompiledGlob } from "./glob.js";
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
  type DiscoveryErrorCode,
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

function toPosixRelative(absoluteRoot: string, absolutePath: string): string {
  const normRoot = normaliseSep(absoluteRoot);
  const normPath = normaliseSep(absolutePath);
  if (normPath === normRoot) return "";
  const prefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  return normPath.startsWith(prefix) ? normPath.slice(prefix.length) : normPath;
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

function safeRelativePath(relativePath: string): string | DiscoveryError {
  const normalised = normaliseSep(relativePath);
  if (normalised.startsWith("/")) {
    return {
      code: "INVALID_SCOPE",
      message: "file path failed the selected-scope policy",
      relativePath,
    };
  }
  if (!isSafeScopePath(normalised)) {
    return {
      code: "INVALID_SCOPE",
      message: "file path failed the selected-scope policy",
      relativePath,
    };
  }
  return normalised;
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
function persistFailureRow(
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

function buildFailureResult(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  documentId: DocumentId,
  error: DiscoveryError,
  options: { readonly persist: boolean } = { persist: true },
): ExtractionResult {
  const now = deps.store._internal.now;
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
    lastExtractedAt: now(),
    status: "failed",
    safeDisplayName: safeDisplay(params.file.relativePath),
  };
  if (options.persist) {
    persistFailureRow(deps, params, documentId, document, diagnostic, now);
  }
  const outcome: ExtractionOutcome = {
    kind: "failed",
    document,
    error: { ...error, message: redactedMessage, relativePath: params.file.relativePath },
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
  readonly requestedAbsolutePath: string;
  readonly relativePath: string;
}

interface ScopePolicy {
  readonly rootPath: string;
  readonly recursive: boolean;
  readonly includeGlobs: readonly CompiledGlob[];
  readonly excludeGlobs: readonly CompiledGlob[];
  readonly explicitFiles?: ReadonlySet<string>;
}

type TargetResolution =
  | ResolvedTarget
  | { readonly error: DiscoveryError; readonly persistFailure: boolean };

const HIDDEN_OR_GENERATED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
]);

function deriveScopePolicy(scope: KnowledgeSourceScope): ScopePolicy | DiscoveryError {
  if (scope.kind === "folder") {
    if (!isSafeScopePath(scope.rootPath)) {
      return { code: "INVALID_SCOPE", message: "scope.rootPath failed the safe-path gate" };
    }
    return {
      rootPath: scope.rootPath,
      recursive: scope.recursive,
      includeGlobs: compileGlobList(scope.includeGlobs),
      excludeGlobs: compileGlobList(scope.excludeGlobs),
    };
  }
  if (scope.kind === "repository") {
    if (!isSafeScopePath(scope.repositoryRoot)) {
      return { code: "INVALID_SCOPE", message: "scope.repositoryRoot failed the safe-path gate" };
    }
    return {
      rootPath: scope.repositoryRoot,
      recursive: true,
      includeGlobs: compileGlobList(scope.includeGlobs),
      excludeGlobs: compileGlobList(scope.excludeGlobs),
    };
  }
  if (!isSafeScopePath(scope.rootPath)) {
    return { code: "INVALID_SCOPE", message: "scope.rootPath failed the safe-path gate" };
  }
  const explicitFiles = new Set<string>();
  for (const entry of scope.files) {
    const safeEntry = safeRelativePath(entry);
    if (typeof safeEntry !== "string") {
      return {
        code: "INVALID_SCOPE",
        message: `scope.files entry failed the safe-path gate: ${entry}`,
      };
    }
    explicitFiles.add(safeEntry);
  }
  return {
    rootPath: scope.rootPath,
    recursive: false,
    includeGlobs: [],
    excludeGlobs: [],
    explicitFiles,
  };
}

function matchesSourceGlobs(policy: ScopePolicy, relativePath: string): boolean {
  if (matchesAny(policy.excludeGlobs, relativePath, false)) return false;
  return matchesAny(policy.includeGlobs, relativePath, true);
}

function hasHiddenOrGeneratedParent(relativePath: string): boolean {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  for (const segment of segments.slice(0, -1)) {
    if (segment.startsWith(".") || HIDDEN_OR_GENERATED_DIRS.has(segment)) return true;
  }
  return false;
}

function isSelectedByScope(policy: ScopePolicy, relativePath: string): boolean {
  if (isDenied(relativePath)) return false;
  if (policy.explicitFiles !== undefined) return policy.explicitFiles.has(relativePath);
  if (!policy.recursive && relativePath.includes("/")) return false;
  if (hasHiddenOrGeneratedParent(relativePath)) return false;
  return matchesSourceGlobs(policy, relativePath);
}

function targetError(error: DiscoveryError, persistFailure: boolean): TargetResolution {
  return { error, persistFailure };
}

function selectedRelativePath(
  policy: ScopePolicy,
  rawRelativePath: string,
): string | TargetResolution {
  const relativePath = safeRelativePath(rawRelativePath);
  if (typeof relativePath !== "string") {
    return targetError(relativePath, false);
  }
  if (!isSelectedByScope(policy, relativePath)) {
    return targetError(
      {
        code: "INVALID_SCOPE",
        message: "file is outside the selected source scope",
        relativePath,
      },
      false,
    );
  }
  return relativePath;
}

function resolveTargetPath(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
): TargetResolution {
  const policy = deriveScopePolicy(params.source.scope);
  if ("code" in policy) {
    return targetError(policy, false);
  }
  const relativePath = selectedRelativePath(policy, params.file.relativePath);
  if (typeof relativePath !== "string") {
    return relativePath;
  }
  const root = policy.rootPath;
  const absolute = joinAbs(root, relativePath);
  let real: string;
  try {
    real = deps.fs.realPath(absolute);
  } catch {
    return targetError(
      {
        code: "READ_FAILED",
        message: "realPath failed for selected file",
        relativePath,
      },
      true,
    );
  }
  if (!isContained(root, real)) {
    return targetError(
      {
        code: "PATH_ESCAPE",
        message: `realpath escapes scope root: ${relativePath}`,
        relativePath,
      },
      true,
    );
  }
  const realRelativePath = toPosixRelative(root, real);
  if (isDenied(realRelativePath)) {
    return targetError(
      {
        code: "READ_FAILED",
        message: "resolved file is denied by workspace policy",
        relativePath,
      },
      true,
    );
  }
  // Normalise to forward slashes so subsequent IO calls (readFileBytes, stat) receive
  // a consistent path even when realPath returned a Windows backslash path.
  return { absolutePath: normaliseSep(real), requestedAbsolutePath: absolute, relativePath };
}

function validateRequestedTarget(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  target: ResolvedTarget,
): DiscoveryError | undefined {
  try {
    deps.fs.stat(target.requestedAbsolutePath);
    return undefined;
  } catch {
    return {
      code: "STAT_FAILED",
      message: "stat failed for selected file",
      relativePath: params.file.relativePath,
    };
  }
}

function validateResolvedTarget(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  target: ResolvedTarget,
): DiscoveryError | undefined {
  try {
    const realStat = deps.fs.stat(target.absolutePath);
    if (!realStat.isFile) {
      return {
        code: "READ_FAILED",
        message: "selected path is not a file",
        relativePath: params.file.relativePath,
      };
    }
    if (realStat.hardLinkCount === undefined || realStat.hardLinkCount <= 1) return undefined;
    return {
      code: "READ_FAILED",
      message: "selected file is not eligible for extraction",
      relativePath: params.file.relativePath,
    };
  } catch {
    return {
      code: "STAT_FAILED",
      message: "stat failed for selected file",
      relativePath: params.file.relativePath,
    };
  }
}

async function readBytes(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  target: ResolvedTarget,
  maxBytes: number,
): Promise<Uint8Array | DiscoveryError> {
  const reader = deps.fs.readFileBytes;
  if (reader === undefined) {
    return {
      code: "READ_FAILED",
      message: "WorkspaceFs.readFileBytes is unavailable",
      relativePath: params.file.relativePath,
    };
  }
  const requestedError = validateRequestedTarget(deps, params, target);
  if (requestedError !== undefined) return requestedError;
  const resolvedError = validateResolvedTarget(deps, params, target);
  if (resolvedError !== undefined) return resolvedError;
  try {
    return await reader(target.absolutePath, maxBytes);
  } catch {
    return {
      code: "READ_FAILED",
      message: "readFileBytes failed for selected file",
      relativePath: params.file.relativePath,
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

function isUnsupportedResult(result: ParserResult): boolean {
  return (
    result.parser.parserId === "unsupported" ||
    (result.units.length > 0 && result.units.every((unit) => unit.kind === "unsupported-media"))
  );
}

const FAILED_PARSER_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  "OVERSIZED_FILE",
  "PARSER_TIMEOUT",
  "PARSER_CANCELLED",
  "MALFORMED_INPUT",
  "OBJECT_LIMIT_REACHED",
]);

function firstParserFailureDiagnostic(result: ParserResult): ParserDiagnostic | undefined {
  return result.diagnostics.find(
    (diagnostic) =>
      diagnostic.severity === "error" || FAILED_PARSER_DIAGNOSTIC_CODES.has(diagnostic.code),
  );
}

function statusForResult(result: ParserResult): DocumentRecord["status"] {
  if (isUnsupportedResult(result)) return "unsupported";
  if (firstParserFailureDiagnostic(result) !== undefined) return "failed";
  return "extracted";
}

function discoveryErrorCodeForParserDiagnostic(diagnostic: ParserDiagnostic): DiscoveryErrorCode {
  if (diagnostic.code === "OVERSIZED_FILE") return "OVERSIZED_FILE";
  if (diagnostic.code === "PARSER_CANCELLED") return "CANCELLED";
  if (diagnostic.code === "MALFORMED_INPUT") return "MALFORMED_INPUT";
  if (diagnostic.code === "PARSER_TIMEOUT") return "PARSER_TIMEOUT";
  return "PARSER_FAILED";
}

function parserFailureOutcome(
  document: DocumentRecord,
  diagnostic: ParserDiagnostic,
  relativePath: string,
): ExtractionOutcome {
  return {
    kind: "failed",
    document,
    error: {
      code: discoveryErrorCodeForParserDiagnostic(diagnostic),
      message: diagnostic.message,
      relativePath,
    },
  };
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

async function readBoundedDocumentBytes(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  documentId: DocumentId,
  target: ResolvedTarget,
  options: ParserOptions,
): Promise<Uint8Array | ExtractionResult> {
  const bytes = await readBytes(deps, params, target, options.maxBytes + 1);
  if (!(bytes instanceof Uint8Array)) {
    return buildFailureResult(deps, params, documentId, bytes);
  }
  if (bytes.byteLength > options.maxBytes) {
    return buildOversizedFailure(deps, params, documentId, options, bytes.byteLength);
  }
  return bytes;
}

function parserExtractionResult(
  params: ExtractDocumentParams,
  document: DocumentRecord,
  parserResult: InternalParserResult,
  status: DocumentRecord["status"],
): ExtractionResult {
  const failureDiagnostic = firstParserFailureDiagnostic(parserResult);
  return {
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: params.file.relativePath,
    outcome:
      status === "failed" && failureDiagnostic !== undefined
        ? parserFailureOutcome(document, failureDiagnostic, params.file.relativePath)
        : { kind: "persisted", document },
    diagnostics: parserResult.diagnostics,
  };
}

function paramsWithRelativePath(
  params: ExtractDocumentParams,
  relativePath: string,
): ExtractDocumentParams {
  if (params.file.relativePath === relativePath) return params;
  return { ...params, file: { ...params.file, relativePath } };
}

function extractionDocumentId(params: ExtractDocumentParams): DocumentId {
  return documentIdFor({
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: params.file.relativePath,
  });
}

function targetResolutionFailure(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  resolved: Extract<TargetResolution, { readonly error: DiscoveryError }>,
): ExtractionResult {
  const failureParams =
    resolved.error.relativePath === undefined
      ? params
      : paramsWithRelativePath(params, resolved.error.relativePath);
  return buildFailureResult(
    deps,
    failureParams,
    extractionDocumentId(failureParams),
    resolved.error,
    {
      persist: resolved.persistFailure,
    },
  );
}

async function parseAndPersistDocument(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
  documentId: DocumentId,
  bytes: Uint8Array,
  contentHash: string,
  options: ParserOptions,
): Promise<ExtractionResult> {
  let parserResult: InternalParserResult;
  try {
    parserResult = await runParserForPersistence(deps, documentId, params, bytes, options);
  } catch {
    return buildFailureResult(deps, params, documentId, {
      code: "PARSER_FAILED",
      message: "parser adapter failed while extracting document",
      relativePath: params.file.relativePath,
    });
  }
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
  return parserExtractionResult(params, document, redactedParserResult, status);
}

export async function extractDocument(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams,
): Promise<ExtractionResult> {
  const resolved = resolveTargetPath(deps, params);
  if ("error" in resolved) {
    return targetResolutionFailure(deps, params, resolved);
  }
  const canonicalParams = paramsWithRelativePath(params, resolved.relativePath);
  const documentId = extractionDocumentId(canonicalParams);
  const options = canonicalParams.parserOptions ?? buildParserOptions();
  if (canonicalParams.file.sizeBytes > options.maxBytes) {
    return buildOversizedFailure(deps, canonicalParams, documentId, options);
  }
  const bytes = await readBoundedDocumentBytes(
    deps,
    canonicalParams,
    documentId,
    resolved,
    options,
  );
  if (!(bytes instanceof Uint8Array)) {
    return bytes;
  }
  const contentHash = hashBytes(bytes);
  const fast = readUnchangedFastPath(deps, canonicalParams, documentId, contentHash);
  if (fast !== undefined) return fast;
  return parseAndPersistDocument(deps, canonicalParams, documentId, bytes, contentHash, options);
}

export function recordExtractionFailure(
  deps: ExtractDocumentDeps,
  params: ExtractDocumentParams & { readonly error: DiscoveryError },
): ExtractionResult {
  const documentId = documentIdFor({
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    relativePath: params.file.relativePath,
  });
  return buildFailureResult(deps, params, documentId, params.error);
}

function oversizedDocumentRecord(
  params: ExtractDocumentParams,
  documentId: DocumentId,
  lastExtractedAt: number,
  observedSizeBytes?: number,
): DocumentRecord {
  const sizeBytes =
    observedSizeBytes === undefined
      ? params.file.sizeBytes
      : Math.max(params.file.sizeBytes, observedSizeBytes);
  return {
    id: documentId,
    capsuleId: params.capsuleId,
    sourceId: params.source.id,
    documentPath: params.file.relativePath,
    sizeBytes,
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
  observedSizeBytes?: number,
): ExtractionResult {
  const now = deps.store._internal.now;
  const sizeBytes =
    observedSizeBytes === undefined
      ? params.file.sizeBytes
      : Math.max(params.file.sizeBytes, observedSizeBytes);
  const message = redactMessage(
    `file size ${String(sizeBytes)} exceeds maxBytes=${String(options.maxBytes)}`,
    params.source,
  );
  const diagnostic: ParserDiagnostic = {
    severity: "error",
    code: "OVERSIZED_FILE",
    message,
    documentId,
  };
  const document = oversizedDocumentRecord(params, documentId, now(), observedSizeBytes);
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
