// Managed-LSP candidate, negotiation, and semantic-token contracts (Issue #2271, Epic #2094,
// ADR-0132). Static candidates never imply reachability: only a versioned negotiated snapshot may
// advertise an operation, and dynamic unregistration removes it fail closed.

import { LANGUAGE_SERVICE_OPERATIONS, type LanguageServiceOperation } from "./language-service.js";
import { MANAGED_LSP_LANGUAGES, type ManagedLspLanguage } from "./managed-lsp-activation.js";
import { parseSafely } from "./managed-lsp-parse-safely.js";

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

function isStringMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  const allowed: readonly string[] = values;
  return typeof value === "string" && allowed.includes(value);
}

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
  const managedLspLanguagesValues: readonly string[] = MANAGED_LSP_LANGUAGES;
  return typeof value === "string" && managedLspLanguagesValues.includes(value);
}

function isLanguageOperation(value: unknown): value is LanguageServiceOperation {
  const languageServiceOperationsValues: readonly string[] = LANGUAGE_SERVICE_OPERATIONS;
  return typeof value === "string" && languageServiceOperationsValues.includes(value);
}

function uniquePhysicalArrayFinalExtent(
  value: readonly unknown[],
  extent: number,
  members: ReadonlySet<unknown>,
): number | undefined {
  const finalExtent = value.length;
  return finalExtent === extent && members.size === finalExtent ? finalExtent : undefined;
}

function uniquePhysicalArrayExtent(
  value: unknown,
  maximum: number,
  guard: (entry: unknown) => boolean,
): number | undefined {
  if (!Array.isArray(value)) return undefined;
  const initiallyWithinLimit = value.length <= maximum;
  if (!initiallyWithinLimit) return undefined;
  const extent = value.length;
  if (!Number.isSafeInteger(extent) || extent < 0 || extent > maximum) return undefined;
  const members = new Set<unknown>();
  for (let index = 0; index < extent; index += 1) {
    if (!(index in value)) return undefined;
    const member: unknown = value[index];
    if (!guard(member)) return undefined;
    members.add(member);
  }
  return uniquePhysicalArrayFinalExtent(value, extent, members);
}

function isUniquePhysicalArray<T>(
  value: unknown,
  maximum: number,
  guard: (entry: unknown) => entry is T,
): value is readonly T[] {
  return uniquePhysicalArrayExtent(value, maximum, guard) !== undefined;
}

function isOperationArray(value: unknown): value is readonly LanguageServiceOperation[] {
  return isUniquePhysicalArray(value, LANGUAGE_SERVICE_OPERATIONS.length, isLanguageOperation);
}

function validCandidateUnsafe(
  value: UnknownRecord,
): value is UnknownRecord & ManagedLspCandidateCapabilities {
  return (
    hasOnlyKeys(value, ["schemaVersion", "language", "operations", "semanticTokensCandidate"]) &&
    value.schemaVersion === MANAGED_LSP_CAPABILITY_SCHEMA_VERSION &&
    isManagedLanguage(value.language) &&
    isOperationArray(value.operations) &&
    typeof value.semanticTokensCandidate === "boolean"
  );
}

