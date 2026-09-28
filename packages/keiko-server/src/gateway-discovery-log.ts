import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { sha256Hex } from "@oscharko-dev/keiko-security";
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
    aliasHash: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["intersected", "conflicting"],
    },
    contextWindow: { type: "integer", dataClass: "count", required: true },
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

export function logAliasIntersection(
  input: {
    readonly alias: string;
    readonly contextWindow: number;
    readonly undeclaredLimit: boolean;
    readonly conflicting: boolean;
    readonly reasoningOptionCount: number;
  },
  correlationId: string | undefined,
): void {
  getServerLogger().info(
    activityLogEvent(
      ALIAS_INTERSECTION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      {
        aliasHash: sha256Hex(input.alias),
        state: input.conflicting ? "conflicting" : "intersected",
        contextWindow: input.contextWindow,
        undeclaredLimit: input.undeclaredLimit,
        reasoningOptionCount: input.reasoningOptionCount,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
