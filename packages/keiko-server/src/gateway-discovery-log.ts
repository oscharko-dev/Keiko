import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { modelIdEvidence } from "./observability/model-id-evidence.js";
import { getServerLogger } from "./observability/index.js";
import { correlationIdOrUnknown } from "./correlation.js";

const ALIAS_INTERSECTION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.discovery.alias-intersection",
  owner: "keiko-server",
  category: "gateway",
  emitter: "gateway-discovery-log.logAliasIntersection",
  fields: {
    modelIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    // The role discovery gave this alias — the one line an operator (or agent) reads to learn where
    // every discovered model was put: the chat list, the embedding list, a voice lane, the reranker
    // candidates, or the unsupported report.
    role: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["chat", "embedding", "voice", "rerank", "unsupported"],
    },
    deploymentCount: { type: "integer", dataClass: "count", required: true },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["normalized", "intersected", "conflicting"],
    },
    contextWindow: { type: "integer", dataClass: "count", required: true },
    maxOutputTokens: { type: "integer", dataClass: "count", required: true },
    undeclaredOutputLimit: { type: "boolean", dataClass: "closed-enum", required: true },
    undeclaredLimit: { type: "boolean", dataClass: "closed-enum", required: true },
    reasoningOptionCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["gateway-alias-intersection"],
  proofIds: ["gateway.discovery.alias-intersection.line"],
  releaseImpact: "patch",
});

export type DiscoveryAliasRole = "chat" | "embedding" | "voice" | "rerank" | "unsupported";

export function logAliasIntersection(
  input: {
    readonly alias: string;
    readonly role: DiscoveryAliasRole;
    readonly deploymentCount: number;
    readonly contextWindow: number;
    readonly undeclaredLimit: boolean;
    readonly state: "normalized" | "intersected" | "conflicting";
    readonly maxOutputTokens: number;
    readonly undeclaredOutputLimit: boolean;
    readonly reasoningOptionCount: number;
  },
  correlationId: string | undefined,
): void {
  getServerLogger().info(
    activityLogEvent(
      ALIAS_INTERSECTION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        ...modelIdEvidence(input.alias),
        role: input.role,
        deploymentCount: input.deploymentCount,
        state: input.state,
        maxOutputTokens: input.maxOutputTokens,
        undeclaredOutputLimit: input.undeclaredOutputLimit,
        contextWindow: input.contextWindow,
        undeclaredLimit: input.undeclaredLimit,
        reasoningOptionCount: input.reasoningOptionCount,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

const RERANKER_SETUP_RESOLVED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.reranker.setup.resolved",
  owner: "keiko-server",
  category: "gateway",
  emitter: "gateway-discovery-log.logRerankerSetupResolution",
  fields: {
    // wired: a probed discovered engine became the retrieval reranker; kept-existing: the operator
    // (or an earlier setup) already owns one, so no discovered engine was probed or replaced — a
    // reranker that followed the gateway to a NEW endpoint is re-probed there first (probedCount 1)
    // and stays kept-existing when it answers; probe-failed: every probed candidate failed the live
    // two-document probe — including a carried-over reranker the new gateway does not host — so
    // retrieval reranking stays off. `candidateCount` counts the rerank engines discovery listed and
    // `probedCount` every probe the request spent, the carried-over reranker's included.
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["wired", "kept-existing", "probe-failed"],
    },
    modelIdDigest: { type: "string", dataClass: "digest", required: false, maxLength: 16 },
    candidateCount: { type: "integer", dataClass: "count", required: true },
    probedCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["gateway-reranker-configuration"],
  proofIds: ["gateway.reranker.setup.resolved.line"],
  releaseImpact: "minor",
});

export interface RerankerSetupResolution {
  readonly outcome: "wired" | "kept-existing" | "probe-failed";
  /** The admitted engine; present only for `wired`. */
  readonly wiredModelId?: string | undefined;
  readonly candidateCount: number;
  readonly probedCount: number;
}

/**
 * One body-free line per COMMITTED setup request that discovered a rerank engine or had to verify a
 * carried-over reranker. `probe-failed` is a warning: retrieval reranking silently stays off, and
 * at log level `warn` nothing else would say so. `wired` and `kept-existing` are the steady state.
 */
export function logRerankerSetupResolution(
  resolution: RerankerSetupResolution,
  correlationId: string | undefined,
): void {
  getServerLogger().log(
    resolution.outcome === "probe-failed" ? "warn" : "info",
    activityLogEvent(
      RERANKER_SETUP_RESOLVED,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        outcome: resolution.outcome,
        ...modelIdEvidence(resolution.wiredModelId),
        candidateCount: resolution.candidateCount,
        probedCount: resolution.probedCount,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
