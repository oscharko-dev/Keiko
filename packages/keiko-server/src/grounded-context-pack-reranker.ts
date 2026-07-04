import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts";
import type { CandidateFile, EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";
import type { RerankResult } from "@oscharko-dev/keiko-model-gateway";
import type { RerankerSeam } from "@oscharko-dev/keiko-workflows";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig } from "./deps.js";
import { requestConfiguredRerank } from "./grounded-model-reranker.js";

const MAX_ATOMS_PER_CANDIDATE = 6;
const MAX_CANDIDATE_DOCUMENT_CHARS = 2_000;

function redactText(deps: UiHandlerDeps, value: string): string {
  const safe = stripUnsafeFormatChars(value);
  const redacted = deps.redactor(safe);
  return typeof redacted === "string" ? redacted : safe;
}

function lineRange(atom: EvidenceAtom): string {
  return atom.lineRange === undefined
    ? "whole-file"
    : `${String(atom.lineRange.startLine)}-${String(atom.lineRange.endLine)}`;
}

function atomLine(atom: EvidenceAtom): string {
  const edge = atom.edge === undefined ? "" : ` edge=${atom.edge.kind}`;
  return [
    `- ${atom.provenance.kind}`,
    `tool=${atom.provenance.tool}`,
    `score=${atom.score.toFixed(3)}`,
    `lines=${lineRange(atom)}`,
    edge,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

function candidateDocument(
  deps: UiHandlerDeps,
  candidate: CandidateFile,
  atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>,
): string {
  const atoms = atomsByPath.get(candidate.scopePath)?.slice(0, MAX_ATOMS_PER_CANDIDATE) ?? [];
  const lines = [
    `Path: ${candidate.scopePath}`,
    `Candidate score: ${candidate.score.toFixed(3)}`,
    `Signals: ${candidate.signals
      .map((signal) => `${signal.name}=${String(signal.value)}`)
      .join(", ")}`,
    "Evidence atoms:",
    ...(atoms.length === 0 ? ["- none"] : atoms.map(atomLine)),
  ];
  return redactText(deps, lines.join("\n")).slice(0, MAX_CANDIDATE_DOCUMENT_CHARS);
}

function withRerankerSignal(candidate: CandidateFile, result: RerankResult): CandidateFile {
  if (result.relevanceScore === undefined) {
    return candidate;
  }
  return {
    ...candidate,
    score: result.relevanceScore,
    signals: [{ name: "model-rerank", value: result.relevanceScore }, ...candidate.signals],
  };
}

function applyResults(
  candidates: readonly CandidateFile[],
  results: readonly RerankResult[],
  topK: number,
): readonly CandidateFile[] | undefined {
  const used = new Set<number>();
  const reordered: CandidateFile[] = [];
  for (const result of results) {
    if (!Number.isInteger(result.index) || result.index < 0 || result.index >= candidates.length) {
      return undefined;
    }
    if (used.has(result.index)) {
      return undefined;
    }
    const candidate = candidates[result.index];
    if (candidate === undefined) {
      return undefined;
    }
    used.add(result.index);
    reordered.push(withRerankerSignal(candidate, result));
  }
  return reordered.slice(0, topK);
}

export function configuredContextPackRerankerFor(
  deps: UiHandlerDeps,
  query: RetrievalQuery,
  signal: AbortSignal | undefined,
): RerankerSeam | undefined {
  const reranker = currentGatewayConfig(deps)?.reranker;
  if (reranker === undefined) {
    return undefined;
  }
  return {
    name: "configured-model-reranker",
    isAvailable: () => Promise.resolve({ available: true, modelLabel: reranker.modelId }),
    rerank: async (candidates, atomsByPath, topK): Promise<readonly CandidateFile[]> => {
      const attempt = await requestConfiguredRerank({
        deps,
        query: query.text,
        documents: candidates.map((candidate) => candidateDocument(deps, candidate, atomsByPath)),
        topN: topK,
        signal,
      });
      if (attempt.outcome === undefined) {
        return candidates;
      }
      return applyResults(candidates, attempt.outcome.value.results, topK) ?? candidates;
    },
  };
}
