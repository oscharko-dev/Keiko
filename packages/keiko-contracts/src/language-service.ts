// Deterministic language-intelligence contracts (Issue #1198, Epic #1189, ADR-0042 D4). These are
// the governed, model-free request/response shapes for editor completion, diagnostics, hover, and
// document symbols. The deterministic language service is a keiko-server module and the single
// source of truth for these features; the in-browser Monaco worker is disabled for governed
// features (ADR-0042 D4).
//
// PROVIDER-PLUGGABLE BY DESIGN (Review Addendum 2): the contract names no concrete language. A
// provider declares which `languages` and `operations` it serves (LanguageProviderDescriptor), so
// adding a new language provider — TypeScript/JavaScript first, then the staged LSP expansion for
// Java/Python/Rust/Go (#1213) — requires no change to these shapes.
//
// This module owns the language-service contract namespace for the epic. It is kept disjoint from
// the editor-session namespace (#1197): no name overlap, no shared types. Unlike the content-free
// editor-session metadata, a language request necessarily carries the in-editor buffer text so
// diagnostics can reflect unsaved edits; the BFF redacts and caps every response before it reaches
// the browser and never logs the buffer.
//
// Leaf-package rules (ADR-0019): pure types and frozen const tables plus throw-free validators
// only. No filesystem, no clock, no crypto, no randomness, and no imports of other
// `@oscharko-dev/keiko-*` packages.

// Schema version for the language-service envelope. Bump as a new string member when the shape
// changes incompatibly; consumers pin against the literal to detect skew.
export const LANGUAGE_SERVICE_SCHEMA_VERSION = "1" as const;

// The governed operations. Completion, diagnostics, hover (quick info), document symbols,
// formatting, navigation, and refactoring are deterministic surfaces; each provider advertises the
// subset it implements. Formatting and rename return reviewable text edits an explicit, cancellable
// command/review flow applies; they are computed deterministically by the provider, never by a model.
export type LanguageServiceOperation =
  | "diagnostics"
  | "completion"
  | "hover"
  | "symbols"
  | "formatting"
  | "definition"
  | "references"
  | "renamePrepare"
  | "renameApply"
  | "codeActions"
  | "signatureHelp";

export const LANGUAGE_SERVICE_OPERATIONS: readonly LanguageServiceOperation[] = [
  "diagnostics",
  "completion",
  "hover",
  "symbols",
  "formatting",
  "definition",
  "references",
  "renamePrepare",
  "renameApply",
  "codeActions",
  "signatureHelp",
] as const;

// Stable, content-free error codes the editor relies on to drive recovery UX. The BFF emits them as
// static messages. `CANCELLED` is client abort; `TIMED_OUT` is the bounded-analysis deadline.
export type LanguageServiceErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_LANGUAGE"
  | "UNSUPPORTED_OPERATION"
  | "DOCUMENT_TOO_LARGE"
  | "DENIED"
  | "CANCELLED"
  | "TIMED_OUT";

export const LANGUAGE_SERVICE_ERROR_CODES: readonly LanguageServiceErrorCode[] = [
  "INVALID_REQUEST",
  "UNSUPPORTED_LANGUAGE",
  "UNSUPPORTED_OPERATION",
  "DOCUMENT_TOO_LARGE",
  "DENIED",
  "CANCELLED",
  "TIMED_OUT",
] as const;

// A zero-based source position aligned with LSP 3.17: `line` is the zero-based line and `character`
// is the zero-based UTF-16 code-unit offset within the line.
export interface LanguagePosition {
  readonly line: number;
  readonly character: number;
}

export interface LanguageRange {
  readonly start: LanguagePosition;
  readonly end: LanguagePosition;
}

// The document under analysis. `text` is the current (possibly unsaved) editor buffer — the overlay
// the analysis runs over, so diagnostics reflect unsaved edits. `path` is relative to the resolved
// workspace root; `languageId` selects the provider (for example `typescript`, `typescriptreact`,
// `javascript`, `javascriptreact`).
export interface LanguageDocumentOverlay {
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
}

