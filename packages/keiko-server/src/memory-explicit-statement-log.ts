// Activity Log evidence of a person's explicit memory statement in a chat. Closed outcomes only:
// the statement and the memory it reaches never enter the line.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { getServerLogger } from "./observability/index.js";

const MEMORY_EXPLICIT_OPERATION_BASE = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  owner: "keiko-server",
  causal: "none",
  releaseImpact: "patch",
  category: "memory",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["memory-explicit-statement"],
} as const;

// `not-stored`: a forget that goes on by asking for the answer ("Forget the formatting, just give me
// the answer") named nothing stored, so the turn forgot nothing and asked nothing (ADR-0146).
const MEMORY_EXPLICIT_FORGET_OUTCOMES = [
  "forgotten",
  "ambiguous",
  "refused",
  "failed",
  "not-stored",
] as const;

export type MemoryExplicitForgetOutcome = (typeof MEMORY_EXPLICIT_FORGET_OUTCOMES)[number];

const MEMORY_EXPLICIT_FORGET_OPERATION = defineActivityLogOperation({
  ...MEMORY_EXPLICIT_OPERATION_BASE,
  op: "memory.explicit.forget",
  emitter: "memory-explicit-statement-log.logExplicitMemoryForget",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_EXPLICIT_FORGET_OUTCOMES,
    },
  },
  proofIds: ["memory.explicit.forget.line"],
});

export function logExplicitMemoryForget(
  outcome: MemoryExplicitForgetOutcome,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(MEMORY_EXPLICIT_FORGET_OPERATION, { correlationId }, { outcome }),
  );
}

const MEMORY_EXPLICIT_REMEMBER_OUTCOMES = [
  "stored",
  "confirmed",
  "replayed",
  "suppressed",
  "refused",
] as const;

export type MemoryExplicitRememberOutcome = (typeof MEMORY_EXPLICIT_REMEMBER_OUTCOMES)[number];

const MEMORY_EXPLICIT_REMEMBER_OPERATION = defineActivityLogOperation({
  ...MEMORY_EXPLICIT_OPERATION_BASE,
  op: "memory.explicit.remember",
  emitter: "memory-explicit-statement-log.logExplicitMemoryRemember",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_EXPLICIT_REMEMBER_OUTCOMES,
    },
  },
  proofIds: ["memory.explicit.remember.line"],
});

export function logExplicitMemoryRemember(
  outcome: MemoryExplicitRememberOutcome,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(MEMORY_EXPLICIT_REMEMBER_OPERATION, { correlationId }, { outcome }),
  );
}
