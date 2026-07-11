// Managed-LSP candidate, negotiation, and semantic-token contracts (Issue #2271, Epic #2094,
// ADR-0132). Static candidates never imply reachability: only a versioned negotiated snapshot may
// advertise an operation, and dynamic unregistration removes it fail closed.

import { LANGUAGE_SERVICE_OPERATIONS, type LanguageServiceOperation } from "./language-service.js";
import { MANAGED_LSP_LANGUAGES, type ManagedLspLanguage } from "./managed-lsp-activation.js";

export const MANAGED_LSP_CAPABILITY_SCHEMA_VERSION = "1" as const;
export const MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES = 64;
export const MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS = 16;
export const MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS = 10_000;

export type ManagedLspProtocolVersion = "3.17" | "3.18";
export type ManagedLspPositionEncoding = "utf-16" | "utf-8";
export type ManagedLspTextSync = "none" | "full" | "incremental";

export interface ManagedLspCandidateCapabilities {
  readonly schemaVersion: typeof MANAGED_LSP_CAPABILITY_SCHEMA_VERSION;
  readonly language: ManagedLspLanguage;
  readonly operations: readonly LanguageServiceOperation[];
  readonly semanticTokensCandidate: boolean;
}

export interface ManagedLspNegotiatedSemanticTokens {
  readonly supported: boolean;
  readonly legendVersion: number | null;
}

export interface ManagedLspNegotiatedCapabilitySnapshot {
  readonly schemaVersion: typeof MANAGED_LSP_CAPABILITY_SCHEMA_VERSION;
  readonly snapshotVersion: number;
  readonly configurationRevision: number;
  readonly language: ManagedLspLanguage;
  readonly protocolVersion: ManagedLspProtocolVersion;
  readonly positionEncoding: ManagedLspPositionEncoding;
  readonly textSync: ManagedLspTextSync;
  readonly candidateOperations: readonly LanguageServiceOperation[];
  readonly negotiatedOperations: readonly LanguageServiceOperation[];
  readonly dynamicallyUnregisteredOperations: readonly LanguageServiceOperation[];
  readonly semanticTokens: ManagedLspNegotiatedSemanticTokens;
}

export type ManagedLspSemanticTokenType =
  | "namespace"
  | "type"
  | "class"
  | "enum"
  | "interface"
  | "struct"
  | "typeParameter"
  | "parameter"
  | "variable"
  | "property"
  | "enumMember"
  | "event"
  | "function"
  | "method"
  | "macro"
  | "label"
  | "comment"
  | "string"
  | "number"
  | "regexp"
  | "operator"
  | "decorator"
  | "keyword";

export const MANAGED_LSP_SEMANTIC_TOKEN_TYPES: readonly ManagedLspSemanticTokenType[] =
  Object.freeze([
    "namespace",
    "type",
    "class",
    "enum",
    "interface",
    "struct",
    "typeParameter",
    "parameter",
    "variable",
    "property",
    "enumMember",
    "event",
    "function",
    "method",
    "macro",
    "label",
    "comment",
    "string",
    "number",
    "regexp",
    "operator",
    "decorator",
    "keyword",
  ] as const satisfies readonly ManagedLspSemanticTokenType[]);

export type ManagedLspSemanticTokenModifier =
  | "declaration"
  | "definition"
  | "readonly"
  | "static"
  | "deprecated"
  | "abstract"
  | "async"
  | "modification"
  | "documentation"
  | "defaultLibrary";

export const MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS: readonly ManagedLspSemanticTokenModifier[] =
  Object.freeze([
    "declaration",
    "definition",
    "readonly",
    "static",
    "deprecated",
    "abstract",
    "async",
    "modification",
    "documentation",
    "defaultLibrary",
  ] as const satisfies readonly ManagedLspSemanticTokenModifier[]);

export interface ManagedLspSemanticTokenLegend {
  readonly schemaVersion: typeof MANAGED_LSP_CAPABILITY_SCHEMA_VERSION;
  readonly legendVersion: number;
  readonly tokenTypes: readonly ManagedLspSemanticTokenType[];
  readonly tokenModifiers: readonly ManagedLspSemanticTokenModifier[];
  readonly returnedTypeCount: number;
  readonly totalTypeCount: number;
  readonly returnedModifierCount: number;
  readonly totalModifierCount: number;
  readonly truncated: boolean;
}

export interface ManagedLspSemanticTokenData {
  readonly schemaVersion: typeof MANAGED_LSP_CAPABILITY_SCHEMA_VERSION;
  readonly legendVersion: number;
  readonly documentVersion: number;
  readonly dataVersion: number;
  readonly data: readonly number[];
  readonly returnedTokenCount: number;
  readonly totalTokenCount: number;
  readonly truncated: boolean;
}

