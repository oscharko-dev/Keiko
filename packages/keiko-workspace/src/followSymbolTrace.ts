import { createHash } from "node:crypto";
import {
  buildImportGraph,
  importersForTarget,
  importsFromSource,
  type ImportGraph,
  type ResolvedImportEdge,
} from "./importGraphEdges.js";
import type { WorkspaceFs } from "./fs.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import {
  buildSymbolGraph,
  callsToSymbol,
  definitionsForSymbol,
  referencesForSymbol,
} from "./symbolGraphBuild.js";
import type { SymbolGraph, SymbolGraphRecord } from "./symbolGraphTypes.js";

export type FollowSymbolTraceRelation = "definition" | "reference" | "call" | "import" | "importer";

export interface FollowSymbolTraceRecord {
  readonly stableId: string;
  readonly relation: FollowSymbolTraceRelation;
  readonly scopePath: string;
  readonly line: number;
  readonly depth: number;
  readonly confidence: number;
  readonly symbol?: string | undefined;
  readonly targetPath?: string | undefined;
  readonly via?: string | undefined;
}

export interface FollowSymbolTraceDiagnostics {
  readonly seedSymbols: readonly string[];
  readonly maxDepth: number;
  readonly maxRecords: number;
  readonly frontierVisited: number;
  readonly skippedEdges: number;
  readonly depthCapped: boolean;
  readonly budgetExhausted: boolean;
}

export interface FollowSymbolTrace {
  readonly records: readonly FollowSymbolTraceRecord[];
  readonly diagnostics: FollowSymbolTraceDiagnostics;
}

export interface FollowSymbolTraceRequest {
  readonly symbols: readonly string[];
  readonly maxDepth?: number | undefined;
  readonly maxRecords?: number | undefined;
}

type FrontierItem =
  | {
      readonly kind: "symbol";
      readonly value: string;
      readonly depth: number;
      readonly via: string;
    }
  | { readonly kind: "file"; readonly value: string; readonly depth: number; readonly via: string };

