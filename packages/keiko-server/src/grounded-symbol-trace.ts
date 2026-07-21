import { createHash } from "node:crypto";
import type {
  EvidenceAtom,
  RetrievalQuery,
  SelectedScope,
  UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { RetrievalIntent, SearchAnchor } from "@oscharko-dev/keiko-workflows";
import {
  DEFAULT_SEARCH_LIMITS,
  evidenceAtomStableId,
  followSymbolTrace,
  readExcerpt,
  searchText,
  type FollowSymbolTraceDiagnostics,
  type FollowSymbolTraceRecord,
  type SearchScope,
  type WorkspaceFs,
  type WorkspaceIndex,
} from "@oscharko-dev/keiko-workspace";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import { directDefinitionSymbol } from "./grounded-query-shape.js";

interface FollowSymbolTraceEvidenceInput {
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly anchors: readonly SearchAnchor[];
  readonly retrievalIntent: RetrievalIntent;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
}

interface DiscoveredSymbolTraceEvidenceInput extends FollowSymbolTraceEvidenceInput {
  readonly atoms: readonly EvidenceAtom[];
  readonly workspaceIndex?: WorkspaceIndex | undefined;
}

export interface FollowSymbolTraceEvidence {
  readonly atoms: readonly EvidenceAtom[];
  readonly uncertainty: readonly UncertaintyMarker[];
}

const TRACE_MAX_DEPTH = 3;
const TRACE_MAX_RECORDS = 48;
const MAX_DISCOVERY_ATOMS = 12;
const MAX_DISCOVERED_SYMBOLS = 4;
const MAX_DISCOVERED_TRACE_HOPS = 2;
const MAX_DISCOVERY_EXCERPT_BYTES = 4096;
const DISCOVERED_DEFINITION_CONTEXT_LINES = 24;
const CONFIGURED_HANDLER_RE = /\bhandler\s*:\s*([A-Za-z_$][A-Za-z0-9_$]{1,127})\b/gu;
const ROUTER_HANDLER_RE =
  /\b(?:router|app|server)\s*\.\s*(?:get|post|put|patch|delete|head|options)\s*\([^,\n]+,\s*([A-Za-z_$][A-Za-z0-9_$]{1,127})\b/giu;
const CALLED_SYMBOL_RE = /\b([A-Za-z_$][A-Za-z0-9_$]{2,127})\s*\(/gu;
const ROUTE_TRACE_QUERY_RE =
  /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b[^\n]*\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+/iu;
const IGNORED_CALLED_SYMBOLS = new Set([
  "catch",
  "for",
  "function",
  "if",
  "promise",
  "switch",
  "while",
]);
const TRACE_SEARCH_LIMITS = {
  ...DEFAULT_SEARCH_LIMITS,
  maxMatchesReturned: TRACE_MAX_RECORDS,
};
const ROUTE_REGISTRATION_PATH_RE =
  /(?:^|\/)(?:api|endpoints?|http|router?|routes?)(?:[./_-]|\/|$)/iu;

function traceSymbols(anchors: readonly SearchAnchor[]): readonly string[] {
  return anchors
    .filter((anchor) => anchor.kind === "identifier" && anchor.weight >= 0.85)
    .map((anchor) => anchor.term);
}

function traceFingerprint(query: RetrievalQuery, symbols: readonly string[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ kind: query.kind, text: query.text, symbols, tool: "follow-symbol-trace" }),
    )
    .digest("hex")
    .slice(0, 16);
}

function traceAtom(
  scope: SelectedScope,
  record: FollowSymbolTraceRecord,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  const lineRange = { startLine: record.line, endLine: record.line };
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath: record.scopePath,
      lineRange,
      provenanceKind: "structural",
      provenanceTool: "follow-symbol-trace",
      queryFingerprint,
    }),
    scopePath: record.scopePath,
    lineRange,
    score: record.confidence,
    provenance: {
      kind: "structural",
      tool: "follow-symbol-trace",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function traceIncomplete(
  diagnostics: FollowSymbolTraceDiagnostics,
  nowMs: () => number,
): UncertaintyMarker | undefined {
  if (!diagnostics.depthCapped && !diagnostics.budgetExhausted && diagnostics.skippedEdges === 0) {
    return undefined;
  }
  const reasons = [
    ...(diagnostics.depthCapped ? [`depth>${String(diagnostics.maxDepth)}`] : []),
    ...(diagnostics.budgetExhausted ? [`records>${String(diagnostics.maxRecords)}`] : []),
  ];
  return {
    kind: diagnostics.budgetExhausted ? "budget-clipped" : "scope-incomplete",
    claim:
      `Follow-symbol trace skipped ${String(diagnostics.skippedEdges)} edge(s); ` +
      `frontierVisited=${String(diagnostics.frontierVisited)}, ` +
      `seeds=${diagnostics.seedSymbols.join(",")}, ` +
      `reasons=${reasons.length === 0 ? "bounded-traversal" : reasons.join(",")}.`,
    impactedAtomIds: [],
    emittedAtMs: nowMs(),
  };
}

function shouldTrace(input: FollowSymbolTraceEvidenceInput): boolean {
  return (
    input.retrievalIntent === "targeted-code-search" ||
    input.retrievalIntent === "diagnostic-search"
  );
}

function eligibleDiscoveryAtoms(atoms: readonly EvidenceAtom[]): readonly EvidenceAtom[] {
  return atoms.filter(
    (atom) =>
      atom.lineRange !== undefined &&
      !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/iu.test(atom.scopePath),
  );
}

function discoveryAtoms(atoms: readonly EvidenceAtom[]): readonly EvidenceAtom[] {
  return [...eligibleDiscoveryAtoms(atoms)]
    .sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.scopePath.localeCompare(b.scopePath),
    )
    .slice(0, MAX_DISCOVERY_ATOMS);
}