export interface ManagedLspSemanticTokenRequest {
  readonly schemaVersion: typeof MANAGED_LSP_CAPABILITY_SCHEMA_VERSION;
  readonly root: string;
  readonly document: {
    readonly path: string;
    readonly languageId: "rust";
    readonly text: string;
    readonly version: number;
  };
}

export interface ManagedLspSemanticTokenResponse {
  readonly schemaVersion: typeof MANAGED_LSP_CAPABILITY_SCHEMA_VERSION;
  readonly supported: boolean;
  readonly legend?: ManagedLspSemanticTokenLegend | undefined;
  readonly data?: ManagedLspSemanticTokenData | undefined;
}

export type ManagedLspCapabilityParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isManagedLanguage(value: unknown): value is ManagedLspLanguage {
  return typeof value === "string" && MANAGED_LSP_LANGUAGES.includes(value as ManagedLspLanguage);
}

function isLanguageOperation(value: unknown): value is LanguageServiceOperation {
  return (
    typeof value === "string" &&
    LANGUAGE_SERVICE_OPERATIONS.includes(value as LanguageServiceOperation)
  );
}

function isOperationArray(value: unknown): value is readonly LanguageServiceOperation[] {
  return (
    Array.isArray(value) &&
    value.length <= LANGUAGE_SERVICE_OPERATIONS.length &&
    value.every(isLanguageOperation) &&
    new Set(value).size === value.length
  );
}

function parseSafely<T>(
  parser: () => ManagedLspCapabilityParseResult<T>,
): ManagedLspCapabilityParseResult<T> {
  try {
    return parser();
  } catch (error: unknown) {
    return {
      ok: false,
      errors: [
        `payload could not be inspected: ${error instanceof Error ? error.name : "unknown"}`,
      ],
    };
  }
}

