// Ids a client persists as a reference (#3557 review): chat ids, PR description proposal ids,
// Figma snapshot run ids, QI run ids and agent run ids.
//
// Every value a browser persists in its workspace snapshot passes the shared secret-shape heuristic,
// with no exemption: shape alone never proves where a value came from. That heuristic's
// payment-card rule reads the digits across a random UUID's last hyphen as a Luhn-valid card
// number for about 2 in 10,000 ids, so such an id was redacted at persistence, and a restored
// window could never find its target again. The server owns these ids, so it draws only ids the
// heuristic never flags. Every issued id leaves typed evidence with the number of draws the
// heuristic flagged first, zero included, and an exhausted draw fails with typed evidence.

import { randomUUID } from "node:crypto";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { looksLikeSecretShape } from "@oscharko-dev/keiko-contracts/runtime/memory";

import { correlationIdOrUnknown } from "./correlation.js";
import { getServerLogger } from "./observability/index.js";

export type ReferenceIdKind =
  "chat" | "pr-description-proposal" | "figma-snapshot-run" | "qi-run" | "agent-run";

// A flagged draw has a probability of about 2e-4, so 32 consecutive ones never happen by chance;
// reaching the bound means the random source is broken, which must fail loudly.
export const MAX_REFERENCE_ID_DRAWS = 32;

const REFERENCE_ID_FIELDS = {
  kind: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["chat", "pr-description-proposal", "figma-snapshot-run", "qi-run", "agent-run"],
  },
  // How many draws the heuristic flagged before the issued one (zero for a clean first draw), or
  // before the bound.
  flaggedDraws: { type: "integer", dataClass: "count", required: true },
  completeness: { type: "string", dataClass: "completeness-state", required: true },
  loss: { type: "string", dataClass: "loss-state", required: true },
} as const;

// An issued reference id: the checked allocation ran, whether its first draw was clean or not.
const REFERENCE_ID_ISSUED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "reference-id.issued",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "reference-id.logReferenceIdIssued",
  fields: REFERENCE_ID_FIELDS,
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["reference-id"],
  proofIds: ["reference-id.issued.line"],
  releaseImpact: "patch",
});

const REFERENCE_ID_EXHAUSTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "reference-id.exhausted",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "reference-id.logReferenceIdExhausted",
  fields: REFERENCE_ID_FIELDS,
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["reference-id"],
  proofIds: ["reference-id.exhausted.line"],
  releaseImpact: "patch",
});

function logReferenceIdIssued(
  kind: ReferenceIdKind,
  flaggedDraws: number,
  correlationId: string | undefined,
): void {
  getServerLogger().info(
    activityLogEvent(
      REFERENCE_ID_ISSUED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { kind, flaggedDraws, completeness: "complete", loss: "none" },
    ),
  );
}

function logReferenceIdExhausted(kind: ReferenceIdKind, correlationId: string | undefined): void {
  getServerLogger().error(
    activityLogEvent(
      REFERENCE_ID_EXHAUSTED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId), errorKind: "internal" },
      { kind, flaggedDraws: MAX_REFERENCE_ID_DRAWS, completeness: "complete", loss: "none" },
    ),
  );
}

/** Thrown when every draw was flagged: the random source is broken, never a caller's fault. */
export class ReferenceIdExhaustedError extends Error {
  public readonly kind: ReferenceIdKind;

  public constructor(kind: ReferenceIdKind) {
    super(`No ${kind} reference id outside the secret-shape heuristic was drawn.`);
    this.name = "ReferenceIdExhaustedError";
    this.kind = kind;
  }
}

export interface NewReferenceIdOptions {
  readonly kind: ReferenceIdKind;
  // Prepended before the check, so the heuristic judges the id the client will persist.
  readonly prefix?: string;
  // The operation that asked for the id; the evidence joins its timeline.
  readonly correlationId?: string | undefined;
  readonly draw?: () => string;
}

/** A random v4 UUID, after `prefix`, that the shared secret-shape heuristic does not flag. */
export function newReferenceId(options: NewReferenceIdOptions): string {
  const { kind, prefix = "", correlationId, draw = randomUUID } = options;
  for (let flaggedDraws = 0; flaggedDraws < MAX_REFERENCE_ID_DRAWS; flaggedDraws += 1) {
    const id = `${prefix}${draw()}`;
    if (looksLikeSecretShape(id)) continue;
    logReferenceIdIssued(kind, flaggedDraws, correlationId);
    return id;
  }
  logReferenceIdExhausted(kind, correlationId);
  throw new ReferenceIdExhaustedError(kind);
}
