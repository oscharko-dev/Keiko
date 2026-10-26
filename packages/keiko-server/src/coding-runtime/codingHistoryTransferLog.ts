import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import type {
  ActivityLogErrorKind,
  ActivityLogEventEnvelope,
  ActivityLogFieldContract,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { contentFreeErrorClass } from "../diagnostics-log.js";

/**
 * What the Coding History export and import lines share (#3904): the counts of the task that moved,
 * the body-free class, frames and causes of a failure, and whether the line describes all of it.
 * Each operation adds its own event, refusal vocabulary and counts.
 */
export const CODING_HISTORY_TRANSFER_FIELDS = {
  conversationId: { type: "string", dataClass: "opaque-id", required: false, maxLength: 128 },
  messageCount: { type: "integer", dataClass: "count", required: false },
  omittedMessageCount: { type: "integer", dataClass: "count", required: false },
  redactedMessageCount: { type: "integer", dataClass: "count", required: false },
  byteCount: { type: "integer", dataClass: "count", required: false },
  errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
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
} as const satisfies Readonly<Record<string, ActivityLogFieldContract>>;

type CodingHistoryTransferEvent = "requested" | "completed" | "refused";

/** What every transfer line receives; each operation adds its own fields. */
export interface CodingHistoryTransferInput<Reason extends string> {
  readonly correlationId: string;
  readonly reason?: Reason;
  readonly conversationId?: string;
  readonly messageCount?: number;
  readonly omittedMessageCount?: number;
  readonly redactedMessageCount?: number;
  readonly byteCount?: number;
  readonly error?: unknown;
}

interface CodingHistoryTransferOutcome<Reason extends string> {
  readonly reason?: Reason;
  readonly errorClass?: string;
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
  readonly completeness: "partial" | "complete";
  readonly loss: "event-dropped" | "none";
}

export interface CodingHistoryTransferLine<
  Reason extends string,
  Input extends CodingHistoryTransferInput<Reason>,
> {
  readonly envelope: ActivityLogEventEnvelope;
  readonly fields: Omit<Input, "correlationId" | "reason" | "error"> & {
    readonly event: CodingHistoryTransferEvent;
  } & CodingHistoryTransferOutcome<Reason>;
}

/**
 * The envelope and fields of one transfer line. A refusal is a warning that names its closed error
 * kind; a failure adds its body-free class, frames and causes; a refused or partial transfer is not
 * complete. The caller's emitter binds them to its own registered operation.
 */
export function codingHistoryTransferLine<
  Reason extends string,
  Input extends CodingHistoryTransferInput<Reason>,
>(
  event: CodingHistoryTransferEvent,
  input: Input,
  errorKinds: Readonly<Record<Reason, ActivityLogErrorKind>> & {
    readonly failed: ActivityLogErrorKind;
  },
  partial: boolean,
): CodingHistoryTransferLine<Reason, Input> {
  const { correlationId, reason, error, ...fields } = input;
  const refused = event === "refused";
  const incomplete = refused || partial;
  return {
    envelope: refused
      ? {
          correlationId,
          level: "warn",
          errorKind: reason === undefined ? errorKinds.failed : errorKinds[reason],
        }
      : { correlationId },
    fields: {
      event,
      ...fields,
      ...(reason === undefined ? {} : { reason }),
      ...(error === undefined
        ? {}
        : {
            errorClass: contentFreeErrorClass(error),
            frames: keikoStackFrames(error),
            causeChain: causeChain(error),
          }),
      completeness: incomplete ? "partial" : "complete",
      loss: incomplete ? "event-dropped" : "none",
    },
  };
}
