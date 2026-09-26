import type {
  CodingSafeActivityPlanStepState,
  CodingSafeActivityToolState,
} from "@oscharko-dev/keiko-contracts";

import type {
  CodingSafeActivityPlanStepInput,
  CodingSafeActivitySignal,
} from "./codingSafeActivityProjection.js";
import { isOpenCodeFacadeDispatchedTool, parseOpenCodeHistory } from "./opencodeProtocol.js";

const PLAN_TOOL = "todowrite";
/** Closed upstream-status vocabulary (#2480); anything else fails the whole plan update closed. */
const PLAN_STEP_STATES: Readonly<Record<string, CodingSafeActivityPlanStepState>> = {
  pending: "pending",
  in_progress: "active",
  completed: "completed",
  cancelled: "cancelled",
};

export interface NormalizedOpenCodeSafeActivitySignal {
  readonly identity: string;
  readonly signal: CodingSafeActivitySignal;
}

export interface NormalizedOpenCodeSafeActivityHistory {
  readonly signals: readonly NormalizedOpenCodeSafeActivitySignal[];
  readonly dropped: number;
}

/**
 * A single explicit result shape shared by every row/signal derivation below: each one always
 * returns an object literal discriminated on `kind`, instead of mixing an object payload with the
 * bare `"dropped"` string sentinel and a bare `undefined` "nothing to project" signal.
 * - `dropped` counts toward the caller's validation-failure counter.
 * - `skip` is a deliberate no-op (an unrecognized event type, an empty first text frame, a
 *   facade-owned terminal tool state) -- never counted as a drop (#2473, #3390).
 */
type OpenCodeSafeActivityOutcome<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "dropped" }
  | { readonly kind: "skip" };

/**
 * Derives the display-safe mutation beside the existing content-free history projection. Every row
 * first passes the pinned exact OpenCode validator; raw rows, tool arguments, and results are never
 * retained in the returned shape.
 */
export function normalizeOpenCodeSafeActivityHistory(
  value: unknown,
): NormalizedOpenCodeSafeActivityHistory {
  if (!Array.isArray(value)) return { signals: [], dropped: 1 };
  const signals: NormalizedOpenCodeSafeActivitySignal[] = [];
  let dropped = 0;
  for (const row of value) {
    const outcome = normalizeRow(row);
    if (outcome.kind === "dropped") dropped += 1;
    else if (outcome.kind === "value") signals.push(outcome.value);
  }
  return { signals, dropped };
}

function normalizeRow(
  value: unknown,
): OpenCodeSafeActivityOutcome<NormalizedOpenCodeSafeActivitySignal> {
  const source = record(value);
  const type = typeof source?.type === "string" ? source.type : undefined;
  if (!activityEventType(type)) return { kind: "skip" };
  if (source === undefined || !parseOpenCodeHistory([value]).ok) return { kind: "dropped" };
  const admitted = admittedActivitySource(source);
  if (admitted === undefined) return { kind: "dropped" };
  const outcome = signalFor(type, admitted.data);
  if (outcome.kind !== "value") return outcome;
  const identity = `${admitted.aggregateId}\u0000${String(admitted.sequence)}`;
  return {
    kind: "value",
    value: { identity, signal: { ...outcome.value, signalId: admitted.sourceId } },
  };
}

function admittedActivitySource(source: Record<string, unknown>):
  | {
      readonly aggregateId: string;
      readonly sequence: number;
      readonly sourceId: string;
      readonly data: Record<string, unknown>;
    }
  | undefined {
  const aggregateId = string(source.aggregate_id);
  const sequence = safeInteger(source.seq);
  const sourceId = string(source.id);
  const data = record(source.data);
  return aggregateId === undefined ||
    sequence === undefined ||
    sourceId === undefined ||
    data === undefined
    ? undefined
    : { aggregateId, sequence, sourceId, data };
}

type CodingSafeActivitySignalOutcome = OpenCodeSafeActivityOutcome<CodingSafeActivitySignal>;

function signalFor(
  type: string | undefined,
  data: Record<string, unknown>,
): CodingSafeActivitySignalOutcome {
  if (type === "message.updated.1") return messageSignal(data);
  if (type === "message.part.updated.1") return partSignal(data);
  if (type === "session.next.tool.called") return calledToolSignal(data);
  // These top-level terminal event types carry no part to project (see toolPartSignal for the
  // part-level "error" status, which IS projected): the Keiko tool facade supplies
  // succeeded/denied/cancelled after its closed result is known.
  return { kind: "skip" };
}

function messageSignal(data: Record<string, unknown>): CodingSafeActivitySignalOutcome {
  const base = messageSignalBase(data);
  if (base === undefined) return { kind: "dropped" };
  if (base.role === "user") return { kind: "value", value: { kind: "message", ...base } };
  return assistantMessageSignal(data, base);
}

function messageSignalBase(data: Record<string, unknown>):
  | {
      readonly messageId: string;
      readonly role: "user" | "assistant";
      readonly occurredAt: string;
    }
  | undefined {
  const info = record(data.info);
  const role = info?.role;
  const messageId = string(info?.id);
  const occurredAt = instantFrom(record(info?.time)?.created);
  return messageId === undefined ||
    occurredAt === undefined ||
    (role !== "user" && role !== "assistant")
    ? undefined
    : { messageId, role, occurredAt };
}

function assistantMessageSignal(
  data: Record<string, unknown>,
  base: {
    readonly messageId: string;
    readonly role: "user" | "assistant";
    readonly occurredAt: string;
  },
): CodingSafeActivitySignalOutcome {
  const parentMessageId = string(record(data.info)?.parentID);
  if (parentMessageId === undefined) return { kind: "dropped" };
  return {
    kind: "value",
    value: {
      kind: "message",
      messageId: base.messageId,
      role: "assistant",
      occurredAt: base.occurredAt,
      parentMessageId,
    },
  };
}