export type LanguageDiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface LanguageDiagnostic {
  readonly range: LanguageRange;
  readonly severity: LanguageDiagnosticSeverity;
  readonly message: string;
  // The provider id that produced the diagnostic (for example `typescript`).
  readonly source: string;
  // Provider-specific diagnostic code, stringified so the wire shape stays language-agnostic.
  readonly code?: string;
}

// A closed, language-agnostic set of completion-item kinds (LSP-aligned). Providers map their
// native kinds onto these so the editor renders a stable icon set.
export type LanguageCompletionItemKind =
  | "text"
  | "method"
  | "function"
  | "constructor"
  | "field"
  | "variable"
  | "class"
  | "interface"
  | "module"
  | "property"
  | "value"
  | "enum"
  | "keyword"
  | "snippet"
  | "constant"
  | "struct"
  | "typeParameter";

export interface LanguageCompletionItem {
  readonly label: string;
  readonly kind: LanguageCompletionItemKind;
  readonly detail?: string;
  readonly documentation?: string;
  readonly insertText?: string;
  readonly sortText?: string;
}

export interface LanguageCompletionResult {
  readonly items: readonly LanguageCompletionItem[];
  // True when the provider reports the list is not exhaustive for the position.
  readonly isIncomplete: boolean;
  // True when items were dropped to honour the result cap.
  readonly truncated: boolean;
}

export interface LanguageDiagnosticsResult {
  readonly diagnostics: readonly LanguageDiagnostic[];
  // True when diagnostics were dropped to honour the result cap.
  readonly truncated: boolean;
}

export interface LanguageHoverResult {
  // Plain-text quick info, or null when the position has none. Markdown sinks stay disabled
  // (ADR-0042 D3.7), so this is rendered as text.
  readonly contents: string | null;
  readonly range?: LanguageRange;
}

// A closed, language-agnostic set of symbol kinds (LSP-aligned).
export type LanguageSymbolKind =
  | "file"
  | "module"
  | "namespace"
  | "class"
  | "method"
  | "property"
  | "field"
  | "constructor"
  | "enum"
  | "interface"
  | "function"
  | "variable"
  | "constant"
  | "struct"
  | "enumMember"
  | "typeParameter";

export interface LanguageDocumentSymbol {
  readonly name: string;
  readonly kind: LanguageSymbolKind;
  readonly range: LanguageRange;
  readonly detail?: string;
  readonly containerName?: string;
}

export interface LanguageSymbolResult {
  readonly symbols: readonly LanguageDocumentSymbol[];
  readonly truncated: boolean;
}

// A single reformatting edit (Issue #1201). `newText` replaces the source span identified by
// `range` — a reviewable code artifact the editor applies only when the user invokes the explicit
// "format document" command, never automatically. Edits within a result are non-overlapping, so the
// editor can apply them independently.
export interface LanguageTextEdit {
  readonly range: LanguageRange;
  readonly newText: string;
}

// Caller-supplied formatting preferences (Issue #1201). They mirror the editor's indentation
// settings so the deterministic provider reflows to the active configuration; both fields are
// optional and the provider falls back to its language default when either is absent. The tab-size
// ceiling is deliberately small: Monaco's UI emits normal editor widths, while the BFF boundary must
// reject pathological values before they can amplify provider CPU/memory work.
export const MAX_LANGUAGE_FORMATTING_TAB_SIZE = 16 as const;

export interface LanguageFormattingOptions {
  readonly tabSize?: number;
  readonly insertSpaces?: boolean;
}

export interface LanguageFormattingResult {
  readonly edits: readonly LanguageTextEdit[];
  // True when edits were dropped to honour the result cap.
  readonly truncated: boolean;
}

export interface LanguageLocation {
  readonly path: string;
  readonly range: LanguageRange;
}

export interface LanguageDefinitionResult {
  readonly locations: readonly LanguageLocation[];
  readonly truncated: boolean;
}

export interface LanguageReferencesResult {
  readonly locations: readonly LanguageLocation[];
  readonly includesDeclaration: boolean;
  readonly truncated: boolean;
}

export type LanguageRenamePrepareResult =
  | { readonly range: LanguageRange; readonly placeholder: string }
  | { readonly range: null; readonly reason: string };

