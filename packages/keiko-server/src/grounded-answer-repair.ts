import type { CitationRepairDisposition } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import type { OrchestratorDeps } from "./grounded-orchestrator.js";
import { normalizeGroundedAnswerPayload, type GroundedAnswerResult } from "./grounded-answer.js";
import {
  buildPackCitationIndex,
  parseInlineCitations,
  reconcileInlineCitations,
} from "./grounded-faithfulness.js";
import { validateCitationRepair } from "./grounded-citation-repair.js";

export interface GroundedRepairContext {
  readonly question: string;
  readonly pack: ConnectedContextPack;
  readonly answer: GroundedAnswerResult;
  readonly deps: Pick<
    OrchestratorDeps,
    "answerer" | "signal" | "reliableCitationBehaviour" | "observeCitationBehaviour"
  >;
  readonly nowMs: () => number;
  readonly deadlineAtMs?: number | undefined;
}
export interface GroundedRepairResult {
  readonly answer: GroundedAnswerResult;
  readonly disposition: CitationRepairDisposition;
  readonly failure?: unknown;
}

function repairDisposition(ctx: GroundedRepairContext): CitationRepairDisposition | undefined {
  const answer = ctx.answer;
  if (
    answer.answerKind !== "answer" ||
    answer.modelInvoked === false ||
    (answer.filesInPrompt ?? 0) === 0
  )
    return "not-needed";
  if (parseInlineCitations(answer.content).length > 0) return "not-needed";
  if (ctx.deps.reliableCitationBehaviour === "cites" || ctx.deps.answerer.repair === undefined)
    return "skipped-capability";
  if (repairBudgetExhausted(ctx)) return "skipped-budget";
  return undefined;
}

function repairBudgetExhausted(ctx: GroundedRepairContext): boolean {
  return (
    (ctx.deadlineAtMs !== undefined && ctx.nowMs() >= ctx.deadlineAtMs) ||
    ctx.pack.budget.modelInputTokensMax <= ctx.answer.usage.promptTokens ||
    ctx.pack.budget.modelOutputTokensMax <= ctx.answer.usage.completionTokens
  );
}

function combinedRepairAnswer(
  ctx: GroundedRepairContext,
  repaired: GroundedAnswerResult,
): GroundedRepairResult {
  const index = buildPackCitationIndex(ctx.answer.sentEvidencePacks ?? [ctx.pack]);
  const accepted =
    repaired.modelInvoked !== false &&
    validateCitationRepair(ctx.answer.content, repaired.content, index);
  return {
    disposition: accepted ? "applied" : "rejected-content-changed",
    answer: {
      ...ctx.answer,
      ...(accepted
        ? { content: repaired.content, citationBehaviour: "cites-after-repair" as const }
        : {}),
      usage: {
        promptTokens: ctx.answer.usage.promptTokens + repaired.usage.promptTokens,
        completionTokens: ctx.answer.usage.completionTokens + repaired.usage.completionTokens,
      },
    },
  };
}

export async function repairGroundedAnswer(
  ctx: GroundedRepairContext,
): Promise<GroundedRepairResult> {
  const disposition = repairDisposition(ctx);
  if (disposition !== undefined) return { answer: ctx.answer, disposition };
  const repair = ctx.deps.answerer.repair?.bind(ctx.deps.answerer);
  if (repair === undefined) return { answer: ctx.answer, disposition: "skipped-capability" };
  try {
    const repaired = normalizeGroundedAnswerPayload(
      await repair(
        ctx.question,
        ctx.answer.sentEvidencePacks?.[0] ?? ctx.pack,
        ctx.answer.content,
        {
          modelInputTokensMax: ctx.pack.budget.modelInputTokensMax - ctx.answer.usage.promptTokens,
          modelOutputTokensMax:
            ctx.pack.budget.modelOutputTokensMax - ctx.answer.usage.completionTokens,
          signal: ctx.deps.signal,
          deadlineAtMs: ctx.deadlineAtMs,
        },
      ),
    );
    return combinedRepairAnswer(ctx, repaired);
  } catch (failure) {
    if (ctx.deps.signal?.aborted === true) throw failure;
    return { answer: ctx.answer, disposition: "failed", failure };
  }
}

export function observeGroundedCitationBehaviour(ctx: GroundedRepairContext): GroundedAnswerResult {
  if (
    ctx.answer.answerKind !== "answer" ||
    ctx.answer.modelInvoked === false ||
    (ctx.answer.filesInPrompt ?? 0) === 0
  )
    return ctx.answer;
  const reconciliation = reconcileInlineCitations(
    ctx.answer.content,
    buildPackCitationIndex(ctx.answer.sentEvidencePacks ?? [ctx.pack]),
  );
  const behaviour =
    ctx.answer.citationBehaviour ?? (reconciliation.citedScopePaths.size > 0 ? "cites" : "never");
  ctx.deps.observeCitationBehaviour?.(behaviour);
  return { ...ctx.answer, citationBehaviour: behaviour };
}
