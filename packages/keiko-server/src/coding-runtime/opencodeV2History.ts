import { createHash } from "node:crypto";

import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

import type { CodingSafeActivitySignal } from "./codingSafeActivityProjection.js";
import type { OpenCodeReconciliationEvent } from "./opencodeReconciler.js";

interface Candidate {
  readonly key: string;
  readonly digest: string;
  readonly kind: OpenCodeReconciliationEvent["kind"];
  readonly signal?: CodingSafeActivitySignal | undefined;
}

interface PendingProjection {
  readonly nextKnown: ReadonlyMap<string, string>;
  readonly events: readonly OpenCodeReconciliationEvent[];
  readonly signals: ReadonlyMap<string, CodingSafeActivitySignal>;
}

export class OpenCodeV2HistoryError extends Error {
  constructor(readonly safeCode: string) {
    super("opencode-v2-history-invalid");
  }
}

const MESSAGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  user: ["id", "metadata", "time", "text", "files", "agents", "skills", "type"],
  assistant: [
    "id",
    "metadata",
    "time",
    "type",
    "agent",
    "model",
    "content",
    "snapshot",
    "finish",
    "rawFinish",
    "providerState",
    "cost",
    "tokens",
    "error",
    "retry",
  ],
  idle: ["id", "metadata", "time", "type", "outcome"],
  system: ["id", "metadata", "time", "type", "text", "description"],
  synthetic: ["id", "metadata", "time", "type", "text", "description"],
  shell: ["id", "metadata", "time", "type", "shellID", "command", "status", "exit", "output"],
  skill: ["id", "metadata", "time", "type", "skill", "name", "text"],
  "agent-switched": ["id", "metadata", "time", "type", "agent", "previous"],
  "model-switched": ["id", "metadata", "time", "type", "model", "previous"],
  "location-switched": [
    "id",
    "metadata",
    "time",
    "type",
    "projectID",
    "subpath",
    "location",
    "previous",
  ],
  compaction: [
    "id",
    "metadata",
    "time",
    "type",
    "status",
    "reason",
    "model",
    "providerState",
    "summary",
    "recent",
    "providerContext",
    "cost",
    "tokens",
    "error",
  ],
};

