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

import type { RetrievalReference } from "@oscharko-dev/keiko-contracts";
import type { GroundedRerankerDiagnostics } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  hasOwnAssessmentTag,
  splitOwnAssessment,
  withoutOwnAssessmentTags,
} from "@oscharko-dev/keiko-contracts/runtime/grounded-assessment";
import { isNoEvidenceAnswerText } from "@oscharko-dev/keiko-contracts/runtime/no-evidence-answer";

import {
  assembleGroundedContext,
  type LocalKnowledgeGroundedContextPack,
} from "../retrieval/context-pack-assembler.js";
import { runLocalKnowledgeRetrieval } from "../retrieval/retrieval-runner.js";
import type { RetrievalDependencies } from "../retrieval/retrieval-runner.js";
import type { RetrievalQuery, RetrievalResult } from "../retrieval/types.js";

import {
  attachCitationsToAnswer,
  type AttachCitationsResult,
  type CitationFaithfulnessOptions,
} from "./citation-attacher.js";
import type {
  AnswerGenerator,
  AnswerGeneratorInput,
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

// A refusal ("nothing about this in the documents") makes no source-backed claim, so a missing
// citation on it is not a defect and a citation-repair model call would be wasted on it. The
// detector is the one shared with the BFF's answer enforcement (keiko-contracts).
// Keiko's assessment alone, with an empty source-backed part, claims nothing from the sources
// either; an empty answer without one is still repaired (KEIKO-0275).
function shouldRepairMissingCitations(
  generated: GeneratedAnswer,
  references: readonly unknown[],
): boolean {
  const { attached } = generated;
  if (references.length === 0 || attached.citations.length > 0) return false;
  if (generated.ownAssessment !== undefined && attached.text.trim().length === 0) return false;
  return !isNoEvidenceAnswerText(attached.text);
}

// The model's answer, split by the policy: an allowed assessment leaves the source-backed part;
// a disabled one keeps its words as source-backed text, tags dropped.
interface GeneratedAnswer {
  readonly attached: AttachCitationsResult;
  readonly ownAssessment?: string;
  readonly neutralized: boolean;
}

function splitGeneratedAnswer(
  text: string,
  query: ConversationGroundedQuery,
): { readonly grounded: string; readonly ownAssessment?: string; readonly neutralized: boolean } {
  if (query.ownAssessment !== "allowed") {
    return { grounded: withoutOwnAssessmentTags(text), neutralized: hasOwnAssessmentTag(text) };
  }
  const { grounded, assessment } = splitOwnAssessment(text);
  return assessment === undefined
    ? { grounded, neutralized: false }
    : { grounded, ownAssessment: assessment, neutralized: false };
}

function attachGenerated(
  deps: GroundedAnswerDependencies,
  answerInput: AnswerGeneratorInput,
  text: string,
): GeneratedAnswer {
  const split = splitGeneratedAnswer(text, answerInput.query);
  const attached = attachCitationsToAnswer(
    split.grounded,
    promptReferencesOf(deps, answerInput.references),
    deps.citationFaithfulness,
  );
  return split.ownAssessment === undefined
    ? { attached, neutralized: split.neutralized }
    : { attached, ownAssessment: split.ownAssessment, neutralized: split.neutralized };
}

// ─── Retrieval wiring ─────────────────────────────────────────────────────────
function buildRetrievalDependencies(deps: GroundedAnswerDependencies): RetrievalDependencies {
  return {
    store: deps.retrieval.store,
    embeddingAdapter: deps.retrieval.embeddingAdapter,
    ...(deps.retrieval.queryTransformer !== undefined
      ? { queryTransformer: deps.retrieval.queryTransformer }
      : {}),
    ...(deps.retrieval.vectorIndex !== undefined
      ? { vectorIndex: deps.retrieval.vectorIndex }
      : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  };
}

function buildRetrievalQuery(query: ConversationGroundedQuery): RetrievalQuery {
  return {
    text: query.text,
    ...(query.capsuleId !== undefined ? { capsuleId: query.capsuleId } : {}),
    ...(query.capsuleSetId !== undefined ? { capsuleSetId: query.capsuleSetId } : {}),
    ...(query.topK !== undefined ? { topK: query.topK } : {}),
    ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
    ...(query.strategy !== undefined ? { strategy: query.strategy } : {}),
  };
}

// ─── No-evidence short-circuit ────────────────────────────────────────────────
function buildNoEvidenceAnswer(
  retrieval: RetrievalResult,
  pack: LocalKnowledgeGroundedContextPack,
): ConversationGroundedAnswer {
  return {
    answer: "",
    references: retrieval.references,
    citations: [],
    pack,
    noEvidence: true,
    ...(retrieval.reason !== undefined ? { reason: retrieval.reason } : {}),
    ...(retrieval.diagnostics !== undefined ? { retrievalDiagnostics: retrieval.diagnostics } : {}),
    ...(retrieval.embeddingDegraded === true ? { embeddingDegraded: true as const } : {}),
  };
}

// ─── Optional pre-answer reranking ────────────────────────────────────────────
interface RerankOutcome {
  readonly references: readonly RetrievalReference[];
  readonly diagnostics: GroundedRerankerDiagnostics | undefined;
}

async function rerankReferences(
  deps: GroundedAnswerDependencies,
  query: ConversationGroundedQuery,
  retrieval: RetrievalResult,
): Promise<RerankOutcome> {
  if (deps.referenceReranker === undefined) {
    return { references: retrieval.references, diagnostics: undefined };
  }
  const reranked = await deps.referenceReranker.rerank({
    query,
    references: retrieval.references,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  return { references: reranked.references, diagnostics: reranked.diagnostics };
}

// ─── Answer generation + citation-repair retry ────────────────────────────────
async function generateGroundedAnswerText(
  deps: GroundedAnswerDependencies,
  answerInput: AnswerGeneratorInput,
): Promise<GeneratedAnswer> {
  const generated = attachGenerated(
    deps,
    answerInput,
    await deps.answerGenerator.generate(answerInput),
  );
  const sent = promptReferencesOf(deps, answerInput.references);
  if (deps.signal?.aborted === true || !shouldRepairMissingCitations(generated, sent)) {
    return generated;
  }
  const repairedText = await deps.answerGenerator.generate({
    ...answerInput,
    citationRepair: true,
  });
  return attachGenerated(deps, answerInput, repairedText);
}

// Citations resolve only against the evidence the model was shown: a window-fitted prompt keeps
// the highest-ranked references under their original numbers, so the rest are out of range.
function promptReferencesOf(
  deps: GroundedAnswerDependencies,
  references: readonly RetrievalReference[],
): readonly RetrievalReference[] {
  return deps.answerGenerator.promptReferences?.() ?? references;
}

// ─── Final answer assembly ─────────────────────────────────────────────────────
function buildGroundedAnswer(
  generated: GeneratedAnswer,
  references: readonly RetrievalReference[],
  pack: LocalKnowledgeGroundedContextPack,
  retrieval: RetrievalResult,
  rerankerDiagnostics: GroundedRerankerDiagnostics | undefined,
): ConversationGroundedAnswer {
  const { attached } = generated;
  return {
    answer: attached.text,
    ...(generated.ownAssessment === undefined ? {} : { ownAssessment: generated.ownAssessment }),
    ...(generated.neutralized ? { ownAssessmentNeutralized: true as const } : {}),
    references,
    citations: attached.citations,
    pack,
    noEvidence: false,
    ...(attached.weakOverlapCount > 0 ? { weakCitationCount: attached.weakOverlapCount } : {}),
    ...(rerankerDiagnostics === undefined ? {} : { reranker: rerankerDiagnostics }),
    ...(retrieval.diagnostics !== undefined ? { retrievalDiagnostics: retrieval.diagnostics } : {}),
    ...(retrieval.embeddingDegraded === true ? { embeddingDegraded: true as const } : {}),
  };
}

export async function runGroundedAnswer(
  deps: GroundedAnswerDependencies,
  query: ConversationGroundedQuery,
): Promise<ConversationGroundedAnswer> {
  const retrieval = await runLocalKnowledgeRetrieval(
    buildRetrievalDependencies(deps),
    buildRetrievalQuery(query),
  );

  // Without evidence the model is asked only when something else may answer: governed personal
  // context, or Keiko's own labelled assessment.
  const answerOnlyContext = query.answerOnlyContextAvailable === true;
  if (retrieval.noEvidence && !answerOnlyContext && query.ownAssessment !== "allowed") {
    return buildNoEvidenceAnswer(retrieval, assembleGroundedContext(retrieval.references));
  }

  const answerOnly = retrieval.noEvidence;
  const { references, diagnostics: rerankerDiagnostics } = answerOnly
    ? { references: [] as readonly RetrievalReference[], diagnostics: undefined }
    : await rerankReferences(deps, query, retrieval);
  const pack = assembleGroundedContext(references);
  const answerInput: AnswerGeneratorInput = {
    query,
    pack,
    references,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  };

  const generated = await generateGroundedAnswerText(deps, answerInput);
  const built = buildGroundedAnswer(generated, references, pack, retrieval, rerankerDiagnostics);
  const sentCount = promptReferencesOf(deps, references).length;
  const answer =
    sentCount < references.length ? { ...built, promptReferenceCount: sentCount } : built;
  if (!answerOnly) return answer;
  return answerOnlyContext
    ? { ...answer, noEvidence: true, answerOnlyContextUsed: true }
    : {
        ...answer,
        noEvidence: true,
        ...(retrieval.reason === undefined ? {} : { reason: retrieval.reason }),
      };
}
