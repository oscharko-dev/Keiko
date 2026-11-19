// Activity Log evidence of a person's explicit memory statement in a chat. Closed outcomes only:
// the statement and the memory it reaches never enter the line.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type { MemoryScopeKind } from "@oscharko-dev/keiko-contracts";
import type { ForgetSelector } from "@oscharko-dev/keiko-memory-governance";

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
  "not-found",
] as const;

export type MemoryExplicitForgetOutcome = (typeof MEMORY_EXPLICIT_FORGET_OUTCOMES)[number];

// `not-found`: a forget from the Memory window named a memory that does not exist. Every line names
// where the forget came from: `chat` (a "Vergiss das" statement) or `memory-center` (the Memory
// window routes; Journal and Memory Center share one API). A line that reached a selection also
// records the closed selector kind, the scope kind, whether a tombstone was written, and how many
// memories were forgotten and how many tombstones were written, so a person's deletion is
// reconstructable from the log alone and one entry, a sweep and a lineage (a fact with the earlier
// values it replaced) differ (#4206 AC 5, #4223). `statement` is a forget of words nothing was
// stored from: it forgets no memory and writes one tombstone per scope. No id, body or scope value:
// closed kinds and counts.
const MEMORY_FORGET_SURFACES = ["chat", "memory-center"] as const;

export const MEMORY_FORGET_SELECTOR_KINDS = [
  "by-id",
  "by-scope",
  "by-type",
  "by-source-conversation",
  "by-time-window",
  "statement",
] as const satisfies readonly (ForgetSelector["kind"] | "statement")[];

// The registration needs closed literals, so the scope kinds are listed here; the test of this module
// compares them with the contract's own list, so a sixth scope kind fails there instead of rejecting
// its line at the sink.
export const MEMORY_FORGET_SCOPE_KINDS = [
  "user",
  "workspace",
  "project",
  "workflow",
  "global",
] as const satisfies readonly MemoryScopeKind[];

export type MemoryForgetSelectorKind = (typeof MEMORY_FORGET_SELECTOR_KINDS)[number];

export type MemoryForgetSurface = (typeof MEMORY_FORGET_SURFACES)[number];

export interface MemoryForgetSurfaceDetail {
  readonly surface: MemoryForgetSurface;
  readonly selectorKind?: MemoryForgetSelectorKind | undefined;
  readonly scopeKind?: MemoryScopeKind | undefined;
  readonly tombstoneWritten?: boolean | undefined;
  readonly forgottenCount?: number | undefined;
  readonly tombstoneCount?: number | undefined;
  readonly lineageSkippedCount?: number | undefined;
}

export const CHAT_FORGET_SURFACE: MemoryForgetSurfaceDetail = { surface: "chat" };

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
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_FORGET_SURFACES,
    },
    selectorKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: MEMORY_FORGET_SELECTOR_KINDS,
    },
    scopeKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: MEMORY_FORGET_SCOPE_KINDS,
    },
    tombstoneWritten: { type: "boolean", dataClass: "closed-enum", required: false },
    forgottenCount: { type: "integer", dataClass: "count", required: false },
    tombstoneCount: { type: "integer", dataClass: "count", required: false },
    lineageSkippedCount: { type: "integer", dataClass: "count", required: false },
  },
  proofIds: ["memory.explicit.forget.line"],
});

// The optional fields a line carries are only those the caller knew; an absent one is not a zero.
function knownForgetFields(
  detail: MemoryForgetSurfaceDetail,
): Record<string, string | number | boolean> {
  const { selectorKind, tombstoneWritten, scopeKind, forgottenCount, tombstoneCount } = detail;
  const { lineageSkippedCount } = detail;
  const candidates = {
    selectorKind,
    tombstoneWritten,
    scopeKind,
    forgottenCount,
    tombstoneCount,
    lineageSkippedCount,
  };
  const known: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(candidates)) {
    if (value !== undefined) known[name] = value;
  }
  return known;
}

export function logExplicitMemoryForget(
  outcome: MemoryExplicitForgetOutcome,
  correlationId: string,
  detail: MemoryForgetSurfaceDetail,
): void {
  getServerLogger().info(
    activityLogEvent(
      MEMORY_EXPLICIT_FORGET_OPERATION,
      { correlationId },
      { outcome, surface: detail.surface, ...knownForgetFields(detail) },
    ),
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
