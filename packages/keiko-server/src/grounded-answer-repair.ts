import { findCitationMarkerGroups } from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import type { CitationRepairDisposition } from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  ConnectedContextPack,
  ExplorationBudget,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type {
  GroundedAnswerer,
  GroundedAnswerOptions,
  OrchestratorDeps,
} from "./grounded-orchestrator.js";
import {
  normalizeGroundedAnswerPayload,
  type GroundedAnswerPayload,
  type GroundedAnswerResult,
} from "./grounded-answer.js";
import {
  buildPackCitationIndex,
  parseInlineCitations,
  reconcileInlineCitations,
  reconcileNumericCitations,
} from "./grounded-faithfulness.js";
import { validateCitationRepair } from "./grounded-citation-repair.js";

export interface GroundedRepairContext {
  readonly numericMarkers?: ReadonlySet<number> | undefined;
  readonly question: string;
  readonly pack?: ConnectedContextPack | undefined;
  readonly budget?: ExplorationBudget | undefined;
  readonly invokeRepair?:
    | ((original: string, options: GroundedAnswerOptions) => Promise<GroundedAnswerPayload>)
    | undefined;
  readonly answer: GroundedAnswerResult;
  readonly deps: Pick<
    OrchestratorDeps,
    "signal" | "reliableCitationBehaviour" | "observeCitationBehaviour"
  > & { readonly answerer?: GroundedAnswerer | undefined };
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
    ((answer.filesInPrompt ?? 0) === 0 && (ctx.numericMarkers?.size ?? 0) === 0)
  )
    return "not-needed";
  if (hasParsedRepairCitations(ctx)) return "not-needed";
  if (ctx.deps.reliableCitationBehaviour === "cites" || repairInvoker(ctx) === undefined)
    return "skipped-capability";
  if (repairBudgetExhausted(ctx)) return "skipped-budget";
  return undefined;
}

function hasParsedRepairCitations(ctx: GroundedRepairContext): boolean {
  return (
    parseInlineCitations(ctx.answer.content).length > 0 ||
    (ctx.numericMarkers !== undefined && findCitationMarkerGroups(ctx.answer.content).length > 0)
  );
}

function repairBudgetExhausted(ctx: GroundedRepairContext): boolean {
  const budget = ctx.budget ?? ctx.pack?.budget;
  return (
    budget === undefined ||
    (ctx.deadlineAtMs !== undefined && ctx.nowMs() >= ctx.deadlineAtMs) ||
    budget.modelInputTokensMax <=
      (ctx.pack?.usage.modelInputTokens ?? 0) + ctx.answer.usage.promptTokens ||
    budget.modelOutputTokensMax <=
      (ctx.pack?.usage.modelOutputTokens ?? 0) + ctx.answer.usage.completionTokens
  );
}

function combinedRepairAnswer(
  ctx: GroundedRepairContext,
  repaired: GroundedAnswerResult,
): GroundedRepairResult {
  const index = buildPackCitationIndex(
    ctx.answer.sentEvidencePacks ?? (ctx.pack === undefined ? [] : [ctx.pack]),
  );
  const accepted =
    repaired.modelInvoked !== false &&
    validateCitationRepair(ctx.answer.content, repaired.content, index, ctx.numericMarkers);
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
  const repair = repairInvoker(ctx);
  if (repair === undefined) return { answer: ctx.answer, disposition: "skipped-capability" };
  try {
    const repaired = normalizeGroundedAnswerPayload(
      await repair(ctx.answer.content, repairOptions(ctx)),
    );
    return combinedRepairAnswer(ctx, repaired);
  } catch (failure) {
    if (ctx.deps.signal?.aborted === true) throw failure;
    return { answer: ctx.answer, disposition: "failed", failure };
  }
}

function repairInvoker(ctx: GroundedRepairContext): GroundedRepairContext["invokeRepair"] {
  if (ctx.invokeRepair !== undefined) return ctx.invokeRepair;
  const pack = ctx.answer.sentEvidencePacks?.[0] ?? ctx.pack;
  const repair = ctx.deps.answerer?.repair?.bind(ctx.deps.answerer);
  if (pack === undefined || repair === undefined) return undefined;
  return (original, options) => repair(ctx.question, pack, original, options);
}

function repairOptions(ctx: GroundedRepairContext): GroundedAnswerOptions {
  const budget = ctx.budget ?? ctx.pack?.budget;
  if (budget === undefined)
    throw new TypeError("Citation repair requires the original turn budget");
  return {
    modelInputTokensMax:
      budget.modelInputTokensMax -
      (ctx.pack?.usage.modelInputTokens ?? 0) -
      ctx.answer.usage.promptTokens,
    modelOutputTokensMax:
      budget.modelOutputTokensMax -
      (ctx.pack?.usage.modelOutputTokens ?? 0) -
      ctx.answer.usage.completionTokens,
    signal: ctx.deps.signal,
    deadlineAtMs: ctx.deadlineAtMs,
  };
}

export function observeGroundedCitationBehaviour(ctx: GroundedRepairContext): GroundedAnswerResult {
  if (
    ctx.answer.answerKind !== "answer" ||
    ctx.answer.modelInvoked === false ||
    ((ctx.answer.filesInPrompt ?? 0) === 0 && (ctx.numericMarkers?.size ?? 0) === 0)
  )
    return ctx.answer;
  const reconciliation = reconcileInlineCitations(
    ctx.answer.content,
    buildPackCitationIndex(
      ctx.answer.sentEvidencePacks ?? (ctx.pack === undefined ? [] : [ctx.pack]),
    ),
  );
  const numeric =
    ctx.numericMarkers === undefined
      ? undefined
      : reconcileNumericCitations(ctx.answer.content, ctx.numericMarkers);
  const behaviour =
    ctx.answer.citationBehaviour ??
    (reconciliation.citedScopePaths.size > 0 || (numeric?.citedMarkers.size ?? 0) > 0
      ? "cites"
      : "never");
  ctx.deps.observeCitationBehaviour?.(behaviour);
  return { ...ctx.answer, citationBehaviour: behaviour };
}