function parseCandidateUnsafe(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspCandidateCapabilities> {
  if (!isRecord(value)) return { ok: false, errors: ["candidate capabilities must be an object"] };
  const valid = validCandidateUnsafe(value);
  return valid
    ? { ok: true, value }
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

function hasPhysicalOperation(
  values: readonly LanguageServiceOperation[],
  operation: LanguageServiceOperation,
): boolean {
  const extent = values.length;
  for (let index = 0; index < extent; index += 1) {
    if (values[index] === operation) return true;
  }
  return false;
}

function isSubset(
  subset: readonly LanguageServiceOperation[],
  superset: readonly LanguageServiceOperation[],
): boolean {
  const extent = subset.length;
  for (let index = 0; index < extent; index += 1) {
    const operation = subset[index];
    if (!isLanguageOperation(operation) || !hasPhysicalOperation(superset, operation)) return false;
  }
  return true;
}

function hasNoOverlap(
  left: readonly LanguageServiceOperation[],
  right: readonly LanguageServiceOperation[],
): boolean {
  const extent = left.length;
  for (let index = 0; index < extent; index += 1) {
    const operation = left[index];
    if (!isLanguageOperation(operation) || hasPhysicalOperation(right, operation)) return false;
  }
  return true;
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

function validSnapshotUnsafe(
  value: UnknownRecord,
): value is UnknownRecord & ManagedLspNegotiatedCapabilitySnapshot {
  return [
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
    isStringMember(value.protocolVersion, ["3.17", "3.18"]),
    isStringMember(value.positionEncoding, ["utf-16", "utf-8"]),
    isStringMember(value.textSync, ["none", "full", "incremental"]),
    validNegotiationSets(value),
    isNegotiatedSemanticTokens(value.semanticTokens),
  ].every(Boolean);
}

function parseSnapshotUnsafe(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspNegotiatedCapabilitySnapshot> {
  if (!isRecord(value)) return { ok: false, errors: ["capability snapshot must be an object"] };
  const valid = validSnapshotUnsafe(value);
  return valid
    ? { ok: true, value }
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
    hasPhysicalOperation(snapshot.negotiatedOperations, operation) &&
    !hasPhysicalOperation(snapshot.dynamicallyUnregisteredOperations, operation)
  );
}

function isTokenType(value: unknown): value is ManagedLspSemanticTokenType {
  const managedLspSemanticTokenTypesValues: readonly string[] = MANAGED_LSP_SEMANTIC_TOKEN_TYPES;
  return typeof value === "string" && managedLspSemanticTokenTypesValues.includes(value);
}

function isTokenModifier(value: unknown): value is ManagedLspSemanticTokenModifier {
  const managedLspSemanticTokenModifiersValues: readonly string[] =
    MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS;
  return typeof value === "string" && managedLspSemanticTokenModifiersValues.includes(value);
}

function honestLegendCounts(
  value: UnknownRecord,
  typeCount: number,
  modifierCount: number,
  truncated: boolean,
): boolean {
  const returnedTypeCount = value.returnedTypeCount;
  if (!isNonNegativeInteger(returnedTypeCount)) return false;
  const totalTypeCount = value.totalTypeCount;
  if (!isNonNegativeInteger(totalTypeCount)) return false;
  const returnedModifierCount = value.returnedModifierCount;
  if (!isNonNegativeInteger(returnedModifierCount)) return false;
  const totalModifierCount = value.totalModifierCount;
  if (!isNonNegativeInteger(totalModifierCount)) return false;
  return [
    returnedTypeCount === typeCount,
    returnedModifierCount === modifierCount,
    totalTypeCount >= returnedTypeCount,
    totalModifierCount >= returnedModifierCount,
    truncated ===
      (totalTypeCount > returnedTypeCount || totalModifierCount > returnedModifierCount),
  ].every(Boolean);
}

function validLegendArrays(value: UnknownRecord): boolean {
  const typeCount = uniquePhysicalArrayExtent(
    value.tokenTypes,
    MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES,
    isTokenType,
  );
  if (typeCount === undefined) return false;
  const modifierCount = uniquePhysicalArrayExtent(
    value.tokenModifiers,
    MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS,
    isTokenModifier,
  );
  if (modifierCount === undefined) return false;
  const truncated = value.truncated;
  return (
    typeof truncated === "boolean" && honestLegendCounts(value, typeCount, modifierCount, truncated)
  );
}

function validLegendUnsafe(
  value: UnknownRecord,
): value is UnknownRecord & ManagedLspSemanticTokenLegend {
  return (
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
    validLegendArrays(value)
  );
}

function parseLegendUnsafe(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspSemanticTokenLegend> {
  if (!isRecord(value)) return { ok: false, errors: ["semantic-token legend must be an object"] };
  const valid = validLegendUnsafe(value);
  return valid
    ? { ok: true, value }
    : { ok: false, errors: ["semantic-token legend is invalid or contains unknown fields"] };
}

export function parseManagedLspSemanticTokenLegend(
  value: unknown,
): ManagedLspCapabilityParseResult<ManagedLspSemanticTokenLegend> {
  return parseSafely(() => parseLegendUnsafe(value));
}

function validTokenTuple(
  data: readonly unknown[],
  offset: number,
  typeCount: number,
  maximumModifierMask: number,
): boolean {
  const deltaLine = data[offset];
  const deltaStart = data[offset + 1];
  const length = data[offset + 2];
  const tokenType = data[offset + 3];
  const modifiers = data[offset + 4];
  return (
    isNonNegativeInteger(deltaLine) &&
    isNonNegativeInteger(deltaStart) &&
    isPositiveInteger(length) &&
    isNonNegativeInteger(tokenType) &&
    tokenType < typeCount &&
    isNonNegativeInteger(modifiers) &&
    modifiers <= maximumModifierMask
  );
}

function tokenDataExtent(data: readonly unknown[]): number | undefined {
  const initial = data.length;
  if (!isNonNegativeInteger(initial) || initial % 5 !== 0) return undefined;
  const extent = data.length;
  return isNonNegativeInteger(extent) &&
    extent % 5 === 0 &&
    extent / 5 <= MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS
    ? extent
    : undefined;
}

function tokenLegendBounds(
  legend: ManagedLspSemanticTokenLegend,
): { readonly typeCount: number; readonly maximumModifierMask: number } | undefined {
  const types = legend.tokenTypes;
  const modifiers = legend.tokenModifiers;
  if (!Array.isArray(types) || !Array.isArray(modifiers)) return undefined;
  const typeCount = types.length;
  const modifierCount = modifiers.length;
  if (
    !isNonNegativeInteger(typeCount) ||
    typeCount > MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES ||
    !isNonNegativeInteger(modifierCount) ||
    modifierCount > MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS
  )
    return undefined;
  return { typeCount, maximumModifierMask: 2 ** modifierCount - 1 };
}

function validTokenDataArray(
  value: unknown,
  legend: ManagedLspSemanticTokenLegend,
): number | undefined {
  if (!Array.isArray(value)) return undefined;
  const extent = tokenDataExtent(value);
  if (extent === undefined) return undefined;
  const bounds = tokenLegendBounds(legend);
  if (bounds === undefined) return undefined;
  for (let offset = 0; offset < extent; offset += 5) {
    if (!validTokenTuple(value, offset, bounds.typeCount, bounds.maximumModifierMask))
      return undefined;
  }
  return value.length === extent ? extent / 5 : undefined;
}

function honestTokenCounts(value: UnknownRecord, count: number, truncated: boolean): boolean {
  const returnedTokenCount = value.returnedTokenCount;
  if (!isNonNegativeInteger(returnedTokenCount)) return false;
  const totalTokenCount = value.totalTokenCount;
  if (!isNonNegativeInteger(totalTokenCount)) return false;
  return (
    returnedTokenCount === count &&
    totalTokenCount >= returnedTokenCount &&
    truncated === totalTokenCount > returnedTokenCount
  );
}

function validTokenPayload(value: UnknownRecord, legend: ManagedLspSemanticTokenLegend): boolean {
  const count = validTokenDataArray(value.data, legend);
  if (count === undefined) return false;
  const truncated = value.truncated;
  return typeof truncated === "boolean" && honestTokenCounts(value, count, truncated);
}

function validTokenDataUnsafe(
  value: UnknownRecord,
  legend: ManagedLspSemanticTokenLegend,
): value is UnknownRecord & ManagedLspSemanticTokenData {
  return (
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
    validTokenPayload(value, legend)
  );
}

function parseTokenDataUnsafe(
  value: unknown,
  legend: ManagedLspSemanticTokenLegend,
): ManagedLspCapabilityParseResult<ManagedLspSemanticTokenData> {
  if (!isRecord(value)) return { ok: false, errors: ["semantic-token data must be an object"] };
  const valid = validTokenDataUnsafe(value, legend);
  return valid
    ? { ok: true, value }
    : { ok: false, errors: ["semantic-token data is invalid or contains unknown fields"] };
}

export function parseManagedLspSemanticTokenData(
  value: unknown,
  legend: ManagedLspSemanticTokenLegend,
): ManagedLspCapabilityParseResult<ManagedLspSemanticTokenData> {
  return parseSafely(() => parseTokenDataUnsafe(value, legend));
}

function checkedTokenPositionsFitDocument(
  data: readonly number[],
  lineLengths: readonly number[],
  extent: number,
): boolean {
  let line = 0;
  let start = 0;
  let previousEnd = 0;
  for (let offset = 0; offset < extent; offset += 5) {
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
  return data.length === extent;
}

export function managedLspSemanticTokensFitDocument(
  data: readonly number[],
  lineLengths: readonly number[],
): boolean {
  const tokens: readonly number[] = data;
  if (!Array.isArray(data)) return false;
  const extent = tokenDataExtent(tokens);
  return extent !== undefined && checkedTokenPositionsFitDocument(tokens, lineLengths, extent);
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
  if (
    !safeRouteString(value, 4_096) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value)
  ) {
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
  const valid = validSemanticRequestRecord(value);
  return valid
    ? { ok: true, value }
    : { ok: false, errors: ["semantic-token request is invalid or contains unknown fields"] };
}

function validSemanticRequestRecord(
  value: UnknownRecord,
): value is UnknownRecord & ManagedLspSemanticTokenRequest {
  const document = value.document;
  if (!isRecord(document)) return false;
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
