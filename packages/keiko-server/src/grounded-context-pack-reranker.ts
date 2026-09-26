import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import type {
  CandidateFile,
  EvidenceAtom,
  RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { RerankResult } from "@oscharko-dev/keiko-model-gateway";
import type { RerankerExecutionContext, RerankerSeam } from "@oscharko-dev/keiko-workflows";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig } from "./deps.js";
import { rerankSelection } from "./grounded-rerank-facade.js";

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

function executionSignal(
  configuredSignal: AbortSignal | undefined,
  context: RerankerExecutionContext | undefined,
): AbortSignal | undefined {
  return context?.signal ?? configuredSignal;
}

export function configuredContextPackRerankerFor(
  deps: UiHandlerDeps,
  query: RetrievalQuery,
  signal: AbortSignal | undefined,
): RerankerSeam | undefined {
  const gatewayConfig = currentGatewayConfig(deps);
  const reranker = gatewayConfig?.reranker;
  if (reranker === undefined) {
    return undefined;
  }
  return {
    name: "configured-model-reranker",
    isAvailable: () => Promise.resolve({ available: true, modelLabel: reranker.modelId }),
    rerank: async (candidates, atomsByPath, topK, context): Promise<readonly CandidateFile[]> => {
      const requestSignal = executionSignal(signal, context);
      const result = await rerankSelection({
        deps,
        gatewayConfig,
        query: query.text,
        candidates,
        documentFor: (candidate) => candidateDocument(deps, candidate, atomsByPath),
        topN: topK,
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
        ...(context?.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
        applyScore: withRerankerSignal,
        fallbackMode: "identity",
      });
      return result.selected;
    },
  };
}