export interface OpenCodeV2HistoryProjection {
  project(
    sessionId: string,
    messages: readonly Readonly<Record<string, unknown>>[],
    checkpoint: number | undefined,
  ): readonly OpenCodeReconciliationEvent[];
  takeSignal(event: OpenCodeReconciliationEvent): CodingSafeActivitySignal | undefined;
  clearSignals(): void;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function assertMessageShape(message: Readonly<Record<string, unknown>>): void {
  const role = message.type;
  if (typeof role !== "string")
    throw new OpenCodeV2HistoryError("reason=event-unknown:type=unsupported");
  const allowed = MESSAGE_FIELDS[role];
  if (allowed === undefined)
    throw new OpenCodeV2HistoryError("reason=event-unknown:type=unsupported");
  const extra = Object.keys(message).filter((key) => !allowed.includes(key));
  if (extra.length === 0) return;
  throw new OpenCodeV2HistoryError(
    `reason=event-unknown:eventSha256=${digest(message).slice(0, 16)}:role=${role}:extraCount=${String(extra.length)}:extraKeySha256=${digest(extra.slice().sort()).slice(0, 16)}:missing=none`,
  );
}

function assertToolInput(
  part: Readonly<Record<string, unknown>>,
  state: Readonly<Record<string, unknown>>,
): void {
  const input = state.input;
  const valid =
    state.status === "streaming" ? typeof input === "string" : record(input) !== undefined;
  const inputBytes = valid ? Buffer.byteLength(JSON.stringify(input), "utf8") : 0;
  if (valid && inputBytes <= TOOL_CATALOG_LIMITS.maxArgumentBytes) return;
  throw new OpenCodeV2HistoryError(
    `reason=event-unknown:eventSha256=${digest(part).slice(0, 16)}:part=tool:tool=${String(part.name)}:status=${String(state.status)}:partBytes=${String(Buffer.byteLength(JSON.stringify(part), "utf8"))}:gate=argument-bound`,
  );
}

function eventTime(message: Readonly<Record<string, unknown>>): string {
  const created = record(message.time)?.created;
  if (typeof created !== "number" || !Number.isSafeInteger(created) || created < 0) {
    throw new Error("opencode-v2-message-time-invalid");
  }
  return new Date(created).toISOString();
}

function messageId(message: Readonly<Record<string, unknown>>): string {
  const value = message.id;
  if (typeof value !== "string" || !/^msg_[A-Za-z0-9_-]{1,251}$/u.test(value)) {
    throw new Error("opencode-v2-message-id-invalid");
  }
  return value;
}

function candidate(
  key: string,
  kind: Candidate["kind"],
  data: unknown,
  signal?: CodingSafeActivitySignal,
): Candidate {
  return { key, kind, digest: digest([key, data]), ...(signal === undefined ? {} : { signal }) };
}

function textCandidate(id: string, index: number, text: string, occurredAt: string): Candidate {
  if (Buffer.byteLength(text, "utf8") > 65_536) throw new Error("opencode-v2-text-oversized");
  return candidate(`${id}:text:${String(index)}`, "observation", text, {
    kind: "text",
    messageId: id,
    text,
    occurredAt,
  });
}

function toolIdentity(part: Readonly<Record<string, unknown>>): { id: string; name: string } {
  const id = part.id;
  const name = part.name;
  if (typeof id !== "string" || typeof name !== "string" || !name.startsWith("keiko_")) {
    throw new Error("opencode-v2-tool-invalid");
  }
  return { id, name };
}

function toolOccurredAt(part: Readonly<Record<string, unknown>>): string {
  const created = record(part.time)?.created;
  if (typeof created !== "number" || !Number.isSafeInteger(created) || created < 0) {
    throw new Error("opencode-v2-tool-time-invalid");
  }
  return new Date(created).toISOString();
}

function toolState(
  part: Readonly<Record<string, unknown>>,
  messageId: string,
): CodingSafeActivitySignal & { kind: "tool" } {
  const state = record(part.state);
  const status = state?.status;
  const { id, name } = toolIdentity(part);
  if (state === undefined) throw new Error("opencode-v2-tool-state-invalid");
  assertToolInput(part, state);
  const mapped =
    status === "completed"
      ? "succeeded"
      : status === "error"
        ? "failed"
        : status === "streaming"
          ? "pending"
          : status;
  if (
    mapped !== "pending" &&
    mapped !== "running" &&
    mapped !== "succeeded" &&
    mapped !== "failed"
  ) {
    throw new Error("opencode-v2-tool-state-invalid");
  }
  return {
    kind: "tool",
    messageId,
    callId: id,
    tool: name,
    state: mapped,
    occurredAt: toolOccurredAt(part),
  };
}

function assistantCandidates(
  message: Readonly<Record<string, unknown>>,
  parentMessageId: string,
): readonly Candidate[] {
  const id = messageId(message);
  const occurredAt = eventTime(message);
  const result: Candidate[] = [
    candidate(`${id}:message`, "observation", id, {
      kind: "message",
      role: "assistant",
      messageId: id,
      parentMessageId,
      occurredAt,
    }),
  ];
  if (!Array.isArray(message.content)) throw new Error("opencode-v2-content-invalid");
  for (const [index, value] of message.content.entries()) {
    const part = record(value);
    if (part?.type === "text" && typeof part.text === "string") {
      result.push(textCandidate(id, index, part.text, occurredAt));
    } else if (part?.type === "tool") {
      const signal = toolState(part, id);
      result.push(candidate(`${id}:tool:${String(index)}`, "tool", part, signal));
    }
  }
  return result;
}

function messageCandidates(
  message: Readonly<Record<string, unknown>>,
  parentMessageId: string | undefined,
): readonly Candidate[] {
  assertMessageShape(message);
  const id = messageId(message);
  const occurredAt = eventTime(message);
  if (message.type === "assistant") {
    if (parentMessageId === undefined) throw new Error("opencode-v2-parent-message-missing");
    return assistantCandidates(message, parentMessageId);
  }
  if (message.type === "user" && typeof message.text === "string") {
    return [
      candidate(`${id}:message`, "observation", id, {
        kind: "message",
        role: "user",
        messageId: id,
        occurredAt,
      }),
      textCandidate(id, 0, message.text, occurredAt),
    ];
  }
  if (message.type === "idle") {
    return [
      candidate(
        `${id}:idle`,
        message.outcome === "succeeded" ? "terminal" : "terminal-failure",
        message.outcome,
      ),
    ];
  }
  return [candidate(`${id}:other`, "observation", message.type)];
}

function allCandidates(
  sessionId: string,
  messages: readonly Readonly<Record<string, unknown>>[],
): readonly Candidate[] {
  const result: Candidate[] = [candidate(`${sessionId}:created`, "observation", sessionId)];
  let parentMessageId: string | undefined;
  for (const message of messages) {
    if (message.type === "user") parentMessageId = messageId(message);
    result.push(...messageCandidates(message, parentMessageId));
  }
  return result;
}

function makePending(
  sessionId: string,
  checkpoint: number,
  known: ReadonlyMap<string, string>,
  candidates: readonly Candidate[],
): PendingProjection {
  const nextKnown = new Map(known);
  const events: OpenCodeReconciliationEvent[] = [];
  const signals = new Map<string, CodingSafeActivitySignal>();
  for (const item of candidates) {
    if (known.get(item.key) === item.digest) continue;
    const sequence = checkpoint + events.length + 1;
    const id = `evt_${item.digest.slice(0, 32)}`;
    const event = { id, aggregateId: sessionId, sequence, digest: item.digest, kind: item.kind };
    events.push(event);
    nextKnown.set(item.key, item.digest);
    if (item.signal !== undefined)
      signals.set(`${sessionId}\u0000${String(sequence)}`, item.signal);
    if (events.length === 256) break;
  }
  return { nextKnown, events, signals };
}

/** A pull repeats unchanged candidates until the adapter commits its checkpoint. */
export function createOpenCodeV2HistoryProjection(): OpenCodeV2HistoryProjection {
  let known = new Map<string, string>();
  let pending: PendingProjection | undefined;
  let pendingStart = -1;
  const activeSignals = new Map<string, CodingSafeActivitySignal>();
  return {
    project(sessionId, messages, checkpoint): readonly OpenCodeReconciliationEvent[] {
      const position = checkpoint ?? -1;
      if (pending !== undefined && position === pendingStart + pending.events.length) {
        known = new Map(pending.nextKnown);
        pending = undefined;
      }
      if (pending !== undefined && position !== pendingStart) {
        throw new Error("opencode-v2-checkpoint-invalid");
      }
      pending ??= makePending(sessionId, position, known, allCandidates(sessionId, messages));
      pendingStart = position;
      for (const [key, signal] of pending.signals) activeSignals.set(key, signal);
      return pending.events;
    },
    takeSignal(event): CodingSafeActivitySignal | undefined {
      const key = `${event.aggregateId}\u0000${String(event.sequence)}`;
      const signal = activeSignals.get(key);
      activeSignals.delete(key);
      return signal;
    },
    clearSignals(): void {
      activeSignals.clear();
    },
  };
}