function parseCandidateUnsafe(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspCandidateCapabilities> {
  if (!isRecord(value)) return { ok: false, errors: ["candidate capabilities must be an object"] };
  const valid =
    hasOnlyKeys(value, ["schemaVersion", "language", "operations", "semanticTokensCandidate"]) &&
    value.schemaVersion === MANAGED_LSP_CAPABILITY_SCHEMA_VERSION &&
    isManagedLanguage(value.language) &&
    isOperationArray(value.operations) &&
    typeof value.semanticTokensCandidate === "boolean";
  return valid
    ? { ok: true, value: value as unknown as ManagedLspCandidateCapabilities }
    : { ok: false, errors: ["candidate capabilities are invalid or contain unknown fields"] };
}

export function parseManagedLspCandidateCapabilities(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspCandidateCapabilities> {
  return parseSafely(() => parseCandidateUnsafe(value));
}

function isNegotiatedSemanticTokens(value: unknown): value is ManagedLspNegotiatedSemanticTokens {
  if (!isRecord(value) || !hasOnlyKeys(value, ["supported", "legendVersion"])) return false;
  if (value.supported === false) return value.legendVersion === null;
  return value.supported === true && isPositiveInteger(value.legendVersion);
}

function isSubset(
  subset: readonly LanguageServiceOperation[],
  superset: readonly LanguageServiceOperation[],
): boolean {
  return subset.every((operation) => superset.includes(operation));
}

function hasNoOverlap(
  left: readonly LanguageServiceOperation[],
  right: readonly LanguageServiceOperation[],
): boolean {
  return left.every((operation) => !right.includes(operation));
}

function validNegotiationSets(value: UnknownRecord): boolean {
  if (
    !isOperationArray(value.candidateOperations) ||
    !isOperationArray(value.negotiatedOperations) ||
    !isOperationArray(value.dynamicallyUnregisteredOperations)
  ) {
    return false;
  }
  return (
    isSubset(value.negotiatedOperations, value.candidateOperations) &&
    isSubset(value.dynamicallyUnregisteredOperations, value.candidateOperations) &&
    hasNoOverlap(value.negotiatedOperations, value.dynamicallyUnregisteredOperations)
  );
}

function parseSnapshotUnsafe(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspNegotiatedCapabilitySnapshot> {
  if (!isRecord(value)) return { ok: false, errors: ["capability snapshot must be an object"] };
  const valid = [
    hasOnlyKeys(value, [
      "schemaVersion",
      "snapshotVersion",
      "configurationRevision",
      "language",
      "protocolVersion",
      "positionEncoding",
      "textSync",
      "candidateOperations",
      "negotiatedOperations",
      "dynamicallyUnregisteredOperations",
      "semanticTokens",
    ]),
    value.schemaVersion === MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
    isPositiveInteger(value.snapshotVersion),
    isNonNegativeInteger(value.configurationRevision),
    isManagedLanguage(value.language),
    ["3.17", "3.18"].includes(value.protocolVersion as string),
    ["utf-16", "utf-8"].includes(value.positionEncoding as string),
    ["none", "full", "incremental"].includes(value.textSync as string),
    validNegotiationSets(value),
    isNegotiatedSemanticTokens(value.semanticTokens),
  ].every(Boolean);
  return valid
    ? { ok: true, value: value as unknown as ManagedLspNegotiatedCapabilitySnapshot }
    : { ok: false, errors: ["capability snapshot is invalid or contains unknown fields"] };
}

export function parseManagedLspNegotiatedCapabilitySnapshot(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspNegotiatedCapabilitySnapshot> {
  return parseSafely(() => parseSnapshotUnsafe(value));
}

export function isManagedLspOperationNegotiated(
  snapshot: ManagedLspNegotiatedCapabilitySnapshot,
  operation: unknown,
): operation is LanguageServiceOperation {
  return (
    isLanguageOperation(operation) &&
    snapshot.negotiatedOperations.includes(operation) &&
    !snapshot.dynamicallyUnregisteredOperations.includes(operation)
  );
}

function isTokenType(value: unknown): value is ManagedLspSemanticTokenType {
  return (
    typeof value === "string" &&
    MANAGED_LSP_SEMANTIC_TOKEN_TYPES.includes(value as ManagedLspSemanticTokenType)
  );
}

function isTokenModifier(value: unknown): value is ManagedLspSemanticTokenModifier {
  return (
    typeof value === "string" &&
    MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS.includes(value as ManagedLspSemanticTokenModifier)
  );
}

function isUniqueCappedArray<T>(
  value: unknown,
  maximum: number,
  guard: (item: unknown) => item is T,
): value is readonly T[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(guard) &&
    new Set(value).size === value.length
  );
}

function honestLegendCounts(value: UnknownRecord): boolean {
  if (!Array.isArray(value.tokenTypes)) return false;
  if (!Array.isArray(value.tokenModifiers)) return false;
  if (!isNonNegativeInteger(value.returnedTypeCount)) return false;
  if (!isNonNegativeInteger(value.totalTypeCount)) return false;
  if (!isNonNegativeInteger(value.returnedModifierCount)) return false;
  if (!isNonNegativeInteger(value.totalModifierCount)) return false;
  const truncated = [
    value.totalTypeCount > value.returnedTypeCount,
    value.totalModifierCount > value.returnedModifierCount,
  ].some(Boolean);
  return [
    value.returnedTypeCount === value.tokenTypes.length,
    value.returnedModifierCount === value.tokenModifiers.length,
    value.totalTypeCount >= value.returnedTypeCount,
    value.totalModifierCount >= value.returnedModifierCount,
    value.truncated === truncated,
  ].every(Boolean);
}

function parseLegendUnsafe(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspSemanticTokenLegend> {
  if (!isRecord(value)) return { ok: false, errors: ["semantic-token legend must be an object"] };
  const valid =
    hasOnlyKeys(value, [
      "schemaVersion",
      "legendVersion",
      "tokenTypes",
      "tokenModifiers",
      "returnedTypeCount",
      "totalTypeCount",
      "returnedModifierCount",
      "totalModifierCount",
      "truncated",
    ]) &&
    value.schemaVersion === MANAGED_LSP_CAPABILITY_SCHEMA_VERSION &&
    isPositiveInteger(value.legendVersion) &&
    isUniqueCappedArray(value.tokenTypes, MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES, isTokenType) &&
    isUniqueCappedArray(
      value.tokenModifiers,
      MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS,
      isTokenModifier,
    ) &&
    typeof value.truncated === "boolean" &&
    honestLegendCounts(value);
  return valid
    ? { ok: true, value: value as unknown as ManagedLspSemanticTokenLegend }
    : { ok: false, errors: ["semantic-token legend is invalid or contains unknown fields"] };
}

export function parseManagedLspSemanticTokenLegend(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspSemanticTokenLegend> {
  return parseSafely(() => parseLegendUnsafe(value));
}

function validTokenTuple(
  data: readonly number[],
  offset: number,
  legend: ManagedLspSemanticTokenLegend,
): boolean {
  const deltaLine = data[offset];
  const deltaStart = data[offset + 1];
  const length = data[offset + 2];
  const tokenType = data[offset + 3];
  const modifiers = data[offset + 4];
  const maximumModifierMask = 2 ** legend.tokenModifiers.length - 1;
  return (
    isNonNegativeInteger(deltaLine) &&
    isNonNegativeInteger(deltaStart) &&
    isPositiveInteger(length) &&
    isNonNegativeInteger(tokenType) &&
    tokenType < legend.tokenTypes.length &&
    isNonNegativeInteger(modifiers) &&
    modifiers <= maximumModifierMask
  );
}

function validTokenDataArray(
  value: unknown,
  legend: ManagedLspSemanticTokenLegend,
): value is readonly number[] {
  if (!Array.isArray(value) || value.length % 5 !== 0) return false;
  if (value.length / 5 > MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS) return false;
  for (let offset = 0; offset < value.length; offset += 5) {
    if (!validTokenTuple(value, offset, legend)) return false;
  }
  return true;
}

function honestTokenCounts(value: UnknownRecord): boolean {
  if (!Array.isArray(value.data)) return false;
  if (
    !isNonNegativeInteger(value.returnedTokenCount) ||
    !isNonNegativeInteger(value.totalTokenCount)
  ) {
    return false;
  }
  return (
    value.returnedTokenCount === value.data.length / 5 &&
    value.totalTokenCount >= value.returnedTokenCount &&
    value.truncated === value.totalTokenCount > value.returnedTokenCount
  );
}

function parseTokenDataUnsafe(
  value: unknown,
  legend: ManagedLspSemanticTokenLegend,
): ManagedLspCapabilityParseResult<ManagedLspSemanticTokenData> {
  if (!isRecord(value)) return { ok: false, errors: ["semantic-token data must be an object"] };
  const valid =
    hasOnlyKeys(value, [
      "schemaVersion",
      "legendVersion",
      "documentVersion",
      "dataVersion",
      "data",
      "returnedTokenCount",
      "totalTokenCount",
      "truncated",
    ]) &&
    value.schemaVersion === MANAGED_LSP_CAPABILITY_SCHEMA_VERSION &&
    value.legendVersion === legend.legendVersion &&
    isNonNegativeInteger(value.documentVersion) &&
    isPositiveInteger(value.dataVersion) &&
    validTokenDataArray(value.data, legend) &&
    typeof value.truncated === "boolean" &&
    honestTokenCounts(value);
  return valid
    ? { ok: true, value: value as unknown as ManagedLspSemanticTokenData }
    : { ok: false, errors: ["semantic-token data is invalid or contains unknown fields"] };
}

export function parseManagedLspSemanticTokenData(
  value: unknown,
  legend: ManagedLspSemanticTokenLegend,
): ManagedLspCapabilityParseResult<ManagedLspSemanticTokenData> {
  return parseSafely(() => parseTokenDataUnsafe(value, legend));
}

export function managedLspSemanticTokensFitDocument(
  data: readonly number[],
  lineLengths: readonly number[],
): boolean {
  let line = 0;
  let start = 0;
  let previousEnd = 0;
  for (let offset = 0; offset < data.length; offset += 5) {
    const deltaLine = data[offset] ?? 0;
    const deltaStart = data[offset + 1] ?? 0;
    const length = data[offset + 2] ?? 0;
    if (deltaLine > 0) {
      line += deltaLine;
      start = deltaStart;
      previousEnd = 0;
    } else {
      start += deltaStart;
    }
    const end = start + length;
    const lineLength = lineLengths[line];
    if (
      lineLength === undefined ||
      !Number.isSafeInteger(end) ||
      end > lineLength ||
      start < previousEnd
    ) {
      return false;
    }
    previousEnd = end;
  }
  return true;
}

function safeRouteString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !hasForbiddenControl(value)
  );
}

function hasForbiddenControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (
      code !== undefined &&
      (code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13))
    ) {
      return true;
    }
  }
  return false;
}

