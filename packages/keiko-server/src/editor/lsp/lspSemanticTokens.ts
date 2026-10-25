import type {
  ManagedLspSemanticTokenData,
  ManagedLspSemanticTokenLegend,
  ManagedLspSemanticTokenModifier,
  ManagedLspSemanticTokenType,
} from "@oscharko-dev/keiko-contracts";
import {
  MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES,
  MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS,
  MANAGED_LSP_SEMANTIC_TOKEN_TYPES,
  parseManagedLspSemanticTokenData,
  parseManagedLspSemanticTokenLegend,
} from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities";

export const MANAGED_LSP_SEMANTIC_MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_LEGEND_VALUE_CHARS = 64;

const CUSTOM_TOKEN_TYPES: Readonly<Record<string, ManagedLspSemanticTokenType>> = Object.freeze({
  attribute: "decorator",
  boolean: "keyword",
  builtinType: "type",
  deriveHelper: "macro",
  escapeSequence: "string",
  formatSpecifier: "string",
  punctuation: "operator",
  unresolvedReference: "variable",
});

const CUSTOM_TOKEN_MODIFIERS: Readonly<Record<string, ManagedLspSemanticTokenModifier>> =
  Object.freeze({
    constant: "readonly",
    library: "defaultLibrary",
    mutable: "modification",
  });

export interface LspSemanticTokenNegotiation {
  readonly legend: ManagedLspSemanticTokenLegend;
  readonly tokenTypeMap: readonly (number | null)[];
  readonly tokenModifierMap: readonly (number | null)[];
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawArrayExtent(value: readonly unknown[], maximum: number): number | undefined {
  const initial = value.length;
  if (!(initial <= maximum)) return undefined;
  const extent = value.length;
  return Number.isSafeInteger(extent) && extent >= 0 && extent <= maximum ? extent : undefined;
}

function captureRawLegendValues(value: unknown, maximum: number): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const extent = rawArrayExtent(value, maximum);
  if (extent === undefined) return undefined;
  const entries: string[] = [];
  for (let index = 0; index < extent; index += 1) {
    const member: unknown = value[index];
    if (
      typeof member !== "string" ||
      member.length === 0 ||
      member.length > MAX_LEGEND_VALUE_CHARS
    ) {
      return undefined;
    }
    entries.push(member);
  }
  return value.length === extent && new Set(entries).size === extent ? entries : undefined;
}

function tokenTypeIndex(value: string): number | null {
  const mapped = MANAGED_LSP_SEMANTIC_TOKEN_TYPES.includes(value as ManagedLspSemanticTokenType)
    ? (value as ManagedLspSemanticTokenType)
    : CUSTOM_TOKEN_TYPES[value];
  return mapped === undefined ? null : MANAGED_LSP_SEMANTIC_TOKEN_TYPES.indexOf(mapped);
}

function tokenModifierIndex(value: string): number | null {
  const mapped = MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS.includes(
    value as ManagedLspSemanticTokenModifier,
  )
    ? (value as ManagedLspSemanticTokenModifier)
    : CUSTOM_TOKEN_MODIFIERS[value];
  return mapped === undefined ? null : MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS.indexOf(mapped);
}

export function negotiateSemanticTokenLegend(
  provider: unknown,
): LspSemanticTokenNegotiation | undefined {
  if (!isRecord(provider) || provider.full === false) return undefined;
  const raw = provider.legend;
  if (!isRecord(raw)) return undefined;
  const types = captureRawLegendValues(raw.tokenTypes, MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES);
  if (types === undefined) return undefined;
  const modifiers = captureRawLegendValues(
    raw.tokenModifiers,
    MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS,
  );
  if (modifiers === undefined) return undefined;
  const legend = managedLegend();
  return {
    legend,
    tokenTypeMap: types.map(tokenTypeIndex),
    tokenModifierMap: modifiers.map(tokenModifierIndex),
  };
}

function managedLegend(): ManagedLspSemanticTokenLegend {
  const value = {
    schemaVersion: MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
    legendVersion: 1,
    tokenTypes: MANAGED_LSP_SEMANTIC_TOKEN_TYPES,
    tokenModifiers: MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS,
    returnedTypeCount: MANAGED_LSP_SEMANTIC_TOKEN_TYPES.length,
    totalTypeCount: MANAGED_LSP_SEMANTIC_TOKEN_TYPES.length,
    returnedModifierCount: MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS.length,
    totalModifierCount: MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS.length,
    truncated: false,
  };
  const parsed = parseManagedLspSemanticTokenLegend(value);
  if (!parsed.ok) throw new Error("managed semantic-token legend is invalid");
  return parsed.value;
}

function rawTokenDataExtent(input: readonly unknown[]): number | undefined {
  const initial = input.length;
  if (!Number.isSafeInteger(initial) || initial < 0 || initial % 5 !== 0) return undefined;
  const extent = rawArrayExtent(input, MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS * 5);
  return extent !== undefined && extent % 5 === 0 ? extent : undefined;
}

