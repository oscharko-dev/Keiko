// Grounded repository Q&A orchestrator (Epic #177, Issue #185). Composes the connected-context
// layers — #181 exploration planner, #179 lexical search facade, #180 structural adapters,
// #182 candidate ranker, and #183 context-pack assembler — into a single linear pipeline that
// produces a redacted `ConnectedContextPack` plus an assistant-content string. The model call
// is injected through the `GroundedAnswerer` seam so the route can ship today with a
// deterministic stub; a future PR replaces it with a model-gateway-backed implementation.
//
// Pure orchestration: the only IO this module performs is delegated through the workspace
// package's already-bounded WorkspaceFs port. Path validation is enforced by every composed
// layer at its own boundary, so this file does not re-validate scope paths.

import type {
  ConnectedContextPack,
  ExplorationBudget,
  ExplorationUsage,
  RetrievalQuery,
  SelectedScope,
  UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  advanceRing,
  applyUsage,
  assembleContextPack,
  canContinue,
  complete,
  planAndGovern,
  rankCandidates,
  type ClarificationPrompt,
  type ExplorationPlan,
  type GovernorState,
  type RetrievalRing,
} from "@oscharko-dev/keiko-workflows";
import {
  DEFAULT_SEARCH_LIMITS,
  RepoSearchUnsupportedFileError,
  detectWorkspace,
  gitHistoryAdapter,
  importGraphAdapter,
  readExcerpt,
  runStructuralAdapters,
  searchText,
  type SearchScope,
  type StructuralAdapterRegistry,
  testSourcePairingAdapter,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GroundedAnswerer {
  // The seam the route uses; the default is a deterministic stub that summarises the pack.
  // A future PR replaces it with a model-gateway-backed implementation.
  answer(question: string, pack: ConnectedContextPack): Promise<string>;
}

export interface OrchestratorInput {
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly workspaceRoot: string;
  readonly budget?: ExplorationBudget;
}

export interface OrchestratorDeps {
  readonly answerer: GroundedAnswerer;
  readonly nowMs?: () => number;
  // Optional injected port for tests; production uses the realpath-contained node adapter.
  readonly fs?: WorkspaceFs;
  // Optional injected detector for tests so memFs fixtures don't need full WorkspaceInfo wiring.
  readonly detectWorkspace?: (root: string, fs: WorkspaceFs) => WorkspaceInfo;
  // Called after a ready plan exists and before any workspace detection or repository IO starts.
  readonly recordPlan?: (plan: ExplorationPlan) => void;
}

export interface OrchestratorOutput {
  readonly pack: ConnectedContextPack;
  readonly assistantContent: string;
  readonly elapsedMs: number;
  readonly plan?: ExplorationPlan;
}

// Raised when the planner asks for clarification (no anchors, too-generic prompt, etc.). The
// route maps this to a 400 BAD_REQUEST with the planner's clarification reason in the message.
export class ClarificationNeededError extends Error {
  public constructor(public readonly clarification: ClarificationPrompt) {
    super(`clarification needed: ${clarification.reason}`);
    this.name = "ClarificationNeededError";
  }
}

// ─── Default deterministic answerer ───────────────────────────────────────────

export const echoAnswerer: GroundedAnswerer = {
  answer: (question, pack) => {
    try {
      const filePaths = pack.files.map((f) => f.scopePath).join(", ");
      const summary =
        `Inspected ${String(pack.files.length)} file(s) for: ${question}. ` +
        `Findings include: ${filePaths.length === 0 ? "(no evidence)" : filePaths}.`;
      return Promise.resolve(summary);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface SearchInputs {
  readonly searchScope: SearchScope;
  readonly query: RetrievalQuery;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
}

interface RingResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly usage: ExplorationUsage;
}

const TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

function usageDelta(overrides: Partial<ExplorationUsage> = {}): ExplorationUsage {
  return {
    searchCalls: 0,
    filesRead: 0,
    excerptBytes: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 0,
    rerankCalls: 0,
    ...overrides,
  };
}

function clampUsageToBudget(usage: ExplorationUsage, budget: ExplorationBudget): ExplorationUsage {
  return {
    searchCalls: Math.min(usage.searchCalls, budget.searchCallsMax),
    filesRead: Math.min(usage.filesRead, budget.filesReadMax),
    excerptBytes: Math.min(usage.excerptBytes, budget.excerptBytesMax),
    modelInputTokens: Math.min(usage.modelInputTokens, budget.modelInputTokensMax),
    modelOutputTokens: Math.min(usage.modelOutputTokens, budget.modelOutputTokensMax),
    elapsedMs: Math.min(usage.elapsedMs, budget.elapsedMsMax),
    rerankCalls: Math.min(usage.rerankCalls, budget.rerankCallsMax),
  };
}

function budgetClipped(stopReason: string, nowMs: number): UncertaintyMarker {
  return {
    kind: "budget-clipped",
    claim: `repository exploration stopped: ${stopReason}`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

async function runRing(ring: RetrievalRing, inputs: SearchInputs): Promise<RingResult> {
  if (ring.kind === "lexical") {
    const result = await searchText(inputs.searchScope, inputs.query, ring.searchLimits, {
      fs: inputs.fs,
      nowMs: inputs.nowMs,
    });
    return {
      atoms: result.atoms,
      usage: usageDelta({ filesRead: result.filesScanned, elapsedMs: result.elapsedMs }),
    };
  }
  // Keep the planner's ring split authoritative: the structural ring should only run the
  // structural adapters, while the git-history ring should only run the repo-level history
  // adapter. Reusing the full default registry for both rings duplicates atoms and inflates
  // downstream ranking signals whenever a workspace-root query plans both rings.
  const registry: StructuralAdapterRegistry =
    ring.kind === "structural"
      ? { adapters: [testSourcePairingAdapter, importGraphAdapter] }
      : { adapters: [gitHistoryAdapter] };
  const result = await runStructuralAdapters(
    registry,
    inputs.searchScope,
    inputs.query,
    ring.searchLimits,
    inputs.fs,
    { nowMs: inputs.nowMs },
  );
  return {
    atoms: result.atoms,
    usage: usageDelta({ elapsedMs: result.elapsedMs }),
  };
}

interface RingRunSummary {
  readonly atoms: readonly EvidenceAtom[];
  readonly governor: GovernorState;
  readonly uncertainty: readonly UncertaintyMarker[];
}

async function runAllRings(
  rings: readonly RetrievalRing[],
  inputs: SearchInputs,
  initialGovernor: GovernorState,
): Promise<RingRunSummary> {
  const atoms: EvidenceAtom[] = [];
  const uncertainty: UncertaintyMarker[] = [];
  let governor = initialGovernor;
  for (const ring of rings) {
    if (!canContinue(governor)) {
      break;
    }
    const reservedSearchCall = applyUsage(governor, usageDelta({ searchCalls: 1 }));
    if (reservedSearchCall.status === "budget-exhausted") {
      governor = reservedSearchCall;
      uncertainty.push(
        budgetClipped(reservedSearchCall.stopReason ?? "budget exhausted", inputs.nowMs()),
      );
      break;
    }
    governor = reservedSearchCall;
    const result = await runRing(ring, inputs);
    const afterRing = applyUsage(governor, result.usage);
    const ringAtoms = result.atoms;
    atoms.push(...ringAtoms);
    if (afterRing.status === "budget-exhausted") {
      governor = afterRing;
      uncertainty.push(budgetClipped(afterRing.stopReason ?? "budget exhausted", inputs.nowMs()));
      break;
    }
    governor = advanceRing(afterRing);
  }
  if (governor.status === "running") {
    governor = complete(governor);
  }
  return { atoms, governor, uncertainty };
}

interface ExcerptInputs {
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly budget: ExplorationBudget;
  readonly initialUsage: ExplorationUsage;
  readonly nowMs: () => number;
}

interface ExcerptReadSummary {
  readonly excerpts: ReadonlyMap<string, string>;
  readonly uncertainty: readonly UncertaintyMarker[];
}

async function readKeptExcerpts(
  keptPaths: readonly string[],
  inputs: ExcerptInputs,
): Promise<ExcerptReadSummary> {
  const excerpts = new Map<string, string>();
  const uncertainty: UncertaintyMarker[] = [];
  let remainingFiles = Math.max(0, inputs.budget.filesReadMax - inputs.initialUsage.filesRead);
  let remainingBytes = Math.max(
    0,
    inputs.budget.excerptBytesMax - inputs.initialUsage.excerptBytes,
  );
  for (const scopePath of keptPaths) {
    if (remainingFiles <= 0 || remainingBytes <= 0) {
      const dimensions = [
        ...(remainingFiles <= 0 ? ["filesRead"] : []),
        ...(remainingBytes <= 0 ? ["excerptBytes"] : []),
      ].join(", ");
      uncertainty.push(budgetClipped(`budget-exhausted on ${dimensions}`, inputs.nowMs()));
      break;
    }
    try {
      const maxBytes = Math.min(8192, remainingBytes);
      const result = await readExcerpt(
        inputs.searchScope,
        { scopePath, startLine: 1, endLine: 200, maxBytes },
        { fs: inputs.fs },
      );
      excerpts.set(scopePath, result.content);
      remainingFiles -= 1;
      remainingBytes -= utf8ByteLength(result.content);
    } catch (error) {
      if (error instanceof RepoSearchUnsupportedFileError) {
        continue;
      }
      throw error;
    }
  }
  return { excerpts, uncertainty };
}

function buildSearchScope(scope: SelectedScope, workspace: WorkspaceInfo): SearchScope {
  return {
    workspace,
    scopeId: scope.scopeId,
    relativePaths: scope.relativePaths,
  };
}

interface ReadyPlanResult {
  readonly plan: ExplorationPlan;
  readonly governor: GovernorState;
}

function createReadyGovernedPlan(input: OrchestratorInput, nowMs: () => number): ReadyPlanResult {
  const planned = planAndGovern(
    input.budget === undefined
      ? { scope: input.scope, query: input.query }
      : { scope: input.scope, query: input.query, budget: input.budget },
    { nowMs },
  );
  const { plan } = planned;
  if (plan.state !== "ready") {
    if (plan.clarification !== undefined) {
      throw new ClarificationNeededError(plan.clarification);
    }
    throw new ClarificationNeededError({
      reason: "scope-invalid",
      suggestedQuestions: ["Reselect files or a directory before asking."],
      minimumAnchorCount: 0,
    });
  }
  if (planned.governor === undefined) {
    throw new Error("ready exploration plan did not produce a budget governor");
  }
  return { plan, governor: planned.governor };
}

// ─── Public entry ─────────────────────────────────────────────────────────────

export async function runGroundedExploration(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
): Promise<OrchestratorOutput> {
  const fs = deps.fs ?? nodeWorkspaceFs;
  const detect = deps.detectWorkspace ?? detectWorkspace;
  const nowMs = deps.nowMs ?? Date.now;
  const start = nowMs();

  const { plan, governor } = createReadyGovernedPlan(input, nowMs);
  deps.recordPlan?.(plan);

  const workspace = detect(input.workspaceRoot, fs);
  const searchScope = buildSearchScope(input.scope, workspace);
  const rings = await runAllRings(
    plan.rings,
    { searchScope, query: input.query, fs, nowMs },
    governor,
  );
  const atoms = rings.atoms;
  const initialUsage = clampUsageToBudget(rings.governor.usage, plan.budget);

  const ranking = rankCandidates({ atoms, anchors: plan.anchors }, { nowMs });

  const excerptReads = await readKeptExcerpts(
    ranking.kept.map((c) => c.scopePath),
    { searchScope, fs, budget: plan.budget, initialUsage, nowMs },
  );

  const assemble = await assembleContextPack(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms,
      ranked: ranking.kept,
      omittedFromRanking: ranking.omitted,
      excerpts: excerptReads.excerpts,
      initialUsage,
      initialUncertainty: [...rings.uncertainty, ...excerptReads.uncertainty],
    },
    { nowMs },
  );

  const assistantContent = await deps.answerer.answer(input.query.text, assemble.pack);
  const elapsedMs = Math.max(0, nowMs() - start);
  return { pack: assemble.pack, assistantContent, elapsedMs, plan };
}

// Re-export DEFAULT_SEARCH_LIMITS for parity with #179 callers that import limits via the
// orchestrator. Keeps `grounded-qa.ts` from needing a second workspace import path.
export { DEFAULT_SEARCH_LIMITS };