interface TraceState {
  readonly queue: FrontierItem[];
  readonly seenFrontier: Set<string>;
  readonly seenRecords: Set<string>;
  readonly records: FollowSymbolTraceRecord[];
  skippedEdges: number;
  depthCapped: boolean;
  budgetExhausted: boolean;
  frontierVisited: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_RECORDS = 48;
const FRONTIER_MULTIPLIER = 4;

function uniqueSymbols(symbols: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of symbols) {
    const symbol = raw.trim();
    const key = symbol.toLowerCase();
    if (symbol.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(symbol);
  }
  return out;
}

function traceRecordId(input: Omit<FollowSymbolTraceRecord, "stableId">): string {
  const canonical = JSON.stringify([
    input.relation,
    input.scopePath,
    input.line,
    input.depth,
    input.symbol ?? "",
    input.targetPath ?? "",
    input.via ?? "",
  ]);
  return `ft-${createHash("sha256").update(canonical).digest("hex")}`;
}

function depthConfidence(confidence: number, depth: number): number {
  return Number((confidence / (1 + depth * 0.2)).toFixed(3));
}

function symbolRecord(
  relation: FollowSymbolTraceRelation,
  record: SymbolGraphRecord,
  depth: number,
  via: string,
): FollowSymbolTraceRecord {
  const shape = {
    relation,
    scopePath: record.scopePath,
    line: record.line,
    depth,
    confidence: depthConfidence(record.confidence, depth),
    symbol: record.symbol,
    via,
  };
  return { stableId: traceRecordId(shape), ...shape };
}

function importRecord(
  relation: FollowSymbolTraceRelation,
  edge: ResolvedImportEdge,
  depth: number,
  via: string,
): FollowSymbolTraceRecord {
  const shape = {
    relation,
    scopePath: edge.importerPath,
    line: edge.line,
    depth,
    confidence: depthConfidence(edge.score, depth),
    targetPath: edge.targetPath,
    via,
  };
  return { stableId: traceRecordId(shape), ...shape };
}

function relationRank(relation: FollowSymbolTraceRelation): number {
  return ["definition", "call", "reference", "importer", "import"].indexOf(relation);
}

function sortRecords(
  records: readonly FollowSymbolTraceRecord[],
): readonly FollowSymbolTraceRecord[] {
  return [...records].sort(
    (a, b) =>
      a.depth - b.depth ||
      relationRank(a.relation) - relationRank(b.relation) ||
      a.scopePath.localeCompare(b.scopePath) ||
      a.line - b.line ||
      (a.symbol ?? "").localeCompare(b.symbol ?? ""),
  );
}

function sortedSymbolRecords(records: readonly SymbolGraphRecord[]): readonly SymbolGraphRecord[] {
  return [...records].sort(
    (a, b) =>
      a.scopePath.localeCompare(b.scopePath) ||
      a.line - b.line ||
      a.kind.localeCompare(b.kind) ||
      a.symbol.localeCompare(b.symbol),
  );
}

function sortedImportEdges(edges: readonly ResolvedImportEdge[]): readonly ResolvedImportEdge[] {
  return [...edges].sort(
    (a, b) =>
      a.importerPath.localeCompare(b.importerPath) ||
      (a.targetPath ?? "").localeCompare(b.targetPath ?? "") ||
      a.line - b.line ||
      a.specifier.localeCompare(b.specifier),
  );
}

function pushFrontier(
  state: TraceState,
  item: FrontierItem,
  maxDepth: number,
  maxRecords: number,
): void {
  if (item.depth > maxDepth) {
    state.depthCapped = true;
    state.skippedEdges += 1;
    return;
  }
  if (state.queue.length >= maxRecords * FRONTIER_MULTIPLIER) {
    state.budgetExhausted = true;
    state.skippedEdges += 1;
    return;
  }
  const key = `${item.kind}:${item.value.toLowerCase()}`;
  if (state.seenFrontier.has(key)) return;
  state.seenFrontier.add(key);
  state.queue.push(item);
}

function pushRecord(
  state: TraceState,
  record: FollowSymbolTraceRecord,
  maxRecords: number,
): boolean {
  if (state.records.length >= maxRecords) {
    state.budgetExhausted = true;
    state.skippedEdges += 1;
    return false;
  }
  if (state.seenRecords.has(record.stableId)) return true;
  state.seenRecords.add(record.stableId);
  state.records.push(record);
  return true;
}

function definitionsInFile(graph: SymbolGraph, scopePath: string): readonly SymbolGraphRecord[] {
  return graph.records.filter(
    (record) => record.kind === "definition" && record.scopePath === scopePath,
  );
}

function expandSymbol(
  state: TraceState,
  graph: SymbolGraph,
  item: Extract<FrontierItem, { readonly kind: "symbol" }>,
  maxDepth: number,
  maxRecords: number,
): void {
  const related = [
    ...sortedSymbolRecords(definitionsForSymbol(graph, item.value)).map((record) =>
      symbolRecord("definition", record, item.depth, item.via),
    ),
    ...sortedSymbolRecords(callsToSymbol(graph, item.value)).map((record) =>
      symbolRecord("call", record, item.depth, item.via),
    ),
    ...sortedSymbolRecords(referencesForSymbol(graph, item.value)).map((record) =>
      symbolRecord("reference", record, item.depth, item.via),
    ),
  ];
  for (const record of related) {
    if (!pushRecord(state, record, maxRecords)) return;
    pushFrontier(
      state,
      { kind: "file", value: record.scopePath, depth: item.depth + 1, via: record.stableId },
      maxDepth,
      maxRecords,
    );
  }
}

function expandImports(
  state: TraceState,
  graph: ImportGraph,
  item: Extract<FrontierItem, { readonly kind: "file" }>,
  maxDepth: number,
  maxRecords: number,
): void {
  const edges = [
    ...sortedImportEdges(importersForTarget(graph, item.value)).map((edge) =>
      importRecord("importer", edge, item.depth, item.via),
    ),
    ...sortedImportEdges(importsFromSource(graph, item.value)).map((edge) =>
      importRecord("import", edge, item.depth, item.via),
    ),
  ];
  for (const record of edges) {
    if (!pushRecord(state, record, maxRecords)) return;
    if (record.targetPath !== undefined) {
      pushFrontier(
        state,
        { kind: "file", value: record.targetPath, depth: item.depth + 1, via: record.stableId },
        maxDepth,
        maxRecords,
      );
    }
    pushFrontier(
      state,
      { kind: "file", value: record.scopePath, depth: item.depth + 1, via: record.stableId },
      maxDepth,
      maxRecords,
    );
  }
}

function expandFileSymbols(
  state: TraceState,
  graph: SymbolGraph,
  item: Extract<FrontierItem, { readonly kind: "file" }>,
  maxDepth: number,
  maxRecords: number,
): void {
  for (const record of sortedSymbolRecords(definitionsInFile(graph, item.value))) {
    pushFrontier(
      state,
      { kind: "symbol", value: record.symbol, depth: item.depth + 1, via: item.via },
      maxDepth,
      maxRecords,
    );
  }
}

function createTraceState(): TraceState {
  return {
    queue: [],
    seenFrontier: new Set<string>(),
    seenRecords: new Set<string>(),
    records: [],
    skippedEdges: 0,
    depthCapped: false,
    budgetExhausted: false,
    frontierVisited: 0,
  };
}

function seedTraceState(
  state: TraceState,
  seedSymbols: readonly string[],
  maxDepth: number,
  maxRecords: number,
): void {
  for (const symbol of seedSymbols) {
    pushFrontier(
      state,
      { kind: "symbol", value: symbol, depth: 0, via: "query" },
      maxDepth,
      maxRecords,
    );
  }
}

function runTraceQueue(
  state: TraceState,
  symbolGraph: SymbolGraph,
  importGraph: ImportGraph,
  maxDepth: number,
  maxRecords: number,
): void {
  while (state.queue.length > 0 && !state.budgetExhausted) {
    const item = state.queue.shift();
    if (item === undefined) break;
    state.frontierVisited += 1;
    if (item.kind === "symbol") {
      expandSymbol(state, symbolGraph, item, maxDepth, maxRecords);
    } else {
      expandImports(state, importGraph, item, maxDepth, maxRecords);
      expandFileSymbols(state, symbolGraph, item, maxDepth, maxRecords);
    }
  }
}

export async function followSymbolTrace(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  request: FollowSymbolTraceRequest,
): Promise<FollowSymbolTrace> {
  const seedSymbols = uniqueSymbols(request.symbols);
  const maxDepth = Math.max(1, request.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxRecords = Math.max(
    1,
    Math.min(request.maxRecords ?? DEFAULT_MAX_RECORDS, limits.maxMatchesReturned),
  );
  const state = createTraceState();
  seedTraceState(state, seedSymbols, maxDepth, maxRecords);
  runTraceQueue(
    state,
    await buildSymbolGraph(scope, limits, fs),
    await buildImportGraph(scope, limits, fs),
    maxDepth,
    maxRecords,
  );
  return {
    records: sortRecords(state.records),
    diagnostics: {
      seedSymbols,
      maxDepth,
      maxRecords,
      frontierVisited: state.frontierVisited,
      skippedEdges: state.skippedEdges,
      depthCapped: state.depthCapped,
      budgetExhausted: state.budgetExhausted,
    },
  };
}
