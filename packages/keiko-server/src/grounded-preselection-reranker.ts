import type {
  CandidateFile,
  EvidenceAtom,
  ExplorationBudget,
  ExplorationUsage,
  ContextRerankerDisposition,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { GroundedRerankerDiagnostics } from "@oscharko-dev/keiko-contracts/bff-wire";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import type { RerankerSeam } from "@oscharko-dev/keiko-workflows";
import { AbortDeadlineRaceError, raceAbortDeadline } from "./abort-race.js";

export interface PreselectionRerankerInput {
  readonly reranker?: RerankerSeam | undefined;
  readonly candidates: readonly CandidateFile[];
  readonly atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>;
  readonly budget: ExplorationBudget;
  readonly usage: ExplorationUsage;
  readonly nowMs: () => number;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly literal: boolean;
}

export interface PreselectionRerankerResult {
  readonly candidates: readonly CandidateFile[];
  readonly usage: ExplorationUsage;
  readonly rerankerDisposition: ContextRerankerDisposition;
  readonly reranked: boolean;
  readonly rerankFailedCalls: number;
  readonly diagnostics?: GroundedRerankerDiagnostics | undefined;
  readonly failure?: unknown;
}

const RERANK_DOCUMENT_CAP = 64;

function skippedDisposition(input: PreselectionRerankerInput): ContextRerankerDisposition {
  if (input.literal) return "skipped-literal";
  if (input.reranker === undefined) return "unconfigured";
  return "skipped-budget";
}

function canRerank(input: PreselectionRerankerInput): boolean {
  return (
    !input.literal &&
    input.reranker !== undefined &&
    input.candidates.length > 0 &&
    input.usage.rerankCalls < input.budget.rerankCallsMax &&
    input.nowMs() < input.deadlineAtMs
  );
}

function validResult(
  result: readonly CandidateFile[],
  originals: readonly CandidateFile[],
): boolean {
  const paths = new Set(originals.map((candidate) => candidate.scopePath));
  const seen = new Set<string>();
  return (
    result.length > 0 &&
    result.every((candidate) => {
      if (!paths.has(candidate.scopePath) || seen.has(candidate.scopePath)) return false;
      seen.add(candidate.scopePath);
      return Number.isFinite(candidate.score) && candidate.score >= 0 && candidate.score <= 1;
    })
  );
}

async function rerankedBatch(
  input: PreselectionRerankerInput,
  reranker: RerankerSeam,
  onAttempt: () => void,
): Promise<readonly CandidateFile[] | undefined> {
  const options = {
    deadlineAtMs: input.deadlineAtMs,
    nowMs: input.nowMs,
    signal: input.signal,
  };
  const available = await raceAbortDeadline((context) => reranker.isAvailable(context), options);
  if (!available.available || input.nowMs() >= input.deadlineAtMs) return undefined;
  const batch = input.candidates.slice(0, RERANK_DOCUMENT_CAP);
  return raceAbortDeadline((context) => {
    onAttempt();
    return reranker.rerank(batch, input.atomsByPath, batch.length, context);
  }, options);
}

function finishResult(
  input: PreselectionRerankerInput,
  startMs: number,
  attempted: boolean,
  disposition: ContextRerankerDisposition,
  candidates: readonly CandidateFile[],
  failure?: unknown,
): PreselectionRerankerResult {
  const diagnostics = input.reranker?.getDiagnostics?.();
  return {
    candidates,
    usage: {
      ...input.usage,
      rerankCalls: input.usage.rerankCalls + Number(attempted),
      elapsedMs: input.usage.elapsedMs + Math.max(0, input.nowMs() - startMs),
    },
    rerankerDisposition: disposition,
    reranked: disposition === "applied",
    rerankFailedCalls: disposition === "failed" ? Number(attempted) : 0,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(failure === undefined ? {} : { failure }),
  };
}

export async function rerankGroundedCandidates(
  input: PreselectionRerankerInput,
): Promise<PreselectionRerankerResult> {
  const startMs = input.nowMs();
  if (input.signal?.aborted === true) throw new CancelledError("grounded request cancelled");
  if (!canRerank(input) || input.reranker === undefined)
    return finishResult(input, startMs, false, skippedDisposition(input), input.candidates);
  let attempted = false;
  try {
    const batch = await rerankedBatch(input, input.reranker, (): void => {
      attempted = true;
    });
    if (batch === undefined)
      return finishResult(input, startMs, attempted, "unconfigured", input.candidates);
    const diagnostics = input.reranker.getDiagnostics?.();
    if (
      !validResult(batch, input.candidates.slice(0, RERANK_DOCUMENT_CAP)) ||
      (diagnostics !== undefined && diagnostics.status !== "applied")
    )
      return finishResult(input, startMs, attempted, "failed", input.candidates);
    const paths = new Set(batch.map((candidate) => candidate.scopePath));
    const candidates = [
      ...batch,
      ...input.candidates.filter((entry) => !paths.has(entry.scopePath)),
    ];
    return finishResult(input, startMs, attempted, "applied", candidates);
  } catch (error) {
    if (error instanceof AbortDeadlineRaceError && error.reason === "aborted")
      throw new CancelledError("grounded request cancelled");
    const disposition = error instanceof AbortDeadlineRaceError ? "skipped-budget" : "failed";
    return finishResult(input, startMs, attempted, disposition, input.candidates, error);
  }
}
