import { createHash } from "node:crypto";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { processServerLogSink } from "../process-log-sink.js";
import type {
  CodingRuntimeContextUsageRegistry,
  CodingRuntimeConversation,
} from "./codingRuntimeContextUsage.js";

const CONTEXT_USAGE_OBSERVED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.context-usage.observed",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeContextUsageObservation.recordContextUsageObservation",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["accepted", "rejected"],
    },
    capacityTokens: { type: "integer", dataClass: "count", required: true },
    usedInputTokens: { type: "integer", dataClass: "count", required: true },
    reservedOutputTokens: { type: "integer", dataClass: "count", required: true },
    sampleDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-context-usage"],
  proofIds: ["coding-runtime.context-usage.observed.emitted-line"],
  releaseImpact: "patch",
});

/**
 * Hands the run's context usage a prompt size the provider reported to Keiko's own model gateway
 * and records what the registry made of it. The gateway sees every native model call of a run, so
 * this is the source that does not depend on which events the pinned runtime emits (#4359).
 */
export function observeGatewayPromptTokens(
  contextUsage: CodingRuntimeContextUsageRegistry,
  runId: string,
  conversation: CodingRuntimeConversation,
  providerPromptTokens: number,
  modelCallId: number | undefined,
  log: ServerLogSink = processServerLogSink(),
): void {
  const now = new Date();
  const fallbackId = `${String(providerPromptTokens)}@${String(now.getTime())}`;
  const sampleId = `gateway-call:${String(modelCallId ?? fallbackId)}`;
  const outcome = contextUsage.recordGatewayPrompt(
    runId,
    conversation,
    sampleId,
    providerPromptTokens,
    now.toISOString(),
  );
  if (outcome === undefined) return;
  const sampleDigest = createHash("sha256").update(sampleId).digest("hex");
  log.write(
    activityLogEvent(
      CONTEXT_USAGE_OBSERVED_OPERATION,
      outcome.accepted
        ? { level: "info", correlationId: runId }
        : { level: "warn", correlationId: runId, errorKind: "conflict" },
      {
        state: outcome.accepted ? "accepted" : "rejected",
        capacityTokens: outcome.capacityTokens,
        usedInputTokens: providerPromptTokens,
        reservedOutputTokens: outcome.reservedOutputTokens,
        sampleDigest,
      },
    ),
  );
}