export const LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION = "1" as const;

export interface LanguageRenameChangesetFile {
  readonly path: string;
  readonly edits: readonly LanguageTextEdit[];
  // Lowercase sha256 hex digest of the file's current content, the same convention as
  // `EditorAgentSessionSnapshot.activeFileContentHash` (ADR-0058), so the server-side staleness
  // check that applies this changeset compares like with like.
  readonly expectedContentHash: string;
}

export interface LanguageRenameChangeset {
  readonly schemaVersion: typeof LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION;
  readonly files: readonly LanguageRenameChangesetFile[];
  readonly truncated: boolean;
  readonly filesTruncated: boolean;
  readonly returnedFileCount: number;
  readonly totalFileCount: number;
  readonly returnedEditCount: number;
  readonly totalEditCount: number;
}

export type LanguageRenameApplyResult = LanguageRenameChangeset;

export type LanguageCodeActionKind = "quickfix" | "refactor" | "source";

export interface LanguageCodeAction {
  readonly title: string;
  readonly kind: LanguageCodeActionKind;
  readonly edits: readonly LanguageTextEdit[] | null;
}

export interface LanguageCodeActionsResult {
  readonly actions: readonly LanguageCodeAction[];
  readonly truncated: boolean;
  readonly returnedCount: number;
  readonly totalCount: number;
}

export interface LanguageSignatureParameterInformation {
  readonly label: string;
}

export interface LanguageSignatureInformation {
  readonly label: string;
  readonly documentation?: string;
  readonly parameters: readonly LanguageSignatureParameterInformation[];
}

export interface LanguageSignatureHelpResult {
  readonly signatures: readonly LanguageSignatureInformation[];
  readonly activeSignature: number | null;
  readonly activeParameter: number | null;
  readonly truncated: boolean;
  readonly returnedCount: number;
  readonly totalCount: number;
}

export type LanguageProviderAvailability = "available" | "unavailable";

// The pluggability surface. A provider declares its id, the `languages` it serves, and the
// `operations` it implements. The registry resolves a request's `languageId` to a provider; adding
// a language provider is a registration, never a contract change.
export interface LanguageProviderDescriptor {
  readonly id: string;
  readonly languages: readonly string[];
  readonly operations: readonly LanguageServiceOperation[];
  readonly availability: LanguageProviderAvailability;
  readonly unavailableReason?: string | undefined;
}

export interface LanguageServiceCapabilities {
  readonly schemaVersion: typeof LANGUAGE_SERVICE_SCHEMA_VERSION;
  readonly providers: readonly LanguageProviderDescriptor[];
}

// Bounds applied to every operation so expensive analysis stays capped and the wire payload stays
// small. `deadlineMs` bounds wall-clock analysis (cancellation); the rest cap result size and the
// per-string lengths sanitised before display.
export interface LanguageServiceLimits {
  readonly maxDocumentBytes: number;
  readonly maxCompletionItems: number;
  readonly maxDiagnostics: number;
  readonly maxSymbols: number;
  readonly maxFormattingEdits: number;
  readonly maxDefinitionLocations: number;
  readonly maxReferenceLocations: number;
  readonly maxCodeActions: number;
  readonly maxSignatures: number;
  readonly maxRenameChangesetFiles: number;
  readonly maxRenameChangesetEdits: number;
  readonly maxHoverChars: number;
  readonly maxLabelChars: number;
  readonly maxDetailChars: number;
  readonly maxDocumentationChars: number;
  readonly maxMessageChars: number;
  // Total workspace file bytes read while resolving imports/config for one operation. The in-memory
  // overlay and the TypeScript compiler's own lib directory are excluded from this workspace budget.
  readonly maxWorkspaceReadBytes: number;
  // Maximum bytes read from any single workspace file while resolving imports/config.
  readonly maxWorkspaceReadFileBytes: number;
  // Total workspace files read while resolving imports/config for one operation.
  readonly maxWorkspaceReadFiles: number;
  readonly deadlineMs: number;
}