function safeDocumentPath(value: unknown): value is string {
  if (!safeRouteString(value, 4_096) || value.startsWith("/") || value.startsWith("\\")) {
    return false;
  }
  return !value.split(/[\\/]/u).some((segment) => segment === ".." || segment.length === 0);
}

function parseSemanticRequestUnsafe(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspSemanticTokenRequest> {
  if (!isRecord(value) || !isRecord(value.document)) {
    return { ok: false, errors: ["semantic-token request must be an object"] };
  }
  const valid = validSemanticRequestRecord(value, value.document);
  return valid
    ? { ok: true, value: value as unknown as ManagedLspSemanticTokenRequest }
    : { ok: false, errors: ["semantic-token request is invalid or contains unknown fields"] };
}

function validSemanticRequestRecord(value: UnknownRecord, document: UnknownRecord): boolean {
  return (
    hasOnlyKeys(value, ["schemaVersion", "root", "document"]) &&
    hasOnlyKeys(document, ["path", "languageId", "text", "version"]) &&
    value.schemaVersion === MANAGED_LSP_CAPABILITY_SCHEMA_VERSION &&
    safeRouteString(value.root, 4_096) &&
    safeDocumentPath(document.path) &&
    document.languageId === "rust" &&
    typeof document.text === "string" &&
    document.text.length <= 524_288 &&
    isPositiveInteger(document.version)
  );
}

export function parseManagedLspSemanticTokenRequest(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspSemanticTokenRequest> {
  return parseSafely(() => parseSemanticRequestUnsafe(value));
}
