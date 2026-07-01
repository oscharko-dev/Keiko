// Grounded-answer runner (Epic #189, Issue #200). The single entry point the
// Conversation Center BFF will call: question text + capsule scope ⇒ structured answer
// with attached citations, ready to persist to the chat row and the audit ledger.
//
// Composition (all dependencies UNCHANGED from #199):
//   1. `runLocalKnowledgeRetrieval` resolves scope + policy and produces ranked refs.
//   2. `assembleGroundedContext` projects the refs into a `LocalKnowledgeGroundedContextPack`.
//   3. The injected `AnswerGenerator` turns the pack into an answer string. The runner
//      passes through the AbortSignal so cancellation reaches the model call.
//   4. `attachCitationsToAnswer` scans the answer for `[n]` markers and pairs them with
//      the original reference array.
//
// No-evidence short-circuit: if retrieval returns `noEvidence: true` the runner returns
// immediately WITHOUT invoking the generator. The audit ledger / UI surfaces the
// `reason` so the user sees an honest "we found nothing" message rather than a
// hallucinated answer.
//
// This module owns NO new business logic — it is wiring. Every behaviour invariant
// (scope resolution, embedding identity check, strictest-policy floor, answer-grounding
// rejection) is enforced by the underlying retrieval layer; the runner merely composes.

import { assembleGroundedContext } from "../retrieval/context-pack-assembler.js";
import { runLocalKnowledgeRetrieval } from "../retrieval/retrieval-runner.js";
import type { RetrievalDependencies } from "../retrieval/retrieval-runner.js";

import {
  attachCitationsToAnswer,
  type AttachCitationsResult,
  type CitationFaithfulnessOptions,
} from "./citation-attacher.js";
import type {
  AnswerGenerator,
  ConversationGroundedAnswer,
  ConversationGroundedQuery,
  ReferenceReranker,
} from "./types.js";

export interface GroundedAnswerDependencies {
  readonly retrieval: RetrievalDependencies;
  readonly answerGenerator: AnswerGenerator;
  readonly referenceReranker?: ReferenceReranker | undefined;
  readonly citationFaithfulness?: CitationFaithfulnessOptions | undefined;
  // Caller-supplied cancellation. Propagates to both retrieval (the embedding call) and
  // the answer generator (the model call) so a single abort cancels the whole pipeline.
  readonly signal?: AbortSignal;
}

const NO_EVIDENCE_REPAIR_SKIP_PATTERNS: readonly RegExp[] = [
  /\bno\s+evidence\s+(?:found|available|in|within)\b/iu,
  /\binsufficient\s+evidence\b/iu,
  /\bnot\s+enough\s+evidence\b/iu,
  /\bkeine\s+evidenz\b/iu,
  /\bkeine\s+(?:belege|hinweise)\b/iu,
  /\bnicht\s+genug\s+(?:evidenz|belege|hinweise)\b/iu,
];

function shouldRepairMissingCitations(
  answerText: string,
  references: readonly unknown[],
  attached: AttachCitationsResult,
): boolean {
  if (references.length === 0 || attached.citations.length > 0) return false;
  const compact = answerText.replace(/\s+/g, " ").trim();
  if (compact.length === 0 || compact.length > 240) return true;
  return !NO_EVIDENCE_REPAIR_SKIP_PATTERNS.some((pattern) => pattern.test(compact));
}

// eslint-disable-next-line max-lines-per-function, complexity
export async function runGroundedAnswer(
  deps: GroundedAnswerDependencies,
  query: ConversationGroundedQuery,
): Promise<ConversationGroundedAnswer> {
  const retrieval = await runLocalKnowledgeRetrieval(
    {
      store: deps.retrieval.store,
      embeddingAdapter: deps.retrieval.embeddingAdapter,
      ...(deps.retrieval.queryTransformer !== undefined
        ? { queryTransformer: deps.retrieval.queryTransformer }
        : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    },
    {
      text: query.text,
      ...(query.capsuleId !== undefined ? { capsuleId: query.capsuleId } : {}),
      ...(query.capsuleSetId !== undefined ? { capsuleSetId: query.capsuleSetId } : {}),
      ...(query.topK !== undefined ? { topK: query.topK } : {}),
      ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
      ...(query.strategy !== undefined ? { strategy: query.strategy } : {}),
    },
  );

  if (retrieval.noEvidence) {
    const pack = assembleGroundedContext(retrieval.references);
    return {
      answer: "",
      references: retrieval.references,
      citations: [],
      pack,
      noEvidence: true,
      ...(retrieval.reason !== undefined ? { reason: retrieval.reason } : {}),
    };
  }

  const reranked =
    deps.referenceReranker === undefined
      ? undefined
      : await deps.referenceReranker.rerank({
          query,
          references: retrieval.references,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        });
  const references = reranked?.references ?? retrieval.references;
  const pack = assembleGroundedContext(references);
  const answerInput = {
    query,
    pack,
    references,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  };
  const answerText = await deps.answerGenerator.generate(answerInput);

  let attached = attachCitationsToAnswer(answerText, references, deps.citationFaithfulness);
  if (
    deps.signal?.aborted !== true &&
    shouldRepairMissingCitations(answerText, references, attached)
  ) {
    const repairedText = await deps.answerGenerator.generate({
      ...answerInput,
      citationRepair: true,
    });
    attached = attachCitationsToAnswer(repairedText, references, deps.citationFaithfulness);
  }
  return {
    answer: attached.text,
    references,
    citations: attached.citations,
    pack,
    noEvidence: false,
    ...(reranked?.diagnostics === undefined ? {} : { reranker: reranked.diagnostics }),
  };
}
