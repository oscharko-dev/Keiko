import {
  activityLogEvent,
  activityLogErrorKindOr,
  classifyErrorKind,
  type ActivityLogErrorKind,
  defineActivityLogOperation,
  type ActivityLogFields,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  causeChain,
  contentFreeErrorClass,
  keikoStackFrames,
} from "@oscharko-dev/keiko-activity-log";
import type { CitationRepairDisposition } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { GroundedAnswerResult } from "./grounded-answer.js";
import type { FollowUpObservation } from "./grounded-follow-up.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { getServerLogger } from "./observability/index.js";

const ANSWER_DETAILS_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "search.connected-context.answer-details",
  category: "search",
  owner: "keiko-server",
  emitter: "grounded-answer-activity.logGroundedAnswerActivity",
  fields: {
    scopeIdentitySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    queryIdentitySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    followUpPass: { type: "integer", dataClass: "count", required: true },
    followUpPassCount: { type: "integer", dataClass: "count", required: true },
    followUpAdmittedPathCount: { type: "integer", dataClass: "count", required: true },
    followUpTrigger: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["none", "insufficiency-declared"],
    },
    followUpOutcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "not-needed",
        "answered",
        "still-insufficient",
        "budget-refused",
        "elapsed-refused",
        "disabled",
      ],
    },
    citationRepairDisposition: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "not-needed",
        "applied",
        "rejected-content-changed",
        "failed",
        "skipped-budget",
        "skipped-capability",
      ],
    },
    filesInPrompt: { type: "integer", dataClass: "count", required: true },
    synthesisCallCount: { type: "integer", dataClass: "count", required: false },
    completedSynthesisCallCount: { type: "integer", dataClass: "count", required: false },
    synthesisReservedOutputTokens: { type: "integer", dataClass: "count", required: false },
    answerKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["answer", "refusal", "clarification", "insufficiency"],
    },
    citationBehaviour: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["cites", "cites-after-repair", "never"],
    },
    insufficiencyDeclaredCount: { type: "integer", dataClass: "count", required: true },
    declaredUnreadInScopeCount: { type: "integer", dataClass: "count", required: true },
    followUpConfiguration: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["default", "enabled", "disabled", "invalid"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  diagnosticWhen: [
    { field: "declaredUnreadInScopeCount", positive: true },
    {
      field: "followUpOutcome",
      values: ["budget-refused", "elapsed-refused", "still-insufficient"],
    },
    { field: "citationRepairDisposition", values: ["failed", "rejected-content-changed"] },
    { field: "followUpConfiguration", values: ["invalid"] },
  ],
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["connected-context-retrieval"],
  proofIds: ["search.connected-context.answer-details.line"],
  releaseImpact: "patch",
});

export interface FollowUpConfiguration {
  readonly passesMax: 0 | 1;
  readonly disposition: "default" | "enabled" | "disabled" | "invalid";
}

export function connectedFollowUpConfiguration(value: string | undefined): FollowUpConfiguration {
  if (value === undefined) return { passesMax: 1, disposition: "default" };
  if (value === "1") return { passesMax: 1, disposition: "enabled" };
  if (value === "0") return { passesMax: 0, disposition: "disabled" };
  return { passesMax: 0, disposition: "invalid" };
}

export interface GroundedAnswerActivity {
  readonly scopeIdentitySha256: string;
  readonly queryIdentitySha256: string;
  readonly answer: GroundedAnswerResult;
  readonly followUp: FollowUpObservation;
  readonly repairDisposition: CitationRepairDisposition;
  readonly configuration?: FollowUpConfiguration["disposition"] | undefined;
  readonly failure?: unknown;
}

function failureFields(
  failure: unknown,
): Partial<ActivityLogFields<typeof ANSWER_DETAILS_OPERATION>> {
  if (failure === undefined) return {};
  const frames = keikoStackFrames(failure);
  const chain = causeChain(failure);
  return {
    failureKind: contentFreeErrorClass(failure),
    ...(frames.length === 0 ? {} : { frames }),
    ...(chain.length === 0 ? {} : { causeChain: chain }),
  };
}

function failureEnvelope(failure: unknown): { readonly errorKind?: ActivityLogErrorKind } {
  return failure === undefined
    ? {}
    : { errorKind: activityLogErrorKindOr(classifyErrorKind(failure), "internal") };
}

function synthesisActivityFields(
  answer: GroundedAnswerResult,
): Partial<ActivityLogFields<typeof ANSWER_DETAILS_OPERATION>> {
  return {
    ...(answer.synthesisCallCount === undefined
      ? {}
      : { synthesisCallCount: answer.synthesisCallCount }),
    ...(answer.completedSynthesisCallCount === undefined
      ? {}
      : { completedSynthesisCallCount: answer.completedSynthesisCallCount }),
    ...(answer.synthesisReservedOutputTokens === undefined
      ? {}
      : { synthesisReservedOutputTokens: answer.synthesisReservedOutputTokens }),
  };
}

export function logGroundedAnswerActivity(
  correlationId: string | undefined,
  input: GroundedAnswerActivity,
): void {
  const { answer, followUp } = input;
  const event = activityLogEvent(
    ANSWER_DETAILS_OPERATION,
    {
      correlationId: correlationIdOrUnknown(correlationId),
      ...failureEnvelope(input.failure),
    },
    {
      scopeIdentitySha256: input.scopeIdentitySha256,
      queryIdentitySha256: input.queryIdentitySha256,
      followUpPass: followUp.passCount,
      followUpPassCount: followUp.passCount,
      followUpAdmittedPathCount: followUp.admittedPathCount,
      followUpTrigger: followUp.trigger,
      followUpOutcome: followUp.outcome,
      citationRepairDisposition: input.repairDisposition,
      filesInPrompt: answer.filesInPrompt ?? 0,
      ...synthesisActivityFields(answer),
      insufficiencyDeclaredCount: answer.insufficiencyObservation?.declaredCount ?? 0,
      declaredUnreadInScopeCount: answer.insufficiencyObservation?.unreadInScopeCount ?? 0,
      ...(answer.answerKind === undefined ? {} : { answerKind: answer.answerKind }),
      ...(answer.citationBehaviour === undefined
        ? {}
        : { citationBehaviour: answer.citationBehaviour }),
      ...(input.configuration === undefined ? {} : { followUpConfiguration: input.configuration }),
      ...failureFields(input.failure),
      completeness: "complete",
      loss: "none",
    },
  );
  if (input.failure === undefined) getServerLogger().info(event);
  else getServerLogger().warn(event);
}
