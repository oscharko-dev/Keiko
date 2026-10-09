import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import {
  DEFAULT_EXPLORATION_BUDGET,
  type CandidateFile,
  type EvidenceAtom,
  type RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { RerankResult } from "@oscharko-dev/keiko-model-gateway";
import type { GroundedRerankerDiagnostics } from "@oscharko-dev/keiko-contracts/bff-wire";
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

interface CandidateBatchInput {
  readonly deps: UiHandlerDeps;
  readonly modelId: string;
  readonly query: string;
  readonly candidates: readonly CandidateFile[];
  readonly atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>;
  readonly topK: number;
  readonly byteBudget: number;
}

function candidateBatch(input: CandidateBatchInput): ReadonlyMap<CandidateFile, string> {
  const documents = new Map<CandidateFile, string>();
  if (!Number.isSafeInteger(input.byteBudget) || input.byteBudget < 0) return documents;
  let bytes = Buffer.byteLength(
    JSON.stringify({
      model: input.modelId,
      query: input.query,
      documents: [],
      top_n: Math.min(input.topK, input.candidates.length),
    }),
    "utf8",
  );
  for (const candidate of input.candidates) {
    const document = candidateDocument(input.deps, candidate, input.atomsByPath);
    const added = Buffer.byteLength(JSON.stringify(document), "utf8") + Number(documents.size > 0);
    if (bytes + added > input.byteBudget) break;
    documents.set(candidate, document);
    bytes += added;
  }
  return documents;
}

export function configuredContextPackRerankerFor(
  deps: UiHandlerDeps,
  query: RetrievalQuery,
  signal: AbortSignal | undefined,
  byteBudget = DEFAULT_EXPLORATION_BUDGET.excerptBytesMax,
): RerankerSeam | undefined {
  const gatewayConfig = currentGatewayConfig(deps);
  const reranker = gatewayConfig?.reranker;
  if (reranker === undefined) {
    return undefined;
  }
  let diagnostics: GroundedRerankerDiagnostics | undefined;
  return {
    name: "configured-model-reranker",
    getDiagnostics: (): GroundedRerankerDiagnostics | undefined => diagnostics,
    isAvailable: () => Promise.resolve({ available: true, modelLabel: reranker.modelId }),
    rerank: async (candidates, atomsByPath, topK, context): Promise<readonly CandidateFile[]> => {
      diagnostics = undefined;
      const requestSignal = executionSignal(signal, context);
      const batch = candidateBatch({
        deps,
        modelId: reranker.modelId,
        query: query.text,
        candidates,
        atomsByPath,
        topK,
        byteBudget,
      });
      const result = await rerankSelection({
        deps,
        gatewayConfig,
        query: query.text,
        candidates,
        providerCandidates: [...batch.keys()],
        preserveUnsubmittedCandidates: true,
        documentFor: (candidate) => batch.get(candidate) ?? "",
        topN: Math.min(topK, batch.size),
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
        ...(context?.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
        applyScore: withRerankerSignal,
        fallbackMode: "identity",
      });
      diagnostics = result.diagnostics;
      return result.selected;
    },
  };
}