export const DEFAULT_LANGUAGE_SERVICE_LIMITS: LanguageServiceLimits = {
  maxDocumentBytes: 1_000_000,
  maxCompletionItems: 256,
  maxDiagnostics: 512,
  maxSymbols: 512,
  maxFormattingEdits: 4_096,
  maxDefinitionLocations: 64,
  maxReferenceLocations: 512,
  maxCodeActions: 32,
  maxSignatures: 32,
  maxRenameChangesetFiles: 128,
  maxRenameChangesetEdits: 4_096,
  maxHoverChars: 4_096,
  maxLabelChars: 256,
  maxDetailChars: 1_024,
  maxDocumentationChars: 4_096,
  maxMessageChars: 2_048,
  maxWorkspaceReadBytes: 4_000_000,
  maxWorkspaceReadFileBytes: 1_000_000,
  maxWorkspaceReadFiles: 256,
  deadlineMs: 2_000,
} as const;

// ─── Request envelope (discriminated by `operation`) ────────────────────────────────────────────

export interface LanguageDiagnosticsRequest {
  readonly operation: "diagnostics";
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
}

export interface LanguageCompletionRequest {
  readonly operation: "completion";
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
  readonly position: LanguagePosition;
}

export interface LanguageHoverRequest {
  readonly operation: "hover";
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
  readonly position: LanguagePosition;
}

export interface LanguageSymbolsRequest {
  readonly operation: "symbols";
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
}

export interface LanguageFormattingRequest {
  readonly operation: "formatting";
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
  readonly options?: LanguageFormattingOptions;
}

export interface LanguageDefinitionRequest {
  readonly operation: "definition";
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
  readonly position: LanguagePosition;
}

export interface LanguageReferencesRequest {
  readonly operation: "references";
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
  readonly position: LanguagePosition;
}

export interface LanguageRenamePrepareRequest {
  readonly operation: "renamePrepare";
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
  readonly position: LanguagePosition;
}

export interface LanguageRenameApplyRequest {
  readonly operation: "renameApply";
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
  readonly position: LanguagePosition;
  readonly newName: string;
}

export interface LanguageCodeActionsRequest {
  readonly operation: "codeActions";
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
  readonly range: LanguageRange;
  readonly diagnostics: readonly LanguageDiagnostic[];
}

export interface LanguageSignatureHelpRequest {
  readonly operation: "signatureHelp";
  readonly root: string;
  readonly document: LanguageDocumentOverlay;
  readonly position: LanguagePosition;
}

export type LanguageServiceRequest =
  | LanguageDiagnosticsRequest
  | LanguageCompletionRequest
  | LanguageHoverRequest
  | LanguageSymbolsRequest
  | LanguageFormattingRequest
  | LanguageDefinitionRequest
  | LanguageReferencesRequest
  | LanguageRenamePrepareRequest
  | LanguageRenameApplyRequest
  | LanguageCodeActionsRequest
  | LanguageSignatureHelpRequest;

// ─── Pure validation (trust-boundary edge: the BFF validates a client-supplied request) ──────────
// Result envelope follows the package convention: a discriminated `{ ok: true; value } | { ok:
// false; errors }` so branches stay throw-free and the error strings are deterministic.

export interface LanguageServiceParseOk<T> {
  readonly ok: true;
  readonly value: T;
}
export interface LanguageServiceParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type LanguageServiceParse<T> = LanguageServiceParseOk<T> | LanguageServiceParseFail;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// A zero-based offset: a non-negative integer. Fractional or negative offsets can never index a
// source buffer, so they are rejected up front.
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isLanguagePosition(value: unknown): value is LanguagePosition {
  return (
    isRecord(value) && isNonNegativeInteger(value.line) && isNonNegativeInteger(value.character)
  );
}

export function isLanguageRange(value: unknown): value is LanguageRange {
  return (
    isRecord(value) &&
    isLanguagePosition(value.start) &&
    isLanguagePosition(value.end) &&
    comparePositions(value.start, value.end) <= 0
  );
}

function comparePositions(left: LanguagePosition, right: LanguagePosition): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.character - right.character;
}

