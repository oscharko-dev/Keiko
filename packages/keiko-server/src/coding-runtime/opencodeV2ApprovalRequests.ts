import { createHash } from "node:crypto";

import { GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";

import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import type { SidecarPermissionEvent } from "./codingSidecarEventParser.js";
import { projectOpenCodePermissionEvent } from "./opencodeProtocol.js";

/**
 * How one governed ask ended (#3610). Closed and body-free: the tool facade route logs a refusal
 * by it, so a denied or expired human decision is never recorded as an origin violation again.
 */
export type OpenCodeV2ApprovalOutcome =
  "approved" | "denied" | "expired" | "cancelled" | "unavailable";

/** A refused governed ask as the bridge reports it to the tool facade route. */
export type ToolBridgeApprovalRejection =
  `approval-${Exclude<OpenCodeV2ApprovalOutcome, "approved">}`;

/**
 * The decision with the tool call it belongs to (#3612). `actionId` is the tool call's own
 * `sessionID:id` identity, bound to the ask id, so the bridge can settle that call; it is absent
 * only for an ask that did not parse.
 */
export interface OpenCodeV2ApprovalDecision {
  readonly outcome: OpenCodeV2ApprovalOutcome;
  readonly actionId?: string | undefined;
  /** The ask's own permission request id, which its log lines carry; absent when unparsed. */
  readonly requestId?: string | undefined;
}

interface Pending {
  readonly runId: string;
  readonly resolve: (outcome: OpenCodeV2ApprovalOutcome) => void;
}

export interface OpenCodeV2ApprovalRequests {
  request(input: {
    readonly value: unknown;
    readonly runId: string;
    readonly sessionId: string;
    readonly onPermission: (event: SidecarPermissionEvent) => void;
    readonly signal: AbortSignal;
  }): Promise<OpenCodeV2ApprovalDecision>;
  resolve(runId: string, requestId: string, approved: boolean): boolean;
  close(): void;
}

interface ParsedAsk {
  readonly event: SidecarPermissionEvent;
  readonly actionId: string;
}

const MAX_PENDING_ASKS = 64;
const ASK_KEYS: readonly string[] = ["action", "runId", "actionId", "properties"];
// The call id shape the safe-activity settlement accepts (productionOpenCodeBackend.ts).
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UNAVAILABLE: OpenCodeV2ApprovalDecision = { outcome: "unavailable" };

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// The plugin derives the ask id from the same `sessionID:id` seed it sends as `actionId`, so an
// actionId that does not hash to the ask id, or names another session, fails closed.
function boundActionId(value: unknown, sessionId: string, askId: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(`${sessionId}:`)) return false;
  if (!CALL_ID.test(value.slice(sessionId.length + 1))) return false;
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return askId === `per_${digest.slice(0, 32)}`;
}

// The ask body of this run's session that names its own tool call, with exactly the ask's keys: a
// file edit asks no one (its change review is its approval, ADR-0124 D6), so no ask carries more.
function parsedAsk(value: unknown, runId: string, sessionId: string): ParsedAsk | undefined {
  const body = record(value);
  if (body?.action !== "permission-request" || body.runId !== runId) return undefined;
  if (!exactKeys(body, ASK_KEYS)) return undefined;
  const properties = record(body.properties);
  if (properties?.sessionID !== sessionId) return undefined;
  const { actionId } = body;
  if (!boundActionId(actionId, sessionId, properties.id)) return undefined;
  const event = projectOpenCodePermissionEvent(
    { id: properties.id, type: "permission.asked", properties },
    sessionId,
  );
  return event === undefined ? undefined : { event, actionId };
}

// The decision about one parsed ask, naming its call and its permission request.
function decided(ask: ParsedAsk, outcome: OpenCodeV2ApprovalOutcome): OpenCodeV2ApprovalDecision {
  return { outcome, actionId: ask.actionId, requestId: ask.event.requestId };
}

function dispatchPermission(
  runId: string,
  event: SidecarPermissionEvent,
  onPermission: (event: SidecarPermissionEvent) => void,
  settle: (outcome: OpenCodeV2ApprovalOutcome) => void,
  diagnostics: ServerDiagnosticSink | undefined,
): void {
  try {
    onPermission(event);
  } catch (error) {
    settle("unavailable");
    emitServerDiagnostic(diagnostics, {
      correlationId: runId,
      timestamp: new Date().toISOString(),
      operation: "coding-runtime.opencode-composition",
      source: "opencode.permission",
      errorClass: contentFreeErrorClass(error),
      message: "runtime-turn-failed",
      code: "stage=permission-dispatch",
    });
  }
}

// Puts the ask to the human and settles it once: the decision, the one human-decision wait, or the
// caller going away, whichever comes first.
function humanDecision(
  pending: Map<string, Pending>,
  runId: string,
  event: SidecarPermissionEvent,
  onPermission: (event: SidecarPermissionEvent) => void,
  signal: AbortSignal,
  diagnostics: ServerDiagnosticSink | undefined,
): Promise<OpenCodeV2ApprovalOutcome> {
  return new Promise<OpenCodeV2ApprovalOutcome>((resolve) => {
    const settle = (outcome: OpenCodeV2ApprovalOutcome): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      pending.delete(event.requestId);
      resolve(outcome);
    };
    const onAbort = (): void => {
      settle("cancelled");
    };
    const timer = setTimeout(() => {
      settle("expired");
    }, GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS);
    timer.unref();
    pending.set(event.requestId, { runId, resolve: settle });
    signal.addEventListener("abort", onAbort, { once: true });
    dispatchPermission(runId, event, onPermission, settle, diagnostics);
  });
}

interface RegistryState {
  readonly pending: Map<string, Pending>;
  closed: boolean;
}

type ApprovalRequestInput = Parameters<OpenCodeV2ApprovalRequests["request"]>[0];

// Puts one parsed ask to the human, within the 64 asks that may wait at once.
function decideAsk(
  state: RegistryState,
  input: ApprovalRequestInput,
  ask: ParsedAsk,
  diagnostics: ServerDiagnosticSink | undefined,
): Promise<OpenCodeV2ApprovalDecision> | OpenCodeV2ApprovalDecision {
  const { runId, onPermission, signal } = input;
  const { event } = ask;
  if (state.pending.size >= MAX_PENDING_ASKS || state.pending.has(event.requestId)) {
    return decided(ask, "unavailable");
  }
  return humanDecision(state.pending, runId, event, onPermission, signal, diagnostics).then(
    (outcome) => decided(ask, outcome),
  );
}

/** The existing Keiko approval lane owns the decision; V2 plugin tools have no native ask API. */
export function createOpenCodeV2ApprovalRequests(
  diagnostics?: ServerDiagnosticSink,
): OpenCodeV2ApprovalRequests {
  const state: RegistryState = { pending: new Map<string, Pending>(), closed: false };
  return {
    request: async (input): Promise<OpenCodeV2ApprovalDecision> => {
      const ask = parsedAsk(input.value, input.runId, input.sessionId);
      if (ask === undefined) return UNAVAILABLE;
      if (input.signal.aborted || state.closed) return decided(ask, "cancelled");
      return decideAsk(state, input, ask, diagnostics);
    },
    resolve: (runId, requestId, approved): boolean => {
      const item = state.pending.get(requestId);
      if (item?.runId !== runId) return false;
      item.resolve(approved ? "approved" : "denied");
      return true;
    },
    close: (): void => {
      state.closed = true;
      for (const item of state.pending.values()) item.resolve("cancelled");
      state.pending.clear();
    },
  };
}
