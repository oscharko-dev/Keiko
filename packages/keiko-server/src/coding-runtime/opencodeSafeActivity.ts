import type {
  CodingSafeActivityPlanStepState,
  CodingSafeActivityToolState,
} from "@oscharko-dev/keiko-contracts";

import type {
  CodingSafeActivityPlanStepInput,
  CodingSafeActivitySignal,
} from "./codingSafeActivityProjection.js";
import { parseOpenCodeHistory } from "./opencodeProtocol.js";

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
    const normalized = normalizeRow(row);
    if (normalized === "dropped") dropped += 1;
    else if (normalized !== undefined) signals.push(normalized);
  }
  return { signals, dropped };
}

function normalizeRow(
  value: unknown,
): NormalizedOpenCodeSafeActivitySignal | "dropped" | undefined {
  const source = record(value);
  const type = typeof source?.type === "string" ? source.type : undefined;
  if (!activityEventType(type)) return undefined;
  if (source === undefined || !parseOpenCodeHistory([value]).ok) return "dropped";
  const admitted = admittedActivitySource(source);
  if (admitted === undefined) return "dropped";
  const signal = signalFor(type, admitted.data);
  if (signal === "dropped") return "dropped";
  if (signal === undefined) return undefined;
  const identity = `${admitted.aggregateId}\u0000${String(admitted.sequence)}`;
  return { identity, signal: { ...signal, signalId: admitted.sourceId } };
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

type CodingSafeActivitySignalOutcome = CodingSafeActivitySignal | "dropped" | undefined;

function signalFor(
  type: string | undefined,
  data: Record<string, unknown>,
): CodingSafeActivitySignalOutcome {
  if (type === "message.updated.1") return messageSignal(data);
  if (type === "message.part.updated.1") return partSignal(data);
  if (type === "session.next.tool.called") return calledToolSignal(data);
  // Terminal outcomes are deliberately not inferred from upstream output. The Keiko tool facade
  // supplies succeeded/failed/denied/cancelled after its closed result is known.
  return undefined;
}

function messageSignal(data: Record<string, unknown>): CodingSafeActivitySignal | "dropped" {
  const base = messageSignalBase(data);
  if (base === undefined) return "dropped";
  if (base.role === "user") return { kind: "message", ...base };
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
): CodingSafeActivitySignal | "dropped" {
  const parentMessageId = string(record(data.info)?.parentID);
  if (parentMessageId === undefined) return "dropped";
  return {
    kind: "message",
    messageId: base.messageId,
    role: "assistant",
    occurredAt: base.occurredAt,
    parentMessageId,
  };
}

function partSignal(data: Record<string, unknown>): CodingSafeActivitySignalOutcome {
  const part = record(data.part);
  const occurredAt = instantFrom(data.time);
  if (part === undefined || occurredAt === undefined) return "dropped";
  if (part.type === "text") return textSignal(part, occurredAt);
  if (part.type === "tool" && part.tool === PLAN_TOOL) return planSignal(part, occurredAt);
  if (part.type === "tool") return toolPartSignal(part, occurredAt);
  return undefined;
}

/** The plan tool projects as a plan snapshot, never as productive tool activity (#2480). */
function planSignal(
  part: Record<string, unknown>,
  occurredAt: string,
): CodingSafeActivitySignalOutcome {
  const state = record(part.state);
  // Only the completed part carries the final argument list; earlier states may stream partials.
  if (state?.status !== "completed") return undefined;
  const messageId = string(part.messageID);
  const todos = record(state.input)?.todos;
  if (messageId === undefined || !Array.isArray(todos)) return "dropped";
  const steps: CodingSafeActivityPlanStepInput[] = [];
  for (const todo of todos) {
    const step = planStep(todo);
    if (step === undefined) return "dropped";
    steps.push(step);
  }
  return { kind: "plan", anchorMessageId: messageId, steps, occurredAt };
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
  if (part.ignored === true || part.synthetic === true) return undefined;
  const messageId = string(part.messageID);
  const text = string(part.text);
  if (messageId === undefined || text === undefined) return "dropped";
  // The real child appends a text part before any characters stream into it; the empty first
  // frame carries nothing to project and is skipped, never counted as a validation drop (#2473).
  if (text.length === 0) return undefined;
  return { kind: "text", messageId, text, occurredAt };
}

function toolPartSignal(
  part: Record<string, unknown>,
  occurredAt: string,
): CodingSafeActivitySignalOutcome {
  const state = record(part.state)?.status;
  // A completed part is a silent no-op: the Keiko tool facade supplies "succeeded" once its
  // closed result for a facade-dispatched (keiko_*) tool is known
  // (opencodeRuntimeComposition.ts settleTool), so inferring it again here would race a value
  // the facade already owns.
  if (state === "completed") return undefined;
  const normalizedState = toolPartState(state);
  const messageId = string(part.messageID);
  const callId = string(part.callID);
  const tool = string(part.tool);
  if (
    normalizedState === undefined ||
    messageId === undefined ||
    callId === undefined ||
    tool === undefined
  ) {
    return "dropped";
  }
  return { kind: "tool", messageId, callId, tool, state: normalizedState, occurredAt };
}

function calledToolSignal(data: Record<string, unknown>): CodingSafeActivitySignal | "dropped" {
  const occurredAt = instantFrom(data.timestamp);
  const messageId = string(data.assistantMessageID);
  const callId = string(data.callID);
  const tool = string(data.tool);
  return occurredAt === undefined ||
    messageId === undefined ||
    callId === undefined ||
    tool === undefined
    ? "dropped"
    : { kind: "tool", messageId, callId, tool, state: "running", occurredAt };
}

function toolPartState(
  value: unknown,
): Extract<CodingSafeActivityToolState, "pending" | "running"> | undefined {
  return value === "pending" || value === "running" ? value : undefined;
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
