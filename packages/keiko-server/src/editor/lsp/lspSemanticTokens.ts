import {
  MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES,
  MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS,
  MANAGED_LSP_SEMANTIC_TOKEN_TYPES,
  parseManagedLspSemanticTokenData,
  parseManagedLspSemanticTokenLegend,
  type ManagedLspSemanticTokenData,
  type ManagedLspSemanticTokenLegend,
  type ManagedLspSemanticTokenModifier,
  type ManagedLspSemanticTokenType,
} from "@oscharko-dev/keiko-contracts";

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

function validRawLegendValues(value: unknown, maximum: number): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= MAX_LEGEND_VALUE_CHARS,
    ) &&
    new Set(value).size === value.length
  );
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
  if (!validRawLegendValues(raw.tokenTypes, MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES)) return undefined;
  if (!validRawLegendValues(raw.tokenModifiers, MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS)) {
    return undefined;
  }
  const legend = managedLegend();
  return {
    legend,
    tokenTypeMap: raw.tokenTypes.map(tokenTypeIndex),
    tokenModifierMap: raw.tokenModifiers.map(tokenModifierIndex),
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

function rawData(result: unknown): readonly number[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.data)) return undefined;
  if (result.data.length % 5 !== 0) return undefined;
  if (result.data.length / 5 > MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS) return undefined;
  return result.data.every((value) => Number.isSafeInteger(value) && value >= 0)
    ? (result.data as readonly number[])
    : undefined;
}

interface DecodeState {
  line: number;
  start: number;
  previousEnd: number;
}

function mappedModifierBits(
  rawBits: number,
  negotiation: LspSemanticTokenNegotiation,
): number | undefined {
  if (rawBits >= 2 ** negotiation.tokenModifierMap.length) return undefined;
  let mapped = 0;
  for (let index = 0; index < negotiation.tokenModifierMap.length; index += 1) {
    if ((rawBits & (2 ** index)) === 0) continue;
    const managed = negotiation.tokenModifierMap[index];
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
  const modifiers = mappedModifierBits(rawModifiers, negotiation);
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
  const lines = documentText.split("\n");
  const state: DecodeState = { line: 0, start: 0, previousEnd: 0 };
  const data: number[] = [];
  for (let offset = 0; offset < input.length; offset += 5) {
    const tuple = decodeTuple(input, offset, lines, negotiation, state);
    if (tuple === undefined) return undefined;
    data.push(...tuple);
  }
  const value = {
    schemaVersion: MANAGED_LSP_CAPABILITY_SCHEMA_VERSION,
    legendVersion: negotiation.legend.legendVersion,
    documentVersion,
    dataVersion: 1,
    data,
    returnedTokenCount: data.length / 5,
    totalTokenCount: data.length / 5,
    truncated: false,
  };
  const parsed = parseManagedLspSemanticTokenData(value, negotiation.legend);
  return parsed.ok ? parsed.value : undefined;
}