export function isLanguageDocumentOverlay(value: unknown): value is LanguageDocumentOverlay {
  return (
    isRecord(value) &&
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.languageId) &&
    typeof value.text === "string"
  );
}

function isLanguageDiagnosticSeverity(value: unknown): value is LanguageDiagnosticSeverity {
  return value === "error" || value === "warning" || value === "info" || value === "hint";
}

export function isLanguageDiagnostic(value: unknown): value is LanguageDiagnostic {
  return (
    isRecord(value) &&
    isLanguageRange(value.range) &&
    isLanguageDiagnosticSeverity(value.severity) &&
    isNonEmptyString(value.message) &&
    isNonEmptyString(value.source) &&
    (value.code === undefined || typeof value.code === "string")
  );
}

// A tab width is a bounded positive integer column count; zero/fractional/pathological widths cannot
// describe a normal editor indentation setting and are rejected at the trust boundary.
function isTabSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_LANGUAGE_FORMATTING_TAB_SIZE
  );
}

// Formatting options are optional; an absent block is valid (the provider uses its default). When
// present, each declared field must be well-typed — a malformed `tabSize`/`insertSpaces` is rejected
// rather than silently dropped, so a hostile client cannot smuggle an unexpected shape past the BFF.
export function isLanguageFormattingOptions(value: unknown): value is LanguageFormattingOptions {
  if (!isRecord(value)) {
    return false;
  }
  if (value.tabSize !== undefined && !isTabSize(value.tabSize)) {
    return false;
  }
  if (value.insertSpaces !== undefined && typeof value.insertSpaces !== "boolean") {
    return false;
  }
  return true;
}

function isLanguageServiceOperation(value: unknown): value is LanguageServiceOperation {
  return (
    typeof value === "string" && (LANGUAGE_SERVICE_OPERATIONS as readonly string[]).includes(value)
  );
}

type PositionOperation = Extract<
  LanguageServiceOperation,
  | "completion"
  | "hover"
  | "definition"
  | "references"
  | "renamePrepare"
  | "renameApply"
  | "signatureHelp"
>;

type BaseDocumentOperation = Extract<LanguageServiceOperation, "diagnostics" | "symbols">;

const POSITION_OPERATIONS: readonly PositionOperation[] = [
  "completion",
  "hover",
  "definition",
  "references",
  "renamePrepare",
  "renameApply",
  "signatureHelp",
] as const;

const BASE_DOCUMENT_OPERATIONS: readonly BaseDocumentOperation[] = [
  "diagnostics",
  "symbols",
] as const;

function collectBaseErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(value.root)) {
    errors.push("root must be a non-empty string");
  }
  if (!isLanguageDocumentOverlay(value.document)) {
    errors.push("document must be { path, languageId, text }");
  }
  return errors;
}

function isPositionOperation(operation: LanguageServiceOperation): operation is PositionOperation {
  return POSITION_OPERATIONS.includes(operation as PositionOperation);
}

function isBaseDocumentOperation(
  operation: LanguageServiceOperation,
): operation is BaseDocumentOperation {
  return BASE_DOCUMENT_OPERATIONS.includes(operation as BaseDocumentOperation);
}

function isLanguageDiagnostics(value: unknown): value is readonly LanguageDiagnostic[] {
  return Array.isArray(value) && value.every(isLanguageDiagnostic);
}

function collectPositionErrors(
  operation: LanguageServiceOperation,
  value: Record<string, unknown>,
): readonly string[] {
  return isPositionOperation(operation) && !isLanguagePosition(value.position)
    ? ["position must be { line, character }"]
    : [];
}

function collectRangeErrors(
  operation: LanguageServiceOperation,
  value: Record<string, unknown>,
): readonly string[] {
  return operation === "codeActions" && !isLanguageRange(value.range)
    ? ["range must be { start, end }"]
    : [];
}

function collectRenameApplyErrors(
  operation: LanguageServiceOperation,
  value: Record<string, unknown>,
): readonly string[] {
  return operation === "renameApply" && !isNonEmptyString(value.newName)
    ? ["newName must be a non-empty string"]
    : [];
}

