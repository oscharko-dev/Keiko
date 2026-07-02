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
  type FollowSymbolTraceDiagnostics,
  type FollowSymbolTraceRecord,
  type SearchScope,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
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
}

export interface FollowSymbolTraceEvidence {
  readonly atoms: readonly EvidenceAtom[];
  readonly uncertainty: readonly UncertaintyMarker[];
}

const TRACE_MAX_DEPTH = 3;
const TRACE_MAX_RECORDS = 48;
const TRACE_SEARCH_LIMITS = {
  ...DEFAULT_SEARCH_LIMITS,
  maxMatchesReturned: TRACE_MAX_RECORDS,
};

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

export async function collectFollowSymbolTraceEvidence(
  input: FollowSymbolTraceEvidenceInput,
): Promise<FollowSymbolTraceEvidence> {
  if (!shouldTrace(input)) return { atoms: [], uncertainty: [] };
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
