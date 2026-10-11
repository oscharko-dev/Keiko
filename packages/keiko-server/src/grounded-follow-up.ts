import type { EvidenceConnectedContextFollowUp } from "@oscharko-dev/keiko-contracts/evidence";
import type {
  ConnectedContextPack,
  ExplorationBudget,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  combinedGroundedSynthesisFields,
  retainFailedGroundedSynthesis,
  type GroundedAnswerResult,
} from "./grounded-answer.js";
import { groundedAnswerSourceText } from "./grounded-faithfulness.js";
import { deriveGroundedContextAssembly } from "./grounded-context-diagnostics.js";
import type {
  OrchestratorInput,
  OrchestratorDeps,
  RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";

export type FollowUpOutcome = EvidenceConnectedContextFollowUp["outcome"];
export type FollowUpObservation = EvidenceConnectedContextFollowUp;
export interface FollowUpResult {
  readonly answer: GroundedAnswerResult;
  readonly pack: ConnectedContextPack;
  readonly observation: FollowUpObservation;
  readonly failure?: unknown;
}
export interface FollowUpContext {
  readonly input: OrchestratorInput;
  readonly deps: Pick<OrchestratorDeps, "signal"> & {
    readonly answerer?: OrchestratorDeps["answerer"] | undefined;
  };
  readonly pack: ConnectedContextPack;
  readonly initial: GroundedAnswerResult;
  readonly nowMs: () => number;
  readonly deadlineAtMs: number;
  readonly retrieve: (input: OrchestratorInput) => Promise<RetrievalOnlyOutput>;
  readonly answer: (
    input: OrchestratorInput,
    retrieved: RetrievalOnlyOutput,
    requiredEvidencePaths: readonly string[],
  ) => Promise<GroundedAnswerResult>;
}

function originalResult(
  ctx: FollowUpContext,
  outcome: FollowUpOutcome,
  failure?: unknown,
): FollowUpResult {
  return {
    answer: ctx.initial,
    pack: ctx.pack,
    observation: {
      passCount: 0,
      admittedPathCount: 0,
      outcome,
      trigger: outcome === "not-needed" ? "none" : "insufficiency-declared",
      firstDeclarations: ctx.initial.insufficiencyDeclarations ?? [],
    },
    ...(failure === undefined ? {} : { failure }),
  };
}

function genuineUnreadPaths(ctx: FollowUpContext): readonly string[] {
  const assembled = new Set(ctx.pack.files.map((file) => file.scopePath));
  return (ctx.initial.insufficiencyDeclarations ?? [])
    .filter(
      (declaration) =>
        declaration.state === "unread-in-scope" && !assembled.has(declaration.scopePath),
    )
    .map((declaration) => declaration.scopePath)
    .slice(0, 3);
}

export function remainingTurnBudget(ctx: FollowUpContext): ExplorationBudget {
  const budget = ctx.pack.budget;
  const usage = ctx.pack.usage;
  return {
    searchCallsMax: Math.max(0, budget.searchCallsMax - usage.searchCalls),
    filesReadMax:
      budget.filesReadMax === null ? null : Math.max(0, budget.filesReadMax - usage.filesRead),
    excerptBytesMax: Math.max(0, budget.excerptBytesMax - usage.excerptBytes),
    modelInputTokensMax: Math.max(
      0,
      budget.modelInputTokensMax - usage.modelInputTokens - ctx.initial.usage.promptTokens,
    ),
    modelOutputTokensMax: Math.max(
      0,
      budget.modelOutputTokensMax - usage.modelOutputTokens - ctx.initial.usage.completionTokens,
    ),
    elapsedMsMax: budget.elapsedMsMax === null ? null : Math.max(0, ctx.deadlineAtMs - ctx.nowMs()),
    rerankCallsMax: Math.max(0, budget.rerankCallsMax - usage.rerankCalls),
    followUpPassesMax: 0,
  };
}

function followUpRefusal(
  ctx: FollowUpContext,
  paths: readonly string[],
): FollowUpOutcome | undefined {
  if (ctx.initial.answerKind !== "insufficiency") return "not-needed";
  if (
    (ctx.initial.insufficiencyObservation?.declaredCount ?? 0) > 0 &&
    ctx.nowMs() >= ctx.deadlineAtMs
  )
    return "elapsed-refused";
  if (paths.length === 0) return "not-needed";
  if (ctx.pack.budget.followUpPassesMax === 0) return "disabled";
  if (followUpGrantExhausted(ctx)) return "budget-refused";
  return undefined;
}

function followUpGrantExhausted(ctx: FollowUpContext): boolean {
  return (
    ctx.deps.answerer?.remainingSynthesisCalls?.() === 0 ||
    highContextBudgetPressure(ctx) ||
    followUpBudgetExhausted(remainingTurnBudget(ctx))
  );
}

function highContextBudgetPressure(ctx: FollowUpContext): boolean {
  const profile = ctx.pack.diagnostics?.contextBudget?.profile;
  if (profile === undefined) return false;
  const pressure = deriveGroundedContextAssembly(ctx.pack, profile).budgetPressure;
  return pressure === "high" || pressure === "exceeded";
}

function followUpBudgetExhausted(budget: ExplorationBudget): boolean {
  if (
    budget.searchCallsMax <= 0 ||
    budget.filesReadMax === 0 ||
    budget.excerptBytesMax <= 0 ||
    budget.modelInputTokensMax <= 0 ||
    budget.modelOutputTokensMax <= 0
  )
    return true;
  return false;
}

function followUpInput(ctx: FollowUpContext, paths: readonly string[]): OrchestratorInput {
  return {
    ...ctx.input,
    assistantReferents: paths.map((path) => ({ path, origin: "assistant" })),
    continuityReferentSource: "assistant-declaration",
    budget: remainingTurnBudget(ctx),
  };
}

function combinedAuditPack(
  first: ConnectedContextPack,
  second: ConnectedContextPack,
): ConnectedContextPack {
  const files = [
    ...new Map([...first.files, ...second.files].map((file) => [file.scopePath, file])).values(),
  ];
  const present = new Set(files.map((file) => file.scopePath));
  const omitted = [
    ...new Map(
      [...first.omitted, ...second.omitted]
        .filter((file) => !present.has(file.scopePath))
        .map((file) => [file.scopePath, file]),
    ).values(),
  ];
  return {
    ...second,
    budget: first.budget,
    files,
    omitted,
    usage: {
      searchCalls: first.usage.searchCalls + second.usage.searchCalls,
      filesRead: first.usage.filesRead + second.usage.filesRead,
      excerptBytes: first.usage.excerptBytes + second.usage.excerptBytes,
      modelInputTokens: first.usage.modelInputTokens + second.usage.modelInputTokens,
      modelOutputTokens: first.usage.modelOutputTokens + second.usage.modelOutputTokens,
      elapsedMs: first.usage.elapsedMs + second.usage.elapsedMs,
      rerankCalls: first.usage.rerankCalls + second.usage.rerankCalls,
    },
  };
}

async function executeFollowUp(
  ctx: FollowUpContext,
  paths: readonly string[],
): Promise<FollowUpResult> {
  const input = followUpInput(ctx, paths);
  const retrieved = await ctx.retrieve(input);
  const admitted = retrieved.pack.files.filter((file) => paths.includes(file.scopePath)).length;
  const pack = combinedAuditPack(ctx.pack, retrieved.pack);
  if (admitted === 0) return completedRetrievalRefusal(ctx, pack, "budget-refused", admitted);
  if (ctx.nowMs() >= ctx.deadlineAtMs)
    return completedRetrievalRefusal(ctx, pack, "elapsed-refused", admitted);
  const answered = await answerFollowUp(ctx, input, retrieved, pack, admitted);
  if ("observation" in answered) return answered;
  if (answered.modelInvoked === false) return unsentFollowUpResult(ctx, pack, answered, admitted);
  if (!followUpTargetsSent(answered, retrieved.pack, paths))
    return unsentFollowUpResult(ctx, pack, answered, admitted);
  return {
    pack,
    answer: {
      ...answered,
      ...combinedGroundedSynthesisFields(ctx.initial, answered),
    },
    observation: {
      passCount: 1,
      admittedPathCount: admitted,
      trigger: "insufficiency-declared",
      outcome:
        answered.answerKind === "answer" &&
        groundedAnswerSourceText(answered.content).trim().length > 0
          ? "answered"
          : "still-insufficient",
      firstDeclarations: ctx.initial.insufficiencyDeclarations ?? [],
    },
  };
}

/** Pass count observes the completed retrieval pass, independently of additional model dispatch. */
function completedRetrievalRefusal(
  ctx: FollowUpContext,
  pack: ConnectedContextPack,
  outcome: FollowUpOutcome,
  admitted: number,
): FollowUpResult {
  const retained = originalResult(ctx, outcome);
  return {
    ...retained,
    pack,
    observation: { ...retained.observation, passCount: 1, admittedPathCount: admitted },
  };
}

function followUpTargetsSent(
  answer: GroundedAnswerResult,
  pack: ConnectedContextPack,
  paths: readonly string[],
): boolean {
  const present = new Set(
    (answer.sentEvidencePacks ?? [pack]).flatMap((sent) =>
      sent.files
        .filter((file) => file.excerpts.some((excerpt) => excerpt.content.length > 0))
        .map((file) => file.scopePath),
    ),
  );
  return paths.every((path) => present.has(path));
}

function unsentFollowUpResult(
  ctx: FollowUpContext,
  pack: ConnectedContextPack,
  attempted: GroundedAnswerResult,
  admitted: number,
): FollowUpResult {
  const retained = originalResult(ctx, "budget-refused");
  return {
    ...retained,
    pack,
    answer: {
      ...ctx.initial,
      ...combinedGroundedSynthesisFields(ctx.initial, attempted),
    },
    observation: { ...retained.observation, passCount: 1, admittedPathCount: admitted },
  };
}

async function answerFollowUp(
  ctx: FollowUpContext,
  input: OrchestratorInput,
  retrieved: RetrievalOnlyOutput,
  pack: ConnectedContextPack,
  admitted: number,
): Promise<GroundedAnswerResult | FollowUpResult> {
  try {
    return await ctx.answer(input, retrieved, genuineUnreadPaths(ctx));
  } catch (failure) {
    if (ctx.deps.signal?.aborted === true) throw failure;
    const retained = originalResult(
      ctx,
      ctx.nowMs() >= ctx.deadlineAtMs ? "elapsed-refused" : "budget-refused",
      failure,
    );
    return {
      ...retained,
      answer: retainFailedGroundedSynthesis(ctx.initial, ctx.deps.answerer),
      pack,
      observation: { ...retained.observation, passCount: 1, admittedPathCount: admitted },
    };
  }
}

export async function followUpGroundedAnswer(ctx: FollowUpContext): Promise<FollowUpResult> {
  const paths = genuineUnreadPaths(ctx);
  const refusal = followUpRefusal(ctx, paths);
  if (refusal !== undefined) return originalResult(ctx, refusal);
  try {
    return await executeFollowUp(ctx, paths);
  } catch (failure) {
    if (ctx.deps.signal?.aborted === true) throw failure;
    return originalResult(
      ctx,
      ctx.nowMs() >= ctx.deadlineAtMs ? "elapsed-refused" : "budget-refused",
      failure,
    );
  }
}