function rawData(result: unknown): readonly number[] | undefined {
  if (!isRecord(result)) return undefined;
  const input = result.data;
  if (!Array.isArray(input)) return undefined;
  const extent = rawTokenDataExtent(input);
  if (extent === undefined) return undefined;
  const data: number[] = [];
  for (let index = 0; index < extent; index += 1) {
    const member: unknown = input[index];
    if (typeof member !== "number" || !Number.isSafeInteger(member) || member < 0) return undefined;
    data.push(member);
  }
  return input.length === extent ? data : undefined;
}

function captureTokenMap(
  value: readonly (number | null)[],
  maximum: number,
): readonly (number | null)[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const extent = rawArrayExtent(value, maximum);
  if (extent === undefined) return undefined;
  const entries: (number | null)[] = [];
  for (let index = 0; index < extent; index += 1) {
    const member: unknown = value[index];
    if (
      member !== null &&
      (typeof member !== "number" || !Number.isSafeInteger(member) || member < 0)
    ) {
      return undefined;
    }
    entries.push(member);
  }
  return value.length === extent ? entries : undefined;
}

function captureNegotiation(
  negotiation: LspSemanticTokenNegotiation,
): LspSemanticTokenNegotiation | undefined {
  const tokenTypeMap = captureTokenMap(
    negotiation.tokenTypeMap,
    MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES,
  );
  if (tokenTypeMap === undefined) return undefined;
  const tokenModifierMap = captureTokenMap(
    negotiation.tokenModifierMap,
    MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS,
  );
  return tokenModifierMap === undefined
    ? undefined
    : { legend: negotiation.legend, tokenTypeMap, tokenModifierMap };
}

interface DecodeState {
  line: number;
  start: number;
  previousEnd: number;
}

function mappedModifierBits(
  rawBits: number,
  modifierMap: readonly (number | null)[],
): number | undefined {
  if (rawBits >= 2 ** modifierMap.length) return undefined;
  let mapped = 0;
  for (let index = 0; index < modifierMap.length; index += 1) {
    if ((rawBits & (2 ** index)) === 0) continue;
    const managed = modifierMap[index];
    if (managed !== null && managed !== undefined) mapped |= 2 ** managed;
  }
  return mapped;
}

function decodeTuple(
  data: readonly number[],
  offset: number,
  lines: readonly string[],
  negotiation: LspSemanticTokenNegotiation,
  state: DecodeState,
): readonly number[] | undefined {
  const deltaLine = data[offset] ?? -1;
  const deltaStart = data[offset + 1] ?? -1;
  const length = data[offset + 2] ?? 0;
  const rawType = data[offset + 3] ?? -1;
  const rawModifiers = data[offset + 4] ?? -1;
  const line = state.line + deltaLine;
  const start = deltaLine === 0 ? state.start + deltaStart : deltaStart;
  const type = negotiation.tokenTypeMap[rawType];
  const modifiers = mappedModifierBits(rawModifiers, negotiation.tokenModifierMap);
  if (!validDecodedPosition(lines, state, line, start, length)) return undefined;
  const kind = mappedKind(type, modifiers);
  if (kind === undefined) return undefined;
  state.line = line;
  state.start = start;
  state.previousEnd = start + length;
  return [deltaLine, deltaStart, length, kind.type, kind.modifiers];
}

function mappedKind(
  type: number | null | undefined,
  modifiers: number | undefined,
): { readonly type: number; readonly modifiers: number } | undefined {
  return type === null || type === undefined || modifiers === undefined
    ? undefined
    : { type, modifiers };
}

function validDecodedPosition(
  lines: readonly string[],
  previous: DecodeState,
  line: number,
  start: number,
  length: number,
): boolean {
  if (length <= 0 || !Number.isSafeInteger(line) || !Number.isSafeInteger(start)) return false;
  const lineLength = lines[line]?.length;
  if (lineLength === undefined || start + length > lineLength) return false;
  return line !== previous.line || start >= previous.previousEnd;
}

export function sanitizeSemanticTokenResponse(
  result: unknown,
  documentText: string,
  documentVersion: number,
  negotiation: LspSemanticTokenNegotiation,
): ManagedLspSemanticTokenData | undefined {
  if (Buffer.byteLength(documentText, "utf8") > MANAGED_LSP_SEMANTIC_MAX_DOCUMENT_BYTES) {
    return undefined;
  }
  const input = rawData(result);
  if (input === undefined) return undefined;
  const captured = captureNegotiation(negotiation);
  if (captured === undefined) return undefined;
  const lines = documentText.split("\n");
  const state: DecodeState = { line: 0, start: 0, previousEnd: 0 };
  const data: number[] = [];
  for (let offset = 0; offset < input.length; offset += 5) {
    const tuple = decodeTuple(input, offset, lines, captured, state);
    if (tuple === undefined) return undefined;
    data.push(...tuple);
  }
  const value = {
    schemaVersion: MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
    legendVersion: captured.legend.legendVersion,
    documentVersion,
    dataVersion: 1,
    data,
    returnedTokenCount: data.length / 5,
    totalTokenCount: data.length / 5,
    truncated: false,
  };
  const parsed = parseManagedLspSemanticTokenData(value, captured.legend);
  return parsed.ok ? parsed.value : undefined;
}
