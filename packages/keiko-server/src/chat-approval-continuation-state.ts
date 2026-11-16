import type { ChatMessage, UiStore } from "./store/index.js";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { processServerLogSink } from "./process-log-sink.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";

const CONTINUATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.approval-continuation.state",
  category: "security",
  owner: "keiko-server",
  emitter: "chat-approval-continuation-state.writeContinuationState",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "registered",
        "detached",
        "cancelled",
        "expired",
        "authority-lost",
        "released",
        "stop-matched",
        "stop-unmatched",
      ],
    },
    turnDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    activeCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-approval-continuation"],
  proofIds: ["chat.approval-continuation.state.line"],
  releaseImpact: "patch",
});
type Phase = "registered" | "detached" | "cancelled" | "expired" | "authority-lost" | "released";
type StopPhase = "stop-matched" | "stop-unmatched";
export interface Continuation {
  observedApprovalIds?: Set<string>;
  expiresAt?: number;
  readonly message: ChatMessage;
  readonly controller: AbortController;
  readonly sessionId: string;
  readonly live: () => boolean;
  readonly correlationId: string;
}
export const continuations = new WeakMap<UiStore, Map<string, Continuation>>();

export function recordContinuation(entry: Continuation, phase: Phase): void {
  writeContinuationState(
    entry.correlationId,
    phase,
    entry.message.canonicalTurnRef,
    phase === "released" || entry.controller.signal.aborted ? 0 : 1,
  );
}
/**
 * A Stop request is recorded under its own correlation with the requested turn digest, so a Stop
 * that matched nothing is reconstructable and a matched one joins the turn's `cancelled` line.
 */
export function recordStopRequest(
  correlationId: string,
  turnDigest: string,
  matched: boolean,
): void {
  writeContinuationState(correlationId, matched ? "stop-matched" : "stop-unmatched", turnDigest, 0);
}
function writeContinuationState(
  correlationId: string,
  phase: Phase | StopPhase,
  turnDigest: string | undefined,
  activeCount: number,
): void {
  try {
    if (turnDigest === undefined) throw new TypeError("Missing admitted Chat turn identity");
    processServerLogSink().write(
      activityLogEvent(
        CONTINUATION,
        { correlationId },
        { phase, turnDigest, activeCount, completeness: "complete", loss: "none" },
      ),
    );
  } catch (error) {
    emitServerDiagnostic(undefined, continuationDiagnostic(correlationId, error));
  }
}
function continuationDiagnostic(
  correlationId: string,
  error: unknown,
): ReturnType<typeof serverDiagnosticFromError> {
  return serverDiagnosticFromError({
    correlationId,
    operation: "chat.approval-continuation.state",
    source: "chat-approval-continuation",
    error,
    redact: () => "server-operation-failed",
  });
}
export function entriesFor(store: UiStore): Map<string, Continuation> {
  const entries = continuations.get(store) ?? new Map<string, Continuation>();
  continuations.set(store, entries);
  return entries;
}

/** No lease preserves the existing request-owned authority path. */
export function chatApprovalContinuationIsLive(store: UiStore, messageId: string): boolean {
  const message = store.findMessageById(messageId);
  const entry =
    message?.canonicalTurnRef === undefined
      ? undefined
      : continuations.get(store)?.get(message.canonicalTurnRef);
  return entry === undefined || (entry.message.id === messageId && validateEntry(entry));
}
function validateEntry(entry: Continuation): boolean {
  if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
    if (!entry.controller.signal.aborted) {
      entry.controller.abort("approval continuation expired");
      recordContinuation(entry, "expired");
    }
    return false;
  }
  let live = false;
  try {
    live = entry.live();
  } catch (error) {
    emitServerDiagnostic(undefined, continuationDiagnostic(entry.correlationId, error));
  }
  if (live && !entry.controller.signal.aborted) return true;
  if (!entry.controller.signal.aborted) {
    entry.controller.abort("approval continuation authority lost");
    recordContinuation(entry, "authority-lost");
  }
  return false;
}
/** A retained review belongs to its original live app session and exact saved approval. */
export function chatApprovalDecisionIsLive(
  store: UiStore,
  approvalId: string,
  currentSessionId: () => string | undefined,
  observe = false,
): boolean {
  for (const entry of continuations.get(store)?.values() ?? []) {
    if (hasSavedApproval(store, entry, approvalId)) {
      const accepted = validateEntry(entry) && currentSessionId() === entry.sessionId;
      if (accepted && observe) {
        entry.observedApprovalIds ??= new Set<string>();
        entry.observedApprovalIds.add(approvalId);
      }
      return accepted;
    }
  }
  return true;
}
function hasSavedApproval(store: UiStore, entry: Continuation, approvalId: string): boolean {
  const exchanges = store.findMessageById(entry.message.id)?.toolTranscript?.exchanges ?? [];
  return exchanges.some((exchange) => exchange.approval?.approvalId === approvalId);
}
export function validateChatApprovalContinuation(store: UiStore, message: ChatMessage): void {
  const entry =
    message.canonicalTurnRef === undefined
      ? undefined
      : continuations.get(store)?.get(message.canonicalTurnRef);
  if (entry !== undefined) validateEntry(entry);
}
