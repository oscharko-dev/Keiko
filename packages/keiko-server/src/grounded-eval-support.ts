// Shared eval support: assemble a fully-typed, minimal `ConnectedContextPack` from just the evidence
// a grounding eval controls (files + uncertainty). Every other pack field is filled with an inert,
// valid default here — once — so the eval harnesses never reach for `as unknown as ConnectedContextPack`
// (which would silently hide a missing or invalid field as the pack contract evolves). The grounding
// checkers under test only read `files[].scopePath`, `excerpts[].atom.lineRange`, `excerpts[].content`,
// `excerpts.length`, and `uncertainty[].kind`; the remaining fields carry deterministic placeholders
// and never influence a score.

import type {
  ConnectedContextPack,
  ConnectedFileEntry,
  EvidenceAtom,
  ExplorationBudget,
  ExplorationUsage,
  LineRange,
  RetrievalQuery,
  SelectedScope,
  UncertaintyMarker,
  UncertaintyMarkerKind,
} from "@oscharko-dev/keiko-contracts";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/connected-context";

const EVAL_SCOPE: SelectedScope = {
  schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
  scopeId: "eval-scope",
  workspaceRoot: "/eval",
  kind: "directory",
  relativePaths: [],
  conversationId: undefined,
  connectedAtMs: 0,
  explicitConnection: true,
};

const EVAL_QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "eval",
  caseSensitive: false,
  maxResults: 0,
  emittedAtMs: 0,
};

const EVAL_LIMIT: ExplorationBudget = {
  searchCallsMax: 0,
  filesReadMax: 0,
  excerptBytesMax: 0,
  modelInputTokensMax: 0,
  modelOutputTokensMax: 0,
  elapsedMsMax: 0,
  rerankCallsMax: 0,
};

const EVAL_USAGE: ExplorationUsage = {
  searchCalls: 0,
  filesRead: 0,
  excerptBytes: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  elapsedMs: 0,
  rerankCalls: 0,
};

// A complete evidence atom for the given path/line window; every non-evidence field is a fixed,
// valid placeholder (the checkers under test never read them).
export function evalEvidenceAtom(
  scopePath: string,
  lineRange: LineRange | undefined,
): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: `eval:${scopePath}`,
    scopePath,
    lineRange,
    score: 1,
    provenance: { kind: "excerpt-read", tool: "eval", queryFingerprint: "eval" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

export interface EvalExcerptInput {
  readonly content: string;
  readonly lineRange?: LineRange | undefined;
}

// A file entry carrying the fixture's excerpts, with the required role/selectionReason filled in.
export function evalFileEntry(
  scopePath: string,
  excerpts: readonly EvalExcerptInput[],
): ConnectedFileEntry {
  return {
    scopePath,
    role: "read-only",
    selectionReason: "eval-fixture",
    excerpts: excerpts.map((excerpt) => ({
      atom: evalEvidenceAtom(scopePath, excerpt.lineRange),
      content: excerpt.content,
      contentBytes: excerpt.content.length,
    })),
  };
}

// A complete uncertainty marker of the given kind (claim/atom-ids/timestamp are inert placeholders).
export function evalUncertainty(kind: UncertaintyMarkerKind): UncertaintyMarker {
  return { kind, claim: "eval", impactedAtomIds: [], emittedAtMs: 0 };
}

// Assemble a fully-typed pack from the fixture's files + uncertainty; no cast, no hidden field.
export function buildEvalContextPack(
  files: readonly ConnectedFileEntry[],
  uncertainty: readonly UncertaintyMarker[] = [],
): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "eval-pack",
    scope: EVAL_SCOPE,
    query: EVAL_QUERY,
    budget: EVAL_LIMIT,
    usage: EVAL_USAGE,
    files,
    omitted: [],
    uncertainty,
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}
