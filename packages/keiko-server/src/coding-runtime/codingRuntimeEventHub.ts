import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  validateCodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";

import type { ServerDiagnosticSink } from "../diagnostics-log.js";

/** Maximum replay retention. Kept small because this is an SSE recovery aid, not a history store. */
export const CODING_RUNTIME_EVENT_HUB_MAX_EVENTS = 256;
export const CODING_RUNTIME_EVENT_HUB_MAX_BYTES = 1024 * 1024;
export const CODING_RUNTIME_EVENT_HUB_MAX_SUBSCRIBERS = 32;

export type CodingRuntimeEventHubInput =
  | {
      readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
      readonly kind: "status";
      readonly runId: string;
      readonly state: CodingWorkbenchRuntimeStateName;
      readonly revision: number;
      readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
    }
  | {
      readonly schemaVersion: typeof CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION;
      readonly kind: "runtime-event";
      readonly runId: string;
      readonly state: CodingWorkbenchRuntimeStateName;
      readonly revision: number;
      readonly eventKind: Extract<
        CodingWorkbenchRuntimeSseEvent,
        { kind: "runtime-event" }
      >["eventKind"];
      readonly auxiliaryOutcome?: Extract<
        CodingWorkbenchRuntimeSseEvent,
        { kind: "runtime-event" }
      >["auxiliaryOutcome"];
      readonly contentTrust?: Extract<
        CodingWorkbenchRuntimeSseEvent,
        { kind: "runtime-event" }
      >["contentTrust"];
      readonly failureCode?: CodingWorkbenchRuntimeFailureCode | undefined;
    };

export type CodingRuntimeEventHubResetReason =
  | "cursor-malformed"
  | "cursor-foreign"
  | "cursor-future"
  | "cursor-evicted"
  | "subscriber-capacity";

export type CodingRuntimeEventHubReplay =
  | { readonly ok: true; readonly events: readonly CodingWorkbenchRuntimeSseEvent[] }
  | {
      readonly ok: false;
      readonly reason: CodingRuntimeEventHubResetReason;
      readonly snapshotNeeded: true;
    };

export type CodingRuntimeEventHubPublishResult =
  | { readonly ok: true; readonly event: CodingWorkbenchRuntimeSseEvent }
  | {
      readonly ok: false;
      readonly reason: "invalid-event" | "sequence-exhausted" | "capacity-pressure";
    };

export interface CodingRuntimeEventHubSubscriber {
  /** Return false when the transport cannot drain. The hub detaches and closes it immediately. */
  readonly write: (event: CodingWorkbenchRuntimeSseEvent) => boolean | undefined;
  readonly close: () => void;
}

export type CodingRuntimeEventHubSubscribeResult =
  | { readonly ok: true; readonly detach: () => void }
  | {
      readonly ok: false;
      readonly reason: CodingRuntimeEventHubResetReason;
      readonly snapshotNeeded: true;
    };