function routeDiscoveryAtoms(atoms: readonly EvidenceAtom[]): readonly EvidenceAtom[] {
  return [...eligibleDiscoveryAtoms(atoms)]
    .sort((a, b) => {
      const routeDelta =
        Number(ROUTE_REGISTRATION_PATH_RE.test(b.scopePath)) -
        Number(ROUTE_REGISTRATION_PATH_RE.test(a.scopePath));
      return routeDelta !== 0
        ? routeDelta
        : b.score !== a.score
          ? b.score - a.score
          : a.scopePath.localeCompare(b.scopePath);
    })
    .slice(0, MAX_DISCOVERY_ATOMS);
}

async function discoveryExcerpt(
  input: DiscoveredSymbolTraceEvidenceInput,
  atom: EvidenceAtom,
): Promise<string> {
  const range = atom.lineRange;
  if (range === undefined) return "";
  const result = await readExcerpt(
    input.searchScope,
    { scopePath: atom.scopePath, ...range, maxBytes: MAX_DISCOVERY_EXCERPT_BYTES },
    { fs: input.fs },
  );
  return result.content;
}

function handlerSymbolsFromContent(content: string): readonly string[] {
  return [...content.matchAll(CONFIGURED_HANDLER_RE), ...content.matchAll(ROUTER_HANDLER_RE)]
    .map((match) => match[1])
    .filter((symbol): symbol is string => symbol !== undefined);
}

async function discoveredHandlerSymbols(
  input: DiscoveredSymbolTraceEvidenceInput,
): Promise<readonly string[]> {
  const contents = await Promise.all(
    routeDiscoveryAtoms(input.atoms).map(async (atom) => discoveryExcerpt(input, atom)),
  );
  return [...new Set(contents.flatMap((content) => handlerSymbolsFromContent(content)))].slice(
    0,
    MAX_DISCOVERED_SYMBOLS,
  );
}

function exactSymbolQuery(symbol: string, nowMs: () => number): RetrievalQuery {
  return {
    kind: "exact-symbol",
    text: symbol,
    caseSensitive: false,
    maxResults: TRACE_MAX_RECORDS,
    emittedAtMs: nowMs(),
  };
}

async function searchDiscoveredSymbol(
  input: DiscoveredSymbolTraceEvidenceInput,
  symbol: string,
): Promise<readonly EvidenceAtom[]> {
  const result = await searchText(
    input.searchScope,
    exactSymbolQuery(symbol, input.nowMs),
    TRACE_SEARCH_LIMITS,
    {
      fs: input.fs,
      nowMs: input.nowMs,
      searchHints: { retrievalIntent: "targeted-code-search" },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.workspaceIndex === undefined ? {} : { workspaceIndex: input.workspaceIndex }),
    },
  );
  return promoteDiscoveredSymbolAtoms(input, symbol, result.atoms);
}

function discoveredTraceAtom(
  scopeId: string,
  atom: EvidenceAtom,
  isDeclaration: boolean,
): EvidenceAtom {
  const tool = isDeclaration ? "discovered-symbol-definition" : "structural-edge-target";
  const lineRange =
    isDeclaration && atom.lineRange !== undefined
      ? {
          startLine: Math.max(1, atom.lineRange.startLine - 2),
          endLine: atom.lineRange.endLine + DISCOVERED_DEFINITION_CONTEXT_LINES,
        }
      : atom.lineRange;
  const provenance = {
    kind: "structural" as const,
    tool,
    queryFingerprint: atom.provenance.queryFingerprint,
  };
  return {
    ...atom,
    stableId: evidenceAtomStableId({
      scopeId,
      scopePath: atom.scopePath,
      lineRange,
      provenanceKind: provenance.kind,
      provenanceTool: tool,
      queryFingerprint: provenance.queryFingerprint,
    }),
    score: isDeclaration ? 1 : Math.max(0.6, atom.score * 0.75),
    lineRange,
    provenance,
  };
}

async function promoteDiscoveredSymbolAtoms(
  input: DiscoveredSymbolTraceEvidenceInput,
  symbol: string,
  atoms: readonly EvidenceAtom[],
): Promise<readonly EvidenceAtom[]> {
  // `searchText` already orders exact-symbol candidates with definition-aware content scoring.
  // Preserve that order here: re-sorting equal line scores by path would let alphabetically early
  // call sites crowd the actual definition out of this bounded trace frontier.
  const candidates = eligibleDiscoveryAtoms(atoms).slice(0, MAX_DISCOVERY_ATOMS);
  const contents = await Promise.all(candidates.map(async (atom) => discoveryExcerpt(input, atom)));
  return candidates.map((atom, index) =>
    discoveredTraceAtom(
      input.scope.scopeId,
      atom,
      declaresAnySymbol(contents[index] ?? "", [symbol]),
    ),
  );
}

