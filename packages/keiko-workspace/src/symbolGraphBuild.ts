import { posix as path } from "node:path";
import { readWorkspaceFile } from "./discovery.js";
import type { WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import {
  CALL_REGEX,
  IDENTIFIER_REGEX,
  collectDefinitions,
  collectIdentifiers,
  enclosingSymbol,
  isDefinitionHit,
  isSymbolSource,
  unsupportedLanguages,
  type DefinitionHit,
} from "./symbolGraphLexing.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo } from "./realpath.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import { gatherCandidates, probeBinary } from "./repoSearchScan.js";
import { symbolGraphRecordStableId } from "./stableId.js";
import type {
  SymbolDefinitionKind,
  SymbolGraph,
  SymbolGraphRecord,
  SymbolGraphRecordKind,
} from "./symbolGraphTypes.js";

interface SymbolGraphBuilder {
  readonly records: SymbolGraphRecord[];
  readonly definitions: Map<string, SymbolGraphRecord[]>;
  readonly references: Map<string, SymbolGraphRecord[]>;
  readonly calls: Map<string, SymbolGraphRecord[]>;
  truncated: boolean;
}

const MAX_SYMBOL_RECORD_MULTIPLIER = 20;
const MIN_SYMBOL_RECORD_CAP = 1_000;

function normalizeScopePath(scopePath: string): string {
  return path.normalize(scopePath.split("\\").join("/")).replace(/^\.\//u, "");
}

async function readSymbolSource(
  scope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  limits: SearchLimits,
): Promise<string | undefined> {
  try {
    const absolutePath = resolveWithinWorkspace(scope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, scope.workspace.root, absolutePath);
    if (isDenied(normalizeScopePath(contained.realRelative))) return undefined;
    const stat = fs.stat(contained.path);
    if (stat.hardLinkCount !== undefined && stat.hardLinkCount > 1) return undefined;
    if (await probeBinary(fs, contained.path, stat.size)) return undefined;
    return readWorkspaceFile(
      scope.workspace,
      scopePath,
      { maxBytes: limits.maxBytesPerFileScanned },
      fs,
    ).text;
  } catch {
    return undefined;
  }
}

function makeRecord(
  scopePath: string,
  kind: SymbolGraphRecordKind,
  symbol: string,
  line: number,
  ordinal: number,
  confidence: number,
  definitionKind: SymbolDefinitionKind | undefined,
  enclosing: string | undefined,
): SymbolGraphRecord {
  return {
    stableId: symbolGraphRecordStableId({
      symbol,
      scopePath,
      kind,
      line,
      ordinal,
      enclosingSymbol: enclosing,
    }),
    symbol,
    scopePath,
    kind,
    line,
    ordinal,
    confidence,
    definitionKind,
    enclosingSymbol: enclosing,
  };
}

function addToIndex(index: Map<string, SymbolGraphRecord[]>, record: SymbolGraphRecord): void {
  const key = record.symbol.toLowerCase();
  index.set(key, [...(index.get(key) ?? []), record]);
}

function symbolRecordCap(limits: SearchLimits): number {
  return Math.max(MIN_SYMBOL_RECORD_CAP, limits.maxMatchesReturned * MAX_SYMBOL_RECORD_MULTIPLIER);
}

function createSymbolGraphBuilder(truncated: boolean): SymbolGraphBuilder {
  return {
    records: [],
    definitions: new Map<string, SymbolGraphRecord[]>(),
    references: new Map<string, SymbolGraphRecord[]>(),
    calls: new Map<string, SymbolGraphRecord[]>(),
    truncated,
  };
}

function addIndexedRecord(
  builder: SymbolGraphBuilder,
  index: Map<string, SymbolGraphRecord[]>,
  record: SymbolGraphRecord,
  cap: number,
): boolean {
  if (builder.records.length >= cap) {
    builder.truncated = true;
    return false;
  }
  builder.records.push(record);
  addToIndex(index, record);
  return true;
}

function addDefinitionRecords(
  builder: SymbolGraphBuilder,
  scopePath: string,
  definitions: readonly DefinitionHit[],
  cap: number,
): boolean {
  for (const definition of definitions) {
    const record = makeRecord(
      scopePath,
      "definition",
      definition.symbol,
      definition.line,
      definition.ordinal,
      1,
      definition.definitionKind,
      undefined,
    );
    if (!addIndexedRecord(builder, builder.definitions, record, cap)) return false;
  }
  return true;
}

function addReferenceRecords(
  builder: SymbolGraphBuilder,
  scopePath: string,
  text: string,
  definitions: readonly DefinitionHit[],
  cap: number,
): boolean {
  for (const hit of collectIdentifiers(text, IDENTIFIER_REGEX)) {
    if (isDefinitionHit(definitions, hit.symbol, hit.line)) continue;
    const record = makeRecord(
      scopePath,
      "reference",
      hit.symbol,
      hit.line,
      hit.ordinal,
      0.72,
      undefined,
      enclosingSymbol(definitions, hit.line),
    );
    if (!addIndexedRecord(builder, builder.references, record, cap)) return false;
  }
  return true;
}

function addCallRecords(
  builder: SymbolGraphBuilder,
  scopePath: string,
  text: string,
  definitions: readonly DefinitionHit[],
  cap: number,
): boolean {
  for (const hit of collectIdentifiers(text, CALL_REGEX)) {
    if (isDefinitionHit(definitions, hit.symbol, hit.line)) continue;
    const record = makeRecord(
      scopePath,
      "call",
      hit.symbol,
      hit.line,
      hit.ordinal,
      0.86,
      undefined,
      enclosingSymbol(definitions, hit.line),
    );
    if (!addIndexedRecord(builder, builder.calls, record, cap)) return false;
  }
  return true;
}

function addFileSymbolRecords(
  builder: SymbolGraphBuilder,
  scopePath: string,
  text: string,
  cap: number,
): void {
  const definitions = collectDefinitions(text);
  if (!addDefinitionRecords(builder, scopePath, definitions, cap)) return;
  if (!addReferenceRecords(builder, scopePath, text, definitions, cap)) return;
  addCallRecords(builder, scopePath, text, definitions, cap);
}

function recordsForSymbol(
  index: ReadonlyMap<string, readonly SymbolGraphRecord[]>,
  symbol: string,
): readonly SymbolGraphRecord[] {
  return index.get(symbol.toLowerCase()) ?? [];
}

export function definitionsForSymbol(
  graph: SymbolGraph,
  symbol: string,
): readonly SymbolGraphRecord[] {
  return recordsForSymbol(graph.definitions, symbol);
}

export function referencesForSymbol(
  graph: SymbolGraph,
  symbol: string,
): readonly SymbolGraphRecord[] {
  return recordsForSymbol(graph.references, symbol);
}

export function callsToSymbol(graph: SymbolGraph, symbol: string): readonly SymbolGraphRecord[] {
  return recordsForSymbol(graph.calls, symbol);
}

export async function buildSymbolGraph(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  signal?: AbortSignal,
): Promise<SymbolGraph> {
  const candidateSet = gatherCandidates(scope, limits, fs);
  const cap = symbolRecordCap(limits);
  const builder = createSymbolGraphBuilder(candidateSet.truncated);
  const startedAt = Date.now();
  let filesScanned = 0;
  for (const file of candidateSet.files.map((entry) => entry.relativePath)) {
    if (signal?.aborted === true || Date.now() - startedAt > limits.elapsedMsMax) {
      builder.truncated = true;
      break;
    }
    if (!isSymbolSource(file)) continue;
    const text = await readSymbolSource(scope, fs, file, limits);
    if (text === undefined) continue;
    filesScanned += 1;
    addFileSymbolRecords(builder, file, text, cap);
    if (builder.truncated) break;
  }
  return {
    records: builder.records,
    definitions: builder.definitions,
    references: builder.references,
    calls: builder.calls,
    diagnostics: {
      filesScanned,
      truncated: builder.truncated,
      unsupportedLanguages: unsupportedLanguages(scope.workspace.languages),
    },
  };
}