export interface CodingRuntimeEventHubOptions {
  readonly maxEvents?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxSubscribers?: number | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * When present, mid-stream subscriber-write failures are recorded once per subscriber via this
   * sink with a redacted, correlation-preserving summary. Without a sink the failure was still
   * closed cleanly but left no operator trail (KEIKO-0225).
   */
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

interface RetainedEvent {
  readonly event: CodingWorkbenchRuntimeSseEvent;
  readonly bytes: number;
  readonly critical: boolean;
}

interface RunBuffer {
  nextSequence: number;
  bytes: number;
  terminal: boolean;
  readonly events: RetainedEvent[];
  readonly subscribers: Set<CodingRuntimeEventHubSubscriber>;
}

const TERMINAL_STATES = new Set<CodingWorkbenchRuntimeStateName>([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * A bounded, per-run SSE replay/fan-out primitive. It intentionally accepts only the public
 * content-free projection; cursor, sequence and timestamp are created here and never trusted from
 * an adapter or process stream.
 */
export class CodingRuntimeEventHub {
  private readonly runs = new Map<string, RunBuffer>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly maxSubscribers: number;
  private readonly now: () => Date;
  private readonly diagnostics: ServerDiagnosticSink | undefined;

  constructor(options: CodingRuntimeEventHubOptions = {}) {
    this.maxEvents = positiveInteger(options.maxEvents, CODING_RUNTIME_EVENT_HUB_MAX_EVENTS);
    this.maxBytes = positiveInteger(options.maxBytes, CODING_RUNTIME_EVENT_HUB_MAX_BYTES);
    this.maxSubscribers = positiveInteger(
      options.maxSubscribers,
      CODING_RUNTIME_EVENT_HUB_MAX_SUBSCRIBERS,
    );
    this.now = options.now ?? ((): Date => new Date());
    this.diagnostics = options.diagnostics;
  }

  publish(input: CodingRuntimeEventHubInput): CodingRuntimeEventHubPublishResult {
    if (!isExactInput(input)) return { ok: false, reason: "invalid-event" };
    const run = this.runs.get(input.runId) ?? this.newRun(input.runId);
    if (run.nextSequence >= Number.MAX_SAFE_INTEGER)
      return { ok: false, reason: "sequence-exhausted" };

    const sequence = run.nextSequence;
    const event = {
      ...input,
      cursor: `${input.runId}:${String(sequence)}`,
      sequence,
      occurredAt: this.now().toISOString(),
    } as CodingWorkbenchRuntimeSseEvent;
    if (!validateCodingWorkbenchRuntimeSseEvent(event).ok)
      return { ok: false, reason: "invalid-event" };
    const retained: RetainedEvent = {
      event,
      bytes: Buffer.byteLength(JSON.stringify(event), "utf8"),
      critical: isCritical(event),
    };

    // A terminal projection must not retain any potentially content-bearing live stream.
    if (isContainment(event)) this.removeLossy(run);
    if (!this.makeCapacity(run, retained)) return { ok: false, reason: "capacity-pressure" };

    run.nextSequence += 1;
    run.events.push(retained);
    run.bytes += retained.bytes;
    run.terminal = isTerminal(event);
    this.fanOut(run, event);
    if (run.terminal) this.closeSubscribers(run);
    return { ok: true, event };
  }

  replay(runId: string, lastEventId?: string): CodingRuntimeEventHubReplay {
    const run = this.runs.get(runId);
    if (lastEventId === undefined || lastEventId === "") {
      return { ok: true, events: run?.events.map(({ event }) => event) ?? [] };
    }
    const cursor = validateReplayCursor(runId, run, lastEventId);
    if ("reason" in cursor) return reset(cursor.reason);
    const { parsed, run: retainedRun } = cursor;
    const earliest = retainedRun.events[0]?.event.sequence;
    // Resume is valid only from a retained event. Treating a gap as replayable risks silently
    // claiming continuity after a lossy eviction, even when all currently retained events follow it.
    if (earliest !== undefined && parsed.sequence < earliest) return reset("cursor-evicted");
    return {
      ok: true,
      events: retainedRun.events
        .filter(({ event }) => event.sequence > parsed.sequence)
        .map(({ event }) => event),
    };
  }

  subscribe(
    runId: string,
    lastEventId: string | undefined,
    subscriber: CodingRuntimeEventHubSubscriber,
  ): CodingRuntimeEventHubSubscribeResult {
    const replay = this.replay(runId, lastEventId);
    if (!replay.ok) return replay;
    const run = this.runs.get(runId) ?? this.newRun(runId);
    if (run.subscribers.size >= this.maxSubscribers) return reset("subscriber-capacity");
    for (const event of replay.events) {
      if (!write(subscriber, event, runId, this.diagnostics))
        return { ok: true, detach: () => undefined };
    }
    if (run.terminal) {
      close(subscriber);
      return { ok: true, detach: () => undefined };
    }
    run.subscribers.add(subscriber);
    return { ok: true, detach: () => run.subscribers.delete(subscriber) };
  }

  /** Explicit lifecycle cleanup for a restart before its first new status/event. */
  restart(runId: string): void {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    this.removeLossy(run);
    this.removePermissionRequested(run);
    run.terminal = false;
    this.closeSubscribers(run);
  }

  /** Retention coupling: delete only ids selected by the durable snapshot ledger. */
  deleteRuns(runIds: readonly string[]): void {
    for (const runId of runIds) {
      const run = this.runs.get(runId);
      if (run === undefined) continue;
      this.closeSubscribers(run);
      this.runs.delete(runId);
    }
  }

  private newRun(runId: string): RunBuffer {
    const run: RunBuffer = {
      nextSequence: 0,
      bytes: 0,
      terminal: false,
      events: [],
      subscribers: new Set(),
    };
    this.runs.set(runId, run);
    return run;
  }

  private makeCapacity(run: RunBuffer, incoming: RetainedEvent): boolean {
    if (incoming.bytes > this.maxBytes) return false;
    // Keep one bounded slot (and equivalent byte headroom) for the terminal/recovery fact. If a
    // nonterminal critical burst consumes that reserve, fail admission so the orchestrator can move
    // the run to recovery-required; the terminal containment fact itself is never dropped.
    if (
      incoming.critical &&
      !isContainment(incoming.event) &&
      (run.events.filter(({ critical }) => critical).length >= this.maxEvents - 1 ||
        run.events
          .filter(({ critical }) => critical)
          .reduce((total, retained) => total + retained.bytes, 0) +
          incoming.bytes * 2 >
          this.maxBytes)
    )
      return false;
    while (run.events.length >= this.maxEvents || run.bytes + incoming.bytes > this.maxBytes) {
      const lossyIndex = run.events.findIndex(({ critical }) => !critical);
      if (lossyIndex < 0) return false;
      const removed = run.events.splice(lossyIndex, 1)[0];
      if (removed === undefined) return false;
      run.bytes -= removed.bytes;
    }
    return true;
  }

  private removeLossy(run: RunBuffer): void {
    for (let index = run.events.length - 1; index >= 0; index -= 1) {
      const retained = run.events[index];
      if (retained !== undefined && !retained.critical) {
        run.bytes -= retained.bytes;
        run.events.splice(index, 1);
      }
    }
  }

  /** Permission requests bind to a prior revision; clients must obtain the fresh snapshot after restart. */
  private removePermissionRequested(run: RunBuffer): void {
    for (let index = run.events.length - 1; index >= 0; index -= 1) {
      const retained = run.events[index];
      if (
        retained?.event.kind === "runtime-event" &&
        retained.event.eventKind === "permission-requested"
      ) {
        run.bytes -= retained.bytes;
        run.events.splice(index, 1);
      }
    }
  }

  private fanOut(run: RunBuffer, event: CodingWorkbenchRuntimeSseEvent): void {
    for (const subscriber of run.subscribers) {
      if (!write(subscriber, event, event.runId, this.diagnostics))
        run.subscribers.delete(subscriber);
    }
  }

  private closeSubscribers(run: RunBuffer): void {
    for (const subscriber of run.subscribers) close(subscriber);
    run.subscribers.clear();
  }
}

function validateReplayCursor(
  runId: string,
  run: RunBuffer | undefined,
  lastEventId: string,
):
  | {
      readonly parsed: { readonly runId: string; readonly sequence: number };
      readonly run: RunBuffer;
    }
  | { readonly reason: CodingRuntimeEventHubResetReason } {
  const parsed = parseCursor(lastEventId);
  if (parsed === undefined) return { reason: "cursor-malformed" };
  if (parsed.runId !== runId) return { reason: "cursor-foreign" };
  if (run === undefined || parsed.sequence >= run.nextSequence) return { reason: "cursor-future" };
  return { parsed, run };
}

function isCritical(event: CodingWorkbenchRuntimeSseEvent): boolean {
  return (
    isTerminal(event) ||
    event.state === "awaiting-approval" ||
    event.state === "recovery-required" ||
    event.failureCode === "revoked" ||
    (event.kind === "runtime-event" && event.eventKind === "permission-requested")
  );
}

function isTerminal(event: CodingWorkbenchRuntimeSseEvent): boolean {
  return (
    TERMINAL_STATES.has(event.state) ||
    (event.kind === "runtime-event" && event.eventKind === "runtime-stopped")
  );
}

function isContainment(event: CodingWorkbenchRuntimeSseEvent): boolean {
  return isTerminal(event) || event.state === "recovery-required";
}

function isExactInput(value: unknown): value is CodingRuntimeEventHubInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(value).sort(compareCodeUnits);
  const required =
    record.kind === "runtime-event"
      ? ["eventKind", "kind", "revision", "runId", "schemaVersion", "state"]
      : ["kind", "revision", "runId", "schemaVersion", "state"];
  const allowed =
    record.kind === "runtime-event"
      ? [
          "auxiliaryOutcome",
          "contentTrust",
          "eventKind",
          "failureCode",
          "kind",
          "revision",
          "runId",
          "schemaVersion",
          "state",
        ]
      : ["failureCode", "kind", "revision", "runId", "schemaVersion", "state"];
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function parseCursor(
  value: string,
): { readonly runId: string; readonly sequence: number } | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined;
  const delimiter = value.lastIndexOf(":");
  if (delimiter <= 0) return undefined;
  const runId = value.slice(0, delimiter);
  const sequenceText = value.slice(delimiter + 1);
  if (!SAFE_ID.test(runId)) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(sequenceText)) return undefined;
  const sequence = Number(sequenceText);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? { runId, sequence } : undefined;
}

function reset(
  reason: CodingRuntimeEventHubResetReason,
): CodingRuntimeEventHubReplay & CodingRuntimeEventHubSubscribeResult {
  return { ok: false, reason, snapshotNeeded: true };
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function write(
  subscriber: CodingRuntimeEventHubSubscriber,
  event: CodingWorkbenchRuntimeSseEvent,
  runId: string,
  diagnostics: ServerDiagnosticSink | undefined,
): boolean {
  try {
    const accepted = subscriber.write(event);
    if (accepted === false) {
      // A subscriber that returns `false` from write() is signalling backpressure exhaustion.
      // Emit a redacted operator record so the failure is diagnosable — previously it was
      // silently swallowed and closed. KEIKO-0225.
      recordSseFailure(diagnostics, runId, "backpressure", "Error");
      close(subscriber);
    }
    return accepted !== false;
  } catch (error) {
    // A throwing subscriber write means the wire is gone (client hung up, socket broken).
    // Same treatment: record one line and close the subscriber.
    recordSseFailure(diagnostics, runId, "subscriber-write-threw", errorClassName(error));
    close(subscriber);
    return false;
  }
}

function recordSseFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  runId: string,
  message: string,
  errorClass: string,
): void {
  if (diagnostics === undefined) return;
  try {
    diagnostics.record({
      correlationId: runId,
      timestamp: new Date().toISOString(),
      operation: "coding-runtime.sse-fanout",
      source: "coding-runtime-event-hub.write",
      errorClass,
      message,
    });
  } catch {
    // Diagnostic sink misbehaviour must not corrupt fan-out.
  }
}

function errorClassName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "Error";
}

function close(subscriber: CodingRuntimeEventHubSubscriber): void {
  try {
    subscriber.close();
  } catch {
    // A broken connection is already detached; cleanup must not break fan-out.
  }
}
