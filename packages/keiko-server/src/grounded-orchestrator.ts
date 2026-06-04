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
  RetrievalQuery,
  SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  assembleContextPack,
  planExploration,
  rankCandidates,
  type ClarificationPrompt,
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
}

export interface OrchestratorDeps {
  readonly answerer: GroundedAnswerer;
  readonly nowMs?: () => number;
  // Optional injected port for tests; production uses the realpath-contained node adapter.
  readonly fs?: WorkspaceFs;
  // Optional injected detector for tests so memFs fixtures don't need full WorkspaceInfo wiring.
  readonly detectWorkspace?: (root: string, fs: WorkspaceFs) => WorkspaceInfo;
}

export interface OrchestratorOutput {
  readonly pack: ConnectedContextPack;
  readonly assistantContent: string;
  readonly elapsedMs: number;
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
}

async function runRing(
  ring: RetrievalRing,
  inputs: SearchInputs,
): Promise<readonly EvidenceAtom[]> {
  if (ring.kind === "lexical") {
    const result = await searchText(inputs.searchScope, inputs.query, ring.searchLimits, {
      fs: inputs.fs,
    });
    return result.atoms;
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
  );
  return result.atoms;
}

async function runAllRings(
  rings: readonly RetrievalRing[],
  inputs: SearchInputs,
): Promise<readonly EvidenceAtom[]> {
  const atoms: EvidenceAtom[] = [];
  for (const ring of rings) {
    const ringAtoms = await runRing(ring, inputs);
    atoms.push(...ringAtoms);
  }
  return atoms;
}

interface ExcerptInputs {
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
}

async function readKeptExcerpts(
  keptPaths: readonly string[],
  inputs: ExcerptInputs,
): Promise<ReadonlyMap<string, string>> {
  const excerpts = new Map<string, string>();
  for (const scopePath of keptPaths) {
    try {
      const result = await readExcerpt(
        inputs.searchScope,
        { scopePath, startLine: 1, endLine: 200, maxBytes: 8192 },
        { fs: inputs.fs },
      );
      excerpts.set(scopePath, result.content);
    } catch (error) {
      if (error instanceof RepoSearchUnsupportedFileError) {
        continue;
      }
      throw error;
    }
  }
  return excerpts;
}

function buildSearchScope(scope: SelectedScope, workspace: WorkspaceInfo): SearchScope {
  return {
    workspace,
    scopeId: scope.scopeId,
    relativePaths: scope.relativePaths,
  };
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

  const plan = planExploration({ scope: input.scope, query: input.query }, { nowMs });
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

  const workspace = detect(input.workspaceRoot, fs);
  const searchScope = buildSearchScope(input.scope, workspace);
  const atoms = await runAllRings(plan.rings, { searchScope, query: input.query, fs });

  const ranking = rankCandidates({ atoms, anchors: plan.anchors }, { nowMs });

  const excerpts = await readKeptExcerpts(
    ranking.kept.map((c) => c.scopePath),
    { searchScope, fs },
  );

  const assemble = await assembleContextPack(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms,
      ranked: ranking.kept,
      omittedFromRanking: ranking.omitted,
      excerpts,
    },
    { nowMs },
  );

  const assistantContent = await deps.answerer.answer(input.query.text, assemble.pack);
  const elapsedMs = Math.max(0, nowMs() - start);
  return { pack: assemble.pack, assistantContent, elapsedMs };
}

// Re-export DEFAULT_SEARCH_LIMITS for parity with #179 callers that import limits via the
// orchestrator. Keeps `grounded-qa.ts` from needing a second workspace import path.
export { DEFAULT_SEARCH_LIMITS };