function partSignal(data: Record<string, unknown>): CodingSafeActivitySignalOutcome {
  const part = record(data.part);
  const occurredAt = instantFrom(data.time);
  if (part === undefined || occurredAt === undefined) return { kind: "dropped" };
  if (part.type === "text") return textSignal(part, occurredAt);
  if (part.type === "tool" && part.tool === PLAN_TOOL) return planSignal(part, occurredAt);
  if (part.type === "tool") return toolPartSignal(part, occurredAt);
  return { kind: "skip" };
}

/** The plan tool projects as a plan snapshot, never as productive tool activity (#2480). */
function planSignal(
  part: Record<string, unknown>,
  occurredAt: string,
): CodingSafeActivitySignalOutcome {
  const state = record(part.state);
  // Only the completed part carries the final argument list; earlier states may stream partials.
  if (state?.status !== "completed") return { kind: "skip" };
  const messageId = string(part.messageID);
  const todos = record(state.input)?.todos;
  if (messageId === undefined || !Array.isArray(todos)) return { kind: "dropped" };
  const steps: CodingSafeActivityPlanStepInput[] = [];
  for (const todo of todos) {
    const step = planStep(todo);
    if (step === undefined) return { kind: "dropped" };
    steps.push(step);
  }
  return { kind: "value", value: { kind: "plan", anchorMessageId: messageId, steps, occurredAt } };
}

function planStep(value: unknown): CodingSafeActivityPlanStepInput | undefined {
  const todo = record(value);
  const content = string(todo?.content);
  const status = string(todo?.status);
  const state = status === undefined ? undefined : PLAN_STEP_STATES[status];
  // priority is required upstream, shape-checked here, and deliberately never projected.
  return todo === undefined ||
    content === undefined ||
    content.length === 0 ||
    state === undefined ||
    string(todo.priority) === undefined
    ? undefined
    : { text: content, state };
}

function textSignal(
  part: Record<string, unknown>,
  occurredAt: string,
): CodingSafeActivitySignalOutcome {
  if (part.ignored === true || part.synthetic === true) return { kind: "skip" };
  const messageId = string(part.messageID);
  const text = string(part.text);
  if (messageId === undefined || text === undefined) return { kind: "dropped" };
  // The real child appends a text part before any characters stream into it; the empty first
  // frame carries nothing to project and is skipped, never counted as a validation drop (#2473).
  if (text.length === 0) return { kind: "skip" };
  return { kind: "value", value: { kind: "text", messageId, text, occurredAt } };
}

function toolPartSignal(
  part: Record<string, unknown>,
  occurredAt: string,
): CodingSafeActivitySignalOutcome {
  const state = record(part.state)?.status;
  const tool = string(part.tool);
  // A completed part is a silent no-op for a facade-dispatched (keiko_*) tool: the Keiko tool
  // facade supplies "succeeded" once its closed result is known (opencodeRuntimeComposition.ts
  // settleTool), so inferring it again here would race a value the facade already owns. The only
  // native tool that ever reaches this function is "question" ("todowrite" is projected as a plan
  // by partSignal before reaching here, and never as productive tool activity, #2480); it has no
  // other terminal source, so for a non-facade tool the completed part IS the terminal signal
  // (#3390) -- fed through the same idempotent running->succeeded transition the facade path
  // relies on (codingSafeActivityProjection.ts allowedToolTransition).
  if (state === "completed" && (tool === undefined || isOpenCodeFacadeDispatchedTool(tool)))
    return { kind: "skip" };
  const normalizedState: CodingSafeActivityToolState | undefined =
    state === "completed" ? "succeeded" : toolPartState(state);
  const messageId = string(part.messageID);
  const callId = string(part.callID);
  if (
    normalizedState === undefined ||
    messageId === undefined ||
    callId === undefined ||
    tool === undefined
  ) {
    return { kind: "dropped" };
  }
  return {
    kind: "value",
    value: { kind: "tool", messageId, callId, tool, state: normalizedState, occurredAt },
  };
}

function calledToolSignal(data: Record<string, unknown>): CodingSafeActivitySignalOutcome {
  const occurredAt = instantFrom(data.timestamp);
  const messageId = string(data.assistantMessageID);
  const callId = string(data.callID);
  const tool = string(data.tool);
  return occurredAt === undefined ||
    messageId === undefined ||
    callId === undefined ||
    tool === undefined
    ? { kind: "dropped" }
    : {
        kind: "value",
        value: { kind: "tool", messageId, callId, tool, state: "running", occurredAt },
      };
}

function toolPartState(
  value: unknown,
): Extract<CodingSafeActivityToolState, "pending" | "running" | "failed"> | undefined {
  if (value === "pending" || value === "running") return value;
  // A terminal "error" part must still be projected even for a facade-dispatched tool: the
  // facade only settles once its HTTP tool-bridge round trip completes, so a fault the OpenCode
  // child hits before or without reaching the facade (e.g. a network fault dialing the bridge)
  // never calls settleTool and would otherwise leave the timeline reading "Running" forever
  // (#3390). The upstream error string is untrusted and deliberately dropped, never read here.
  return value === "error" ? "failed" : undefined;
}

function activityEventType(value: string | undefined): boolean {
  return (
    value === "message.updated.1" ||
    value === "message.part.updated.1" ||
    value === "session.next.tool.called" ||
    value === "session.next.tool.success" ||
    value === "session.next.tool.failed"
  );
}

export function millisFromValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function instantFrom(value: unknown): string | undefined {
  const millis = millisFromValue(value);
  if (!Number.isFinite(millis) || millis < 0) return undefined;
  try {
    return new Date(millis).toISOString();
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}
