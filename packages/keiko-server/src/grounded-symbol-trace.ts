import { createHash } from "node:crypto";
import type {
  ContextCoverageDiagnostics,
  EvidenceAtom,
  EvidenceEdge,
  RetrievalQuery,
  SelectedScope,
  UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { CONTEXT_COVERAGE_TRUNCATION_REASONS } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  isDirectEvidenceLookup,
  type RetrievalIntent,
  type SearchAnchor,
} from "@oscharko-dev/keiko-workflows";
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
import {
  repositoryConfiguredRouteDeclarations,
  repositoryRouteQuery,
  repositorySourceLines,
  buildMatcher,
  repositorySourceMaxLineScore,
  type StructuralAdapterRequestContext,
  type CodeIntelligenceIndex,
  type CodeCallEdge,
  type CodeSymbol,
  type CodeReferenceEdge,
} from "@oscharko-dev/keiko-workspace/code-intelligence";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";

interface FollowSymbolTraceEvidenceInput {
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly anchors: readonly SearchAnchor[];
  readonly retrievalIntent: RetrievalIntent;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
  readonly requestContext?: StructuralAdapterRequestContext | undefined;
  readonly deadlineAtMs?: number | undefined;
  readonly tryReserveSearchCall?: (() => boolean) | undefined;
}

interface DiscoveredSymbolTraceEvidenceInput extends FollowSymbolTraceEvidenceInput {
  readonly atoms: readonly EvidenceAtom[];
  readonly workspaceIndex?: WorkspaceIndex | undefined;
  readonly definitionCertificates?: WeakMap<EvidenceAtom, CodeSymbol> | undefined;
}

export interface FollowSymbolTraceEvidence {
  readonly atoms: readonly EvidenceAtom[];
  readonly uncertainty: readonly UncertaintyMarker[];
}

