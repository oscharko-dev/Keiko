import { readWorkspaceFile } from "./discovery.js";
import { workspaceLanguageForPath } from "./ecosystems.js";
import type { WorkspaceFs } from "./fs.js";
import { languageForFileName } from "./languageClassification.js";
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
import { containedRealPathInfo, isCanonicalAllowedContainedPath } from "./realpath.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import {
  gatherCandidatesWithControl,
  limitCandidateSetForStructuralBuild,
  probeBinary,
  type CandidateSet,
} from "./repoSearchScan.js";
import { symbolGraphRecordStableId } from "./stableId.js";
import {
  createStructuralExecutionControl,
  structuralExecutionStopped,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import type { WorkspaceLanguage } from "./types.js";
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

async function readSymbolSource(
  scope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  limits: SearchLimits,
): Promise<string | undefined> {
  try {
    const absolutePath = resolveWithinWorkspace(scope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, scope.workspace.root, absolutePath);
    if (!isCanonicalAllowedContainedPath(contained, scope.workspace.root, scopePath)) {
      return undefined;
    }
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

interface MakeRecordOptions {
  readonly scopePath: string;
  readonly kind: SymbolGraphRecordKind;
  readonly symbol: string;
  readonly line: number;
  readonly ordinal: number;
  readonly confidence: number;
  readonly definitionKind: SymbolDefinitionKind | undefined;
  readonly enclosing: string | undefined;
}

function makeRecord(options: MakeRecordOptions): SymbolGraphRecord {
  const { scopePath, kind, symbol, line, ordinal, confidence, definitionKind, enclosing } = options;
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
    const record = makeRecord({
      scopePath,
      kind: "definition",
      symbol: definition.symbol,
      line: definition.line,
      ordinal: definition.ordinal,
      confidence: 1,
      definitionKind: definition.definitionKind,
      enclosing: undefined,
    });
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
    const record = makeRecord({
      scopePath,
      kind: "reference",
      symbol: hit.symbol,
      line: hit.line,
      ordinal: hit.ordinal,
      confidence: 0.72,
      definitionKind: undefined,
      enclosing: enclosingSymbol(definitions, hit.line),
    });
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
    const record = makeRecord({
      scopePath,
      kind: "call",
      symbol: hit.symbol,
      line: hit.line,
      ordinal: hit.ordinal,
      confidence: 0.86,
      definitionKind: undefined,
      enclosing: enclosingSymbol(definitions, hit.line),
    });
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
  const control = createStructuralExecutionControl(limits.elapsedMsMax, Date.now, signal);
  return buildSymbolGraphFromCandidates(
    scope,
    limits,
    fs,
    gatherCandidatesWithControl(scope, limits, fs, control),
    signal,
    control,
  );
}

export async function buildSymbolGraphFromCandidates(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  candidateSet: CandidateSet,
  signal?: AbortSignal,
  executionControl?: StructuralExecutionControl,
): Promise<SymbolGraph> {
  const boundedCandidates = limitCandidateSetForStructuralBuild(candidateSet, limits, (file) =>
    isSymbolSource(file.relativePath),
  );
  const cap = symbolRecordCap(limits);
  const builder = createSymbolGraphBuilder(false);
  const control =
    executionControl ?? createStructuralExecutionControl(limits.elapsedMsMax, Date.now, signal);
  let filesScanned = 0;
  let filesSkipped = 0;
  for (const file of boundedCandidates.files.map((entry) => entry.relativePath)) {
    if (structuralExecutionStopped(control)) {
      builder.truncated = true;
      break;
    }
    const text = await readSymbolSource(scope, fs, file, limits);
    if (structuralExecutionStopped(control)) {
      builder.truncated = true;
      break;
    }
    if (text === undefined) {
      filesSkipped += 1;
      continue;
    }
    filesScanned += 1;
    addFileSymbolRecords(builder, file, text, cap);
    if (structuralExecutionStopped(control)) builder.truncated = true;
    if (builder.truncated) break;
  }
  return {
    records: builder.records,
    definitions: builder.definitions,
    references: builder.references,
    calls: builder.calls,
    diagnostics: {
      filesScanned,
      filesSkipped,
      truncated: boundedCandidates.truncated || builder.truncated,
      unsupportedLanguages: unsupportedLanguages(observedLanguages(scope, candidateSet)),
    },
  };
}

function observedLanguages(
  scope: SearchScope,
  candidateSet: CandidateSet,
): readonly WorkspaceLanguage[] {
  const languages = new Set(scope.workspace.languages);
  for (const file of candidateSet.files) {
    const language =
      workspaceLanguageForPath(file.relativePath) ?? languageForFileName(file.relativePath);
    if (language !== undefined) languages.add(language);
  }
  return [...languages];
}