function declaresAnySymbol(content: string, symbols: readonly string[]): boolean {
  const lower = content.toLowerCase();
  return symbols.some((symbol) => {
    const name = symbol.toLowerCase();
    return ["function", "class", "interface", "const", "def", "func", "fn"].some((keyword) =>
      lower.includes(`${keyword} ${name}`),
    );
  });
}

function calledSymbolsFromContent(content: string): readonly string[] {
  return [...content.matchAll(CALLED_SYMBOL_RE)]
    .map((match) => match[1])
    .filter(
      (symbol): symbol is string =>
        symbol !== undefined &&
        !IGNORED_CALLED_SYMBOLS.has(symbol.toLowerCase()) &&
        !declaresAnySymbol(content, [symbol]),
    );
}

async function nextSymbolFrontier(
  input: DiscoveredSymbolTraceEvidenceInput,
  atoms: readonly EvidenceAtom[],
  current: readonly string[],
  seen: Set<string>,
): Promise<readonly string[]> {
  const contents = await Promise.all(
    discoveryAtoms(atoms).map(async (atom) => discoveryExcerpt(input, atom)),
  );
  const ordered = [...contents].sort(
    (a, b) => Number(declaresAnySymbol(b, current)) - Number(declaresAnySymbol(a, current)),
  );
  const frontier: string[] = [];
  for (const symbol of ordered.flatMap(calledSymbolsFromContent)) {
    const key = symbol.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    frontier.push(symbol);
    if (frontier.length >= MAX_DISCOVERED_SYMBOLS) break;
  }
  return frontier;
}

async function searchSymbolFrontier(
  input: DiscoveredSymbolTraceEvidenceInput,
  symbols: readonly string[],
): Promise<readonly EvidenceAtom[]> {
  return (
    await Promise.all(symbols.map(async (symbol) => searchDiscoveredSymbol(input, symbol)))
  ).flat();
}

async function traceDiscoveredSymbols(
  input: DiscoveredSymbolTraceEvidenceInput,
  seedSymbols: readonly string[],
): Promise<readonly EvidenceAtom[]> {
  const seen = new Set(seedSymbols.map((symbol) => symbol.toLowerCase()));
  const atoms: EvidenceAtom[] = [];
  let frontier = seedSymbols;
  for (let depth = 0; depth < MAX_DISCOVERED_TRACE_HOPS && frontier.length > 0; depth += 1) {
    const hopAtoms = await searchSymbolFrontier(input, frontier);
    const rankedHopAtoms =
      depth === 0 ? hopAtoms : hopAtoms.map((atom) => ({ ...atom, score: atom.score * 0.92 }));
    atoms.push(...rankedHopAtoms);
    frontier = await nextSymbolFrontier(input, hopAtoms, frontier, seen);
  }
  return [...new Map(atoms.map((atom) => [atom.stableId, atom])).values()];
}

export async function collectDiscoveredSymbolTraceEvidence(
  input: DiscoveredSymbolTraceEvidenceInput,
): Promise<FollowSymbolTraceEvidence> {
  if (!shouldTrace(input)) return { atoms: [], uncertainty: [] };
  if (!ROUTE_TRACE_QUERY_RE.test(input.query.text)) return { atoms: [], uncertainty: [] };
  const symbols = await discoveredHandlerSymbols(input);
  if (symbols.length === 0) return { atoms: [], uncertainty: [] };
  return {
    atoms: await traceDiscoveredSymbols(input, symbols),
    uncertainty: [],
  };
}

export async function collectFollowSymbolTraceEvidence(
  input: FollowSymbolTraceEvidenceInput,
): Promise<FollowSymbolTraceEvidence> {
  if (!shouldTrace(input)) return { atoms: [], uncertainty: [] };
  if (directDefinitionSymbol(input.query, input.anchors) !== undefined) {
    return { atoms: [], uncertainty: [] };
  }
  if (input.signal?.aborted === true) {
    throw new CancelledError("follow-symbol trace cancelled");
  }
  const symbols = traceSymbols(input.anchors);
  if (symbols.length === 0) return { atoms: [], uncertainty: [] };
  const trace = await followSymbolTrace(input.searchScope, TRACE_SEARCH_LIMITS, input.fs, {
    symbols,
    maxDepth: TRACE_MAX_DEPTH,
    maxRecords: TRACE_MAX_RECORDS,
  });
  const fingerprint = traceFingerprint(input.query, symbols);
  const marker = traceIncomplete(trace.diagnostics, input.nowMs);
  return {
    atoms: trace.records.map((record) => traceAtom(input.scope, record, fingerprint, input.nowMs)),
    uncertainty: marker === undefined ? [] : [marker],
  };
}