function collectCodeActionErrors(
  operation: LanguageServiceOperation,
  value: Record<string, unknown>,
): readonly string[] {
  return operation === "codeActions" && !isLanguageDiagnostics(value.diagnostics)
    ? ["diagnostics must be an array of LanguageDiagnostic"]
    : [];
}

function collectFormattingErrors(
  operation: LanguageServiceOperation,
  value: Record<string, unknown>,
): readonly string[] {
  return operation === "formatting" &&
    value.options !== undefined &&
    !isLanguageFormattingOptions(value.options)
    ? ["options must be { tabSize?, insertSpaces? }"]
    : [];
}

function collectOperationErrors(
  operation: LanguageServiceOperation,
  value: Record<string, unknown>,
): string[] {
  return [
    ...collectPositionErrors(operation, value),
    ...collectRangeErrors(operation, value),
    ...collectRenameApplyErrors(operation, value),
    ...collectCodeActionErrors(operation, value),
    ...collectFormattingErrors(operation, value),
  ];
}

// Validates an `unknown` payload into a LanguageServiceRequest, reporting one error per failed
// invariant. The BFF uses this to reject a malformed request with 400 INVALID_REQUEST.
export function parseLanguageServiceRequest(
  value: unknown,
): LanguageServiceParse<LanguageServiceRequest> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  if (!isLanguageServiceOperation(value.operation)) {
    return {
      ok: false,
      errors: [`operation must be one of: ${LANGUAGE_SERVICE_OPERATIONS.join(", ")}`],
    };
  }
  const operation = value.operation;
  const errors = [...collectBaseErrors(value), ...collectOperationErrors(operation, value)];
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: assembleRequest(operation, value) };
}

// Narrowing already guaranteed by parseLanguageServiceRequest; this assembles the concrete shape.
function assembleRequest(
  operation: LanguageServiceOperation,
  value: Record<string, unknown>,
): LanguageServiceRequest {
  const root = value.root as string;
  const document = value.document as LanguageDocumentOverlay;
  return assembleValidatedRequest(operation, root, document, value);
}

function assembleValidatedRequest(
  operation: LanguageServiceOperation,
  root: string,
  document: LanguageDocumentOverlay,
  value: Record<string, unknown>,
): LanguageServiceRequest {
  if (operation === "renameApply") {
    return assembleRenameApplyRequest(root, document, value);
  }
  if (isPositionOperation(operation)) {
    return assemblePositionRequest(operation, root, document, value);
  }
  if (operation === "codeActions") {
    return assembleCodeActionsRequest(root, document, value);
  }
  if (operation === "formatting") {
    return assembleFormattingRequest(root, document, value);
  }
  if (isBaseDocumentOperation(operation)) {
    return { operation, root, document };
  }
  return { operation, root, document };
}

function assembleRenameApplyRequest(
  root: string,
  document: LanguageDocumentOverlay,
  value: Record<string, unknown>,
): LanguageRenameApplyRequest {
  return {
    operation: "renameApply",
    root,
    document,
    position: value.position as LanguagePosition,
    newName: value.newName as string,
  };
}

function assemblePositionRequest(
  operation: Exclude<PositionOperation, "renameApply">,
  root: string,
  document: LanguageDocumentOverlay,
  value: Record<string, unknown>,
): Extract<
  LanguageServiceRequest,
  { readonly operation: Exclude<PositionOperation, "renameApply"> }
> {
  return {
    operation,
    root,
    document,
    position: value.position as LanguagePosition,
  };
}

function assembleCodeActionsRequest(
  root: string,
  document: LanguageDocumentOverlay,
  value: Record<string, unknown>,
): LanguageCodeActionsRequest {
  return {
    operation: "codeActions",
    root,
    document,
    range: value.range as LanguageRange,
    diagnostics: value.diagnostics as readonly LanguageDiagnostic[],
  };
}

function assembleFormattingRequest(
  root: string,
  document: LanguageDocumentOverlay,
  value: Record<string, unknown>,
): LanguageFormattingRequest {
  return value.options === undefined
    ? { operation: "formatting", root, document }
    : {
        operation: "formatting",
        root,
        document,
        options: value.options as LanguageFormattingOptions,
      };
}