const TRACE_MAX_DEPTH = 3;
const TRACE_MAX_RECORDS = 48;
const MAX_DISCOVERY_ATOMS = 12;
const MAX_DISCOVERED_SYMBOLS = 4;
const MAX_DISCOVERY_EXCERPT_BYTES = 4096;
const ROUTER_HANDLER_RE =
  /\b(?:router|app|server)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(["'])([^"'\n]+)\2\s*,\s*([a-z_$][a-z0-9_$]{0,127})(?=\s*[,)])/giu;
const ROUTE_TRACE_QUERY_RE =
  /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b[^\n]*\/[a-z0-9._~!$&'()*+,;=:@%/-]+/iu;
const TEST_DIRECTORY_PATH_RE = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/iu;
const TEST_FILE_PATH_RE = /\.(?:test|spec)\.[^/]+$/iu;
export const GROUNDED_TRACE_SEARCH_LIMITS = {
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
  if (
    !diagnostics.depthCapped &&
    !diagnostics.budgetExhausted &&
    !diagnostics.sourceGraphTruncated &&
    diagnostics.skippedEdges === 0
  ) {
    return undefined;
  }
  const reasons = [
    ...(diagnostics.depthCapped ? [`depth>${String(diagnostics.maxDepth)}`] : []),
    ...(diagnostics.budgetExhausted ? [`records>${String(diagnostics.maxRecords)}`] : []),
    ...(diagnostics.sourceGraphTruncated ? ["source-graph-truncated"] : []),
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
      !TEST_DIRECTORY_PATH_RE.test(atom.scopePath) &&
      !TEST_FILE_PATH_RE.test(atom.scopePath),
  );
}

function discoveryAtoms(
  atoms: readonly EvidenceAtom[],
  maxAtoms: number = MAX_DISCOVERY_ATOMS,
): readonly EvidenceAtom[] {
  return [...eligibleDiscoveryAtoms(atoms)]
    .sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.scopePath.localeCompare(b.scopePath),
    )
    .slice(0, maxAtoms);
}

function compareRouteDiscoveryAtoms(a: EvidenceAtom, b: EvidenceAtom): number {
  const certifiedDelta =
    Number(b.provenance.tool === "endpoint-contract-server-route") -
    Number(a.provenance.tool === "endpoint-contract-server-route");
  if (certifiedDelta !== 0) return certifiedDelta;
  const routeDelta =
    Number(ROUTE_REGISTRATION_PATH_RE.test(b.scopePath)) -
    Number(ROUTE_REGISTRATION_PATH_RE.test(a.scopePath));
  if (routeDelta !== 0) return routeDelta;
  if (b.score !== a.score) return b.score - a.score;
  return a.scopePath.localeCompare(b.scopePath);
}

function routeDiscoveryAtoms(atoms: readonly EvidenceAtom[]): readonly EvidenceAtom[] {
  return [...eligibleDiscoveryAtoms(atoms)]
    .sort(compareRouteDiscoveryAtoms)
    .slice(0, MAX_DISCOVERY_ATOMS);
}

function discoveredDefinitionCurrent(
  input: DiscoveredSymbolTraceEvidenceInput,
  atom: EvidenceAtom,
): boolean {
  return (
    (atom.provenance.tool !== "discovered-symbol-definition" &&
      input.definitionCertificates?.has(atom) !== true) ||
    input.requestContext === undefined ||
    input.requestContext.isCodeIntelligenceSourceCurrent(atom.scopePath)
  );
}

interface DiscoveryExcerptObservation {
  readonly content: string;
  readonly scopePath: string;
  readonly lineRange: EvidenceAtom["lineRange"];
  readonly truncated: boolean;
  readonly definition?: CodeSymbol | undefined;
  readonly sourceReference?: boolean | undefined;
}

async function discoveryExcerptObservation(
  input: DiscoveredSymbolTraceEvidenceInput,
  atom: EvidenceAtom,
): Promise<DiscoveryExcerptObservation> {
  const unavailable = {
    content: "",
    scopePath: atom.scopePath,
    lineRange: undefined,
    truncated: false,
  };
  if (traceWorkStopped(input) || !discoveredDefinitionCurrent(input, atom)) return unavailable;
  const range = atom.lineRange;
  if (range === undefined) return unavailable;
  const result = await readExcerpt(
    input.searchScope,
    {
      scopePath: atom.scopePath,
      ...range,
      endLine:
        atom.provenance.tool === "endpoint-contract-server-route"
          ? range.startLine + 3
          : range.endLine,
      maxBytes: MAX_DISCOVERY_EXCERPT_BYTES,
    },
    {
      fs: input.fs,
      nowMs: input.nowMs,
      ...(input.deadlineAtMs === undefined ? {} : { deadlineAtMs: input.deadlineAtMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
  return discoveredDefinitionCurrent(input, atom)
    ? {
        content: result.content,
        scopePath: atom.scopePath,
        lineRange: result.atom.lineRange,
        truncated: result.truncated,
        definition: input.definitionCertificates?.get(atom),
        sourceReference: atom.edge?.kind === "reference",
      }
    : unavailable;
}

async function discoveryExcerpt(
  input: DiscoveredSymbolTraceEvidenceInput,
  atom: EvidenceAtom,
): Promise<string> {
  return (await discoveryExcerptObservation(input, atom)).content;
}

function traceWorkStopped(input: FollowSymbolTraceEvidenceInput): boolean {
  if (input.signal?.aborted === true) {
    throw new CancelledError("grounded symbol trace cancelled");
  }
  return input.deadlineAtMs !== undefined && input.nowMs() >= input.deadlineAtMs;
}

interface ObservedRouteHandler {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

interface RouteHandlerTarget {
  readonly symbol: string;
  readonly definition: CodeSymbol;
}

function handlerSymbolsFromContent(
  content: string,
  scopePath: string,
  query: RetrievalQuery,
): readonly ObservedRouteHandler[] {
  const endpoint = repositoryRouteQuery(query.text);
  if (endpoint === undefined) return [];
  const lines = repositorySourceLines(content, scopePath);
  const code = lines.map((line) => line.code).join("\n");
  const structural = lines.map((line) => line.structural).join("\n");
  const configured = repositoryConfiguredRouteDeclarations(code, structural)
    .filter(
      (route) => route.method === endpoint.method && route.path.toLowerCase() === endpoint.path,
    )
    .map((route) => ({ name: route.handler, start: route.handlerStart, end: route.handlerEnd }));
  const fluent = [...code.matchAll(ROUTER_HANDLER_RE)]
    .filter(
      (match) =>
        match[1]?.toLowerCase() === endpoint.method &&
        match[3]?.toLowerCase() === endpoint.path &&
        /^(?:router|app|server)\b/u.test(structural.slice(match.index)),
    )
    .flatMap((match) => {
      const name = match[4];
      if (name === undefined) return [];
      const start = match.index + match[0].lastIndexOf(name);
      return [{ name, start, end: start + name.length }];
    });
  return [...configured, ...fluent];
}

function observedReferenceSpan(
  reference: CodeReferenceEdge,
  line: number,
  column: number,
  width: number,
): boolean {
  const span = reference.referenceSpan;
  if (span === undefined) return false;
  return span.startColumn === column && span.endLine === line && span.endColumn === column + width;
}

function observedHandlerReference(
  handler: ObservedRouteHandler,
  observation: DiscoveryExcerptObservation,
  reference: CodeReferenceEdge,
): boolean {
  if (observation.lineRange === undefined) return false;
  const start = observation.content.slice(0, handler.start).split("\n");
  const line = observation.lineRange.startLine + start.length - 1;
  const column = start.at(-1)?.length ?? 0;
  return (
    reference.referencerPath === observation.scopePath &&
    reference.referenceName === handler.name &&
    reference.referenceLineRange.startLine === line &&
    observedReferenceSpan(reference, line, column, handler.name.length)
  );
}

function boundRouteHandlerTargets(
  input: DiscoveredSymbolTraceEvidenceInput,
  observation: DiscoveryExcerptObservation,
  index: CodeIntelligenceIndex,
): readonly RouteHandlerTarget[] {
  if (input.requestContext?.isCodeIntelligenceSourceCurrent(observation.scopePath) !== true)
    return [];
  return handlerSymbolsFromContent(observation.content, observation.scopePath, input.query)
    .flatMap((handler) =>
      index.references.filter(
        (reference) =>
          reference.parser === "typescript-compiler-ast" &&
          reference.binding === "lexical" &&
          reference.confidence === "resolved" &&
          observedHandlerReference(handler, observation, reference),
      ),
    )
    .flatMap((reference) => {
      const definition = indexedReferenceTarget(reference, index);
      return definition !== undefined &&
        input.requestContext?.isCodeIntelligenceSourceCurrent(definition.scopePath) === true
        ? [{ symbol: definition.name, definition }]
        : [];
    });
}

function indexedReferenceTarget(
  reference: CodeReferenceEdge,
  index: CodeIntelligenceIndex,
): CodeSymbol | undefined {
  return index.symbols.find(
    (symbol) =>
      symbol.parser === "typescript-compiler-ast" &&
      symbol.name === reference.targetName &&
      symbol.scopePath === reference.targetPath &&
      symbol.lineRange.startLine === reference.targetLineRange.startLine &&
      sameDeclarationSpan(symbol.declarationSpan, reference.targetDeclarationSpan),
  );
}

async function discoveredHandlerSymbols(
  input: DiscoveredSymbolTraceEvidenceInput,
): Promise<readonly RouteHandlerTarget[]> {
  const candidates = routeDiscoveryAtoms(input.atoms);
  const index = await admittedDefinitionIndex(input, candidates);
  if (index === undefined) return [];
  const observations = await Promise.all(
    candidates.map(async (atom) => discoveryExcerptObservation(input, atom)),
  );
  const targets = observations.flatMap((observation) =>
    boundRouteHandlerTargets(input, observation, index),
  );
  return [
    ...new Map(targets.map((target) => [definitionIdentity(target.definition), target])).values(),
  ].slice(0, MAX_DISCOVERED_SYMBOLS);
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
  target: RouteHandlerTarget,
): Promise<DiscoveredSymbolSearchEvidence> {
  const query = exactSymbolQuery(target.symbol, input.nowMs);
  const requestDeps = {
    searchHints: { retrievalIntent: "targeted-code-search" as const },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.workspaceIndex === undefined ? {} : { workspaceIndex: input.workspaceIndex }),
  };
  const result =
    input.requestContext === undefined
      ? await searchText(input.searchScope, query, GROUNDED_TRACE_SEARCH_LIMITS, {
          fs: input.fs,
          nowMs: input.nowMs,
          ...(input.deadlineAtMs === undefined ? {} : { deadlineAtMs: input.deadlineAtMs }),
          ...requestDeps,
        })
      : await input.requestContext.searchText(query, GROUNDED_TRACE_SEARCH_LIMITS, requestDeps);
  return {
    atoms: await promoteDiscoveredSymbolAtoms(input, target, result.atoms),
    coverage: result.coverage,
  };
}

interface DiscoveredSymbolSearchEvidence {
  readonly atoms: readonly EvidenceAtom[];
  readonly coverage: ContextCoverageDiagnostics;
}

function discoveredTraceProvenance(
  scopeId: string,
  atom: EvidenceAtom,
  tool: "discovered-symbol-definition" | "structural-edge-target",
): EvidenceAtom {
  const lineRange = atom.lineRange;
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
      edge: atom.edge,
    }),
    lineRange,
    provenance,
  };
}

function discoveredTraceAtom(
  scopeId: string,
  atom: EvidenceAtom,
  isDeclaration: boolean,
): EvidenceAtom {
  return {
    ...discoveredTraceProvenance(
      scopeId,
      atom,
      isDeclaration ? "discovered-symbol-definition" : "structural-edge-target",
    ),
    score: isDeclaration ? atom.score : Math.max(0.6, atom.score * 0.75),
  };
}

async function admittedDefinitionIndex(
  input: DiscoveredSymbolTraceEvidenceInput,
  candidates: readonly EvidenceAtom[],
): Promise<CodeIntelligenceIndex | undefined> {
  if (candidates.length === 0 || input.requestContext === undefined || traceWorkStopped(input))
    return undefined;
  input.requestContext.assertGraphBinding(
    input.searchScope,
    GROUNDED_TRACE_SEARCH_LIMITS,
    input.fs,
  );
  const index = await input.requestContext.codeIntelligenceIndex();
  input.requestContext.assertGraphBinding(
    input.searchScope,
    GROUNDED_TRACE_SEARCH_LIMITS,
    input.fs,
  );
  return traceWorkStopped(input) ? undefined : index;
}

function sameDeclarationSpan(
  left: CodeSymbol["declarationSpan"],
  right: CodeSymbol["declarationSpan"],
): boolean {
  if (left === undefined || right === undefined) return false;
  return (
    left.startColumn === right.startColumn &&
    left.endLine === right.endLine &&
    left.endColumn === right.endColumn
  );
}

function definitionIdentity(definition: CodeSymbol): string {
  return JSON.stringify([
    definition.scopePath,
    definition.name,
    definition.lineRange.startLine,
    definition.declarationSpan,
  ]);
}

function certifyDefinitionAtom(
  input: DiscoveredSymbolTraceEvidenceInput,
  atom: EvidenceAtom,
  definition: CodeSymbol,
): EvidenceAtom {
  input.definitionCertificates?.set(atom, definition);
  return atom;
}

async function promotedDiscoveredAtom(
  input: DiscoveredSymbolTraceEvidenceInput,
  atom: EvidenceAtom,
  target: RouteHandlerTarget,
): Promise<EvidenceAtom> {
  const current = input.requestContext?.isCodeIntelligenceSourceCurrent(atom.scopePath) === true;
  const admitted = current ? { ...atom, lineRange: target.definition.lineRange } : atom;
  await discoveryExcerpt(input, admitted);
  const certified = current && input.requestContext.isCodeIntelligenceSourceCurrent(atom.scopePath);
  const promoted = discoveredTraceAtom(input.scope.scopeId, certified ? admitted : atom, certified);
  return certified ? certifyDefinitionAtom(input, promoted, target.definition) : promoted;
}

async function promoteDiscoveredSymbolAtoms(
  input: DiscoveredSymbolTraceEvidenceInput,
  target: RouteHandlerTarget,
  atoms: readonly EvidenceAtom[],
): Promise<readonly EvidenceAtom[]> {
  const candidates = eligibleDiscoveryAtoms(atoms)
    .filter(
      (atom) =>
        atom.scopePath === target.definition.scopePath &&
        atom.lineRange?.startLine === target.definition.lineRange.startLine,
    )
    .slice(0, MAX_DISCOVERY_ATOMS);
  return Promise.all(candidates.map((atom) => promotedDiscoveredAtom(input, atom, target)));
}

type DiscoveredTraceClipReason =
  "frontier-width" | "search-budget" | "deadline" | "excerpt-clipped" | "source-graph-incomplete";

interface DiscoveredTraceClipping {
  readonly reasons: Set<DiscoveredTraceClipReason>;
  frontierOmitted: number;
  excerptsClipped: number;
  depthsVisited: number;
}

function callWithinObservedExcerpt(
  call: CodeCallEdge,
  observation: DiscoveryExcerptObservation,
): boolean {
  const range = observation.lineRange;
  const span = call.callerSpan;
  if (
    range === undefined ||
    span === undefined ||
    call.callerLine < range.startLine ||
    span.endLine > range.endLine
  )
    return false;
  const lines = observation.content.split("\n");
  const start = lines[call.callerLine - range.startLine];
  const end = lines[span.endLine - range.startLine];
  return (
    start !== undefined &&
    end !== undefined &&
    span.startColumn < start.length &&
    span.endColumn <= end.length
  );
}

function callOwnedByObservation(
  call: CodeCallEdge,
  observation: DiscoveryExcerptObservation,
): boolean {
  const owner = call.callerDefinition;
  const definition = observation.definition;
  if (owner === undefined || definition === undefined) return false;
  return (
    owner.name === definition.name &&
    owner.lineRange.startLine === definition.lineRange.startLine &&
    sameDeclarationSpan(owner.declarationSpan, definition.declarationSpan)
  );
}

function currentObservedSourceCall(
  input: DiscoveredSymbolTraceEvidenceInput,
  observation: DiscoveryExcerptObservation,
  call: CodeCallEdge,
): boolean {
  return (
    call.parser === "typescript-compiler-ast" &&
    call.confidence === "resolved" &&
    call.binding === "lexical" &&
    call.callerPath === observation.scopePath &&
    callWithinObservedExcerpt(call, observation) &&
    input.requestContext?.isCodeIntelligenceSourceCurrent(call.targetPath) === true
  );
}

function sameCallReferenceSource(call: CodeCallEdge, reference: CodeReferenceEdge): boolean {
  const referenceSpan = reference.referenceSpan;
  const callSpan = call.callerSpan;
  if (referenceSpan === undefined || callSpan === undefined) return false;
  return (
    reference.referencerPath === call.callerPath &&
    reference.referenceName === call.calleeName &&
    reference.referenceLineRange.startLine === call.callerLine &&
    referenceSpan.startColumn === callSpan.startColumn &&
    referenceSpan.endLine === call.callerLine &&
    referenceSpan.endColumn === callSpan.startColumn + call.calleeName.length
  );
}

function sameCallReferenceTarget(call: CodeCallEdge, reference: CodeReferenceEdge): boolean {
  return (
    reference.targetPath === call.targetPath &&
    reference.targetName === call.targetName &&
    reference.targetLineRange.startLine === call.targetLineRange.startLine &&
    sameDeclarationSpan(reference.targetDeclarationSpan, call.targetDeclarationSpan)
  );
}

function observedCallReference(call: CodeCallEdge, reference: CodeReferenceEdge): boolean {
  return (
    reference.parser === "typescript-compiler-ast" &&
    reference.binding === "lexical" &&
    reference.confidence === "resolved" &&
    sameCallReferenceSource(call, reference) &&
    sameCallReferenceTarget(call, reference)
  );
}

interface ObservedBodyTarget {
  readonly call: CodeCallEdge;
  readonly sourceReference: boolean;
}

function certifiedBodyCalls(
  input: DiscoveredSymbolTraceEvidenceInput,
  observation: DiscoveryExcerptObservation,
  index: CodeIntelligenceIndex,
  clipping: DiscoveredTraceClipping,
): readonly ObservedBodyTarget[] {
  if (
    observation.content.length === 0 ||
    input.requestContext?.isCodeIntelligenceSourceCurrent(observation.scopePath) !== true
  )
    return [];
  const current = index.calls.filter((call) => currentObservedSourceCall(input, observation, call));
  const unsupported = current.filter((call) => call.callerDefinition === undefined).length;
  if (unsupported > 0) {
    clipping.reasons.add("source-graph-incomplete");
    clipping.frontierOmitted += unsupported;
  }
  return current.flatMap((call) => {
    if (callOwnedByObservation(call, observation))
      return [{ call, sourceReference: observation.sourceReference === true }];
    return call.callerDefinition === undefined &&
      index.references.some((reference) => observedCallReference(call, reference))
      ? [{ call, sourceReference: true }]
      : [];
  });
}

function orderedBodyCalls(calls: readonly ObservedBodyTarget[]): readonly ObservedBodyTarget[] {
  return [...calls].sort(
    (a, b) =>
      Number(b.call.resultUsage === "returned") - Number(a.call.resultUsage === "returned") ||
      (a.call.resultUsage === "returned"
        ? b.call.callerLine - a.call.callerLine
        : a.call.callerLine - b.call.callerLine),
  );
}

function targetIdentity(call: CodeCallEdge): string {
  return JSON.stringify([
    call.targetPath,
    call.targetName,
    call.targetLineRange.startLine,
    call.targetDeclarationSpan,
  ]);
}

function resolvedTargetAtom(
  input: DiscoveredSymbolTraceEvidenceInput,
  call: CodeCallEdge,
  index: CodeIntelligenceIndex,
): EvidenceAtom | undefined {
  const definition = index.symbols.find(
    (symbol) =>
      symbol.parser === "typescript-compiler-ast" &&
      symbol.scopePath === call.targetPath &&
      symbol.name === call.targetName &&
      symbol.lineRange.startLine === call.targetLineRange.startLine &&
      symbol.lineRange.endLine === call.targetLineRange.endLine &&
      sameDeclarationSpan(symbol.declarationSpan, call.targetDeclarationSpan),
  );
  if (
    definition === undefined ||
    input.requestContext?.isCodeIntelligenceSourceCurrent(definition.scopePath) !== true
  )
    return undefined;
  const fingerprint = traceFingerprint(input.query, [targetIdentity(call)]);
  const provenance = {
    kind: "structural" as const,
    tool: "discovered-symbol-definition",
    queryFingerprint: fingerprint,
  };
  return certifyDefinitionAtom(
    input,
    {
      schemaVersion: input.scope.schemaVersion,
      stableId: evidenceAtomStableId({
        scopeId: input.scope.scopeId,
        scopePath: definition.scopePath,
        lineRange: definition.lineRange,
        provenanceKind: provenance.kind,
        provenanceTool: provenance.tool,
        queryFingerprint: fingerprint,
      }),
      scopePath: definition.scopePath,
      lineRange: definition.lineRange,
      score: 0,
      provenance,
      redactionState: "redacted",
      emittedAtMs: input.nowMs(),
      ledgerRef: undefined,
    },
    definition,
  );
}

function observedReferenceEdge(call: CodeCallEdge): EvidenceEdge | undefined {
  if (call.callerSpan === undefined) return undefined;
  return {
    kind: "reference",
    source: {
      scopePath: call.callerPath,
      lineRange: { startLine: call.callerLine, endLine: call.callerSpan.endLine },
      symbol: call.calleeName,
    },
    target: {
      scopePath: call.targetPath,
      lineRange: call.targetLineRange,
      symbol: call.targetName,
    },
    confidence: "resolved",
  };
}

async function certifiedTargetAtom(
  input: DiscoveredSymbolTraceEvidenceInput,
  call: CodeCallEdge,
  index: CodeIntelligenceIndex,
  sourceReference: boolean,
): Promise<EvidenceAtom | undefined> {
  const target = resolvedTargetAtom(input, call, index);
  if (target === undefined || traceWorkStopped(input)) return undefined;
  const definition = input.definitionCertificates?.get(target);
  if (definition === undefined) return undefined;
  const atom = certifyDefinitionAtom(
    input,
    { ...target, lineRange: call.targetLineRange },
    definition,
  );
  const observation = await discoveryExcerptObservation(input, atom);
  if (
    observation.content.length === 0 ||
    input.requestContext?.isCodeIntelligenceSourceCurrent(call.targetPath) !== true
  )
    return undefined;
  const emitted = observedTargetDefinitionAtom(input, atom, call, observation, sourceReference);
  return emitted === undefined ? undefined : certifyDefinitionAtom(input, emitted, definition);
}

function observedTargetDefinitionAtom(
  input: DiscoveredSymbolTraceEvidenceInput,
  atom: EvidenceAtom,
  call: CodeCallEdge,
  observation: DiscoveryExcerptObservation,
  sourceReference: boolean,
): EvidenceAtom | undefined {
  const edge = sourceReference ? observedReferenceEdge(call) : undefined;
  if (sourceReference && edge === undefined) return undefined;
  return discoveredTraceProvenance(
    input.scope.scopeId,
    {
      ...atom,
      ...(edge === undefined ? {} : { edge }),
      score: observedDefinitionScore(input.query, observation),
    },
    "discovered-symbol-definition",
  );
}

function observedDefinitionScore(
  query: RetrievalQuery,
  observation: DiscoveryExcerptObservation,
): number {
  const matcher = buildMatcher(query);
  return repositorySourceMaxLineScore(
    repositorySourceLines(observation.content, observation.scopePath).map((line) => ({
      score: matcher.match(line.raw, line),
    })),
  );
}

function interleaveCallGroup(
  frontiers: readonly (readonly ObservedBodyTarget[])[],
): readonly ObservedBodyTarget[] {
  const out: ObservedBodyTarget[] = [];
  const length = Math.max(0, ...frontiers.map((frontier) => frontier.length));
  for (let index = 0; index < length; index += 1) {
    for (const frontier of frontiers) {
      const call = frontier[index];
      if (call !== undefined) out.push(call);
    }
  }
  return out;
}

function interleaveBodyCalls(
  frontiers: readonly (readonly ObservedBodyTarget[])[],
): readonly ObservedBodyTarget[] {
  return [
    ...interleaveCallGroup(
      frontiers.map((calls) => calls.filter((target) => target.call.awaited === true)),
    ),
    ...interleaveCallGroup(
      frontiers.map((calls) => calls.filter((target) => target.call.awaited !== true)),
    ),
  ];
}

function boundedDefinitionObservations(
  input: DiscoveredSymbolTraceEvidenceInput,
  atoms: readonly EvidenceAtom[],
  clipping: DiscoveredTraceClipping,
  query: RetrievalQuery,
): readonly EvidenceAtom[] {
  const definitions = eligibleDiscoveryAtoms(
    atoms.filter((atom) => input.definitionCertificates?.has(atom) === true),
  );
  const candidates = discoveryAtoms(definitions, continuationLimit(query));
  const omitted = definitions.length - candidates.length;
  clipping.frontierOmitted += omitted;
  if (omitted > 0) clipping.reasons.add("frontier-width");
  return candidates;
}

function continuationLimit(query: RetrievalQuery): number {
  return Number.isSafeInteger(query.maxResults) && query.maxResults >= 0 ? query.maxResults : 0;
}

async function nextDefinitionFrontier(
  input: DiscoveredSymbolTraceEvidenceInput,
  atoms: readonly EvidenceAtom[],
  seen: Set<string>,
  clipping: DiscoveredTraceClipping,
  remainingTargets: number,
): Promise<readonly EvidenceAtom[]> {
  const candidates = boundedDefinitionObservations(input, atoms, clipping, input.query);
  const maxContinuations = Math.min(continuationLimit(input.query), remainingTargets);
  const index = await admittedDefinitionIndex(input, candidates);
  if (index === undefined) return [];
  if (
    index.candidateLimitReached === true ||
    index.filesSkipped > 0 ||
    index.filesPartiallyIndexed > 0
  )
    clipping.reasons.add("source-graph-incomplete");
  const observations = await Promise.all(
    candidates.map((atom) => discoveryExcerptObservation(input, atom)),
  );
  clipping.excerptsClipped += observations.filter((observation) => observation.truncated).length;
  if (clipping.excerptsClipped > 0) clipping.reasons.add("excerpt-clipped");
  const calls = interleaveBodyCalls(
    observations.map((observation) =>
      orderedBodyCalls(certifiedBodyCalls(input, observation, index, clipping)),
    ),
  );
  const frontier: EvidenceAtom[] = [];
  for (const target of calls) {
    const call = target.call;
    const key = targetIdentity(call);
    if (seen.has(key)) continue;
    seen.add(key);
    if (frontier.length >= maxContinuations) {
      clipping.frontierOmitted += 1;
      clipping.reasons.add("frontier-width");
      continue;
    }
    const atom = await certifiedTargetAtom(input, call, index, target.sourceReference);
    if (atom !== undefined) frontier.push(atom);
  }
  return frontier;
}

function certifiedTargetCapacity(
  index: CodeIntelligenceIndex | undefined,
  query: RetrievalQuery,
): number {
  const identities = new Set(
    index?.symbols
      .filter(
        (symbol) =>
          symbol.parser === "typescript-compiler-ast" && symbol.declarationSpan !== undefined,
      )
      .map(definitionIdentity),
  );
  return Math.min(continuationLimit(query), identities.size);
}

function boundedCertifiedSeeds(
  input: DiscoveredSymbolTraceEvidenceInput,
  atoms: readonly EvidenceAtom[],
  capacity: number,
  clipping: DiscoveredTraceClipping,
): readonly EvidenceAtom[] {
  const identities = new Set<string>();
  return atoms.filter((atom) => {
    if (atom.provenance.tool !== "discovered-symbol-definition") return true;
    const definition = input.definitionCertificates?.get(atom);
    if (definition === undefined) return false;
    const identity = definitionIdentity(definition);
    if (identities.has(identity)) return true;
    if (identities.size >= capacity) {
      clipping.frontierOmitted += 1;
      clipping.reasons.add("frontier-width");
      return false;
    }
    identities.add(identity);
    return true;
  });
}

async function searchSymbolFrontier(
  input: DiscoveredSymbolTraceEvidenceInput,
  symbols: readonly RouteHandlerTarget[],
  clipping: DiscoveredTraceClipping,
): Promise<readonly DiscoveredSymbolSearchEvidence[]> {
  const pending: Promise<DiscoveredSymbolSearchEvidence>[] = [];
  for (const symbol of symbols) {
    if (traceWorkStopped(input)) {
      clipping.reasons.add("deadline");
      break;
    }
    if (input.tryReserveSearchCall?.() === false) {
      clipping.reasons.add("search-budget");
      break;
    }
    pending.push(searchDiscoveredSymbol(input, symbol));
  }
  clipping.frontierOmitted += symbols.length - pending.length;
  return await Promise.all(pending);
}

function certifiedSeedIdentities(
  input: DiscoveredSymbolTraceEvidenceInput,
  atoms: readonly EvidenceAtom[],
): Set<string> {
  return new Set(
    atoms.flatMap((atom) => {
      const definition = input.definitionCertificates?.get(atom);
      return definition === undefined ? [] : [definitionIdentity(definition)];
    }),
  );
}

function attenuatedTraceAtom(
  input: DiscoveredSymbolTraceEvidenceInput,
  atom: EvidenceAtom,
): EvidenceAtom {
  const emitted = { ...atom, score: atom.score * 0.92 };
  const definition = input.definitionCertificates?.get(atom);
  return definition === undefined ? emitted : certifyDefinitionAtom(input, emitted, definition);
}

async function traceDiscoveredSymbols(
  input: DiscoveredSymbolTraceEvidenceInput,
  seedSymbols: readonly RouteHandlerTarget[],
): Promise<{
  readonly atoms: readonly EvidenceAtom[];
  readonly coverage: readonly ContextCoverageDiagnostics[];
  readonly clipping: DiscoveredTraceClipping;
}> {
  const clipping: DiscoveredTraceClipping = {
    reasons: new Set(),
    frontierOmitted: 0,
    excerptsClipped: 0,
    depthsVisited: 0,
  };
  const searches = await searchSymbolFrontier(input, seedSymbols, clipping);
  const found = searches.flatMap((search) => search.atoms);
  const capacity = certifiedTargetCapacity(
    await admittedDefinitionIndex(input, found),
    input.query,
  );
  const atoms = [...boundedCertifiedSeeds(input, found, capacity, clipping)];
  const seen = certifiedSeedIdentities(input, atoms);
  let retained = seen.size;
  let frontier: readonly EvidenceAtom[] = atoms;
  for (let depth = 1; frontier.length > 0; depth += 1) {
    if (traceWorkStopped(input)) {
      clipping.reasons.add("deadline");
      clipping.frontierOmitted += frontier.length;
      break;
    }
    frontier = await nextDefinitionFrontier(
      input,
      frontier,
      seen,
      clipping,
      Math.max(0, capacity - retained),
    );
    retained += frontier.length;
    clipping.depthsVisited = depth;
    atoms.push(...frontier.map((atom) => attenuatedTraceAtom(input, atom)));
  }
  return {
    atoms: [...new Map(atoms.map((atom) => [atom.stableId, atom])).values()],
    coverage: searches.map((search) => search.coverage),
    clipping,
  };
}

function discoveredTraversalMarker(
  clipping: DiscoveredTraceClipping,
  nowMs: () => number,
): UncertaintyMarker | undefined {
  if (clipping.reasons.size === 0) return undefined;
  return {
    kind: "scope-incomplete",
    claim: `Discovered-symbol traversal was incomplete: reasons=${[...clipping.reasons].sort().join(",")}; frontierOmitted=${String(clipping.frontierOmitted)}, excerptsClipped=${String(clipping.excerptsClipped)}, depthsVisited=${String(clipping.depthsVisited)}.`,
    impactedAtomIds: [],
    emittedAtMs: nowMs(),
  };
}

function discoveredTraceCoverageMarker(
  coverage: readonly ContextCoverageDiagnostics[],
  nowMs: () => number,
): UncertaintyMarker | undefined {
  const incomplete = coverage.filter((entry) => entry.incomplete);
  if (incomplete.length === 0) return undefined;
  const reasons = CONTEXT_COVERAGE_TRUNCATION_REASONS.filter((reason) =>
    incomplete.some((entry) => entry.reasons.includes(reason)),
  );
  const sum = (field: "filesScanned" | "filesSkipped" | "matchesReturned"): number =>
    incomplete.reduce((total, entry) => total + entry[field], 0);
  const budgetClipped = reasons.some(
    (reason) => reason === "file-cap" || reason === "match-cap" || reason === "timeout",
  );
  return {
    kind: budgetClipped ? "budget-clipped" : "scope-incomplete",
    claim:
      `Discovered-symbol trace search was incomplete across ${String(incomplete.length)} ` +
      `search(es): reasons=${reasons.join(",")}; filesScanned=${String(sum("filesScanned"))}, ` +
      `filesSkipped=${String(sum("filesSkipped"))}, ` +
      `matchesReturned=${String(sum("matchesReturned"))}.`,
    impactedAtomIds: [],
    emittedAtMs: nowMs(),
  };
}

export async function collectDiscoveredSymbolTraceEvidence(
  input: DiscoveredSymbolTraceEvidenceInput,
): Promise<FollowSymbolTraceEvidence> {
  if (traceWorkStopped(input)) return { atoms: [], uncertainty: [] };
  if (!shouldTrace(input)) return { atoms: [], uncertainty: [] };
  if (!ROUTE_TRACE_QUERY_RE.test(input.query.text)) return { atoms: [], uncertainty: [] };
  const requestInput = {
    ...input,
    definitionCertificates: new WeakMap<EvidenceAtom, CodeSymbol>(),
  };
  const symbols = await discoveredHandlerSymbols(requestInput);
  if (symbols.length === 0) return { atoms: [], uncertainty: [] };
  const trace = await traceDiscoveredSymbols(requestInput, symbols);
  const marker = discoveredTraceCoverageMarker(trace.coverage, input.nowMs);
  return {
    atoms: trace.atoms,
    uncertainty: [marker, discoveredTraversalMarker(trace.clipping, input.nowMs)].filter(
      (entry): entry is UncertaintyMarker => entry !== undefined,
    ),
  };
}

function reservedFollowTraceSymbols(input: FollowSymbolTraceEvidenceInput): readonly string[] {
  if (!shouldTrace(input)) return [];
  if (isDirectEvidenceLookup(input.query, input.anchors)) return [];
  const symbols = traceSymbols(input.anchors);
  if (symbols.length === 0 || input.tryReserveSearchCall?.() === false) return [];
  return traceWorkStopped(input) ? [] : symbols;
}

export async function collectFollowSymbolTraceEvidence(
  input: FollowSymbolTraceEvidenceInput,
): Promise<FollowSymbolTraceEvidence> {
  if (traceWorkStopped(input)) return { atoms: [], uncertainty: [] };
  const symbols = reservedFollowTraceSymbols(input);
  if (symbols.length === 0) return { atoms: [], uncertainty: [] };
  const trace = await followSymbolTrace(
    input.searchScope,
    GROUNDED_TRACE_SEARCH_LIMITS,
    input.fs,
    {
      symbols,
      maxDepth: TRACE_MAX_DEPTH,
      maxRecords: TRACE_MAX_RECORDS,
    },
    input.requestContext === undefined ? {} : { requestContext: input.requestContext },
  );
  const fingerprint = traceFingerprint(input.query, symbols);
  const marker = traceIncomplete(trace.diagnostics, input.nowMs);
  return {
    atoms: trace.records.map((record) => traceAtom(input.scope, record, fingerprint, input.nowMs)),
    uncertainty: marker === undefined ? [] : [marker],
  };
}
