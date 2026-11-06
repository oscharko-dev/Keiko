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
  /**
   * What the ask asks for, without its per-ask identity: equal asks of one run share one prompt.
   * Absent for an ask bound to its own action by an approval digest, which only ever approves that
   * one call.
   */
  readonly contentKey: string | undefined;
  /** Settles the prompt and every waiter that joined it. */
  readonly resolve: (outcome: OpenCodeV2ApprovalOutcome) => void;
  readonly join: (signal: AbortSignal) => Promise<OpenCodeV2ApprovalOutcome>;
}

export interface OpenCodeV2ApprovalRequests {
  /**
   * A server-built ask of the native policy (#3897): the event is already projected, so it goes
   * straight to the human through the same pending registry, wait and settlement as a plugin ask.
   */
  requestNative(input: {
    readonly runId: string;
    readonly event: SidecarPermissionEvent;
    readonly actionId?: string | undefined;
    readonly onPermission: (event: SidecarPermissionEvent) => void;
    readonly signal: AbortSignal;
  }): Promise<OpenCodeV2ApprovalDecision>;
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

// One run may keep this many prompts open, so a run that asks in a loop cannot use the whole
// registry up for the others; the global ceiling still bounds the process.
const MAX_PENDING_ASKS_PER_RUN = 16;
const MAX_PENDING_ASKS = 64;
// Per-ask identity: it differs between two asks for the same thing and says nothing about what is
// asked, so it stays out of the key that decides whether two asks are the same prompt.
const ASK_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  "requestId",
  "actionId",
  "idempotencyKey",
  "approvalId",
  "expiresAt",
]);
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

// A native ask may have no tool call to settle (an action evaluated outside a tool part).
function nativeDecided(
  ask: ParsedAsk,
  outcome: OpenCodeV2ApprovalOutcome,
): OpenCodeV2ApprovalDecision {
  return {
    outcome,
    ...(ask.actionId === "" ? {} : { actionId: ask.actionId }),
    requestId: ask.event.requestId,
  };
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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const entries = record(value);
  if (entries === undefined) return value;
  return Object.fromEntries(
    Object.keys(entries)
      .sort()
      .map((key) => [key, canonicalValue(entries[key])]),
  );
}

function askContentKey(runId: string, event: SidecarPermissionEvent): string | undefined {
  if (event.approvalDigest !== undefined) return undefined;
  const content = Object.fromEntries(
    Object.entries(event).filter(([key]) => !ASK_IDENTITY_FIELDS.has(key)),
  );
  return createHash("sha256")
    .update(JSON.stringify([runId, canonicalValue(content)]), "utf8")
    .digest("hex");
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
    const waiters = new Set<(outcome: OpenCodeV2ApprovalOutcome) => void>();
    const settle = (outcome: OpenCodeV2ApprovalOutcome): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      pending.delete(event.requestId);
      resolve(outcome);
      for (const waiter of waiters) waiter(outcome);
      waiters.clear();
    };
    const join = (joinerSignal: AbortSignal): Promise<OpenCodeV2ApprovalOutcome> =>
      new Promise<OpenCodeV2ApprovalOutcome>((joined) => {
        const finish = (outcome: OpenCodeV2ApprovalOutcome): void => {
          joinerSignal.removeEventListener("abort", onJoinerAbort);
          waiters.delete(finish);
          joined(outcome);
        };
        const onJoinerAbort = (): void => {
          finish("cancelled");
        };
        if (joinerSignal.aborted) return finish("cancelled");
        waiters.add(finish);
        joinerSignal.addEventListener("abort", onJoinerAbort, { once: true });
      });
    const onAbort = (): void => {
      settle("cancelled");
    };
    const timer = setTimeout(() => {
      settle("expired");
    }, GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS);
    timer.unref();
    pending.set(event.requestId, {
      runId,
      contentKey: askContentKey(runId, event),
      resolve: settle,
      join,
    });
    signal.addEventListener("abort", onAbort, { once: true });
    dispatchPermission(runId, event, onPermission, settle, diagnostics);
  });
}

interface RegistryState {
  readonly pending: Map<string, Pending>;
  closed: boolean;
}

type ApprovalRequestInput = Parameters<OpenCodeV2ApprovalRequests["request"]>[0];

// The prompt already open for the same thing in the same run, if any: its decision is this ask's.
function openPromptFor(
  pending: ReadonlyMap<string, Pending>,
  runId: string,
  event: SidecarPermissionEvent,
): Pending | undefined {
  const contentKey = askContentKey(runId, event);
  if (contentKey === undefined) return undefined;
  for (const item of pending.values()) {
    if (item.runId === runId && item.contentKey === contentKey) return item;
  }
  return undefined;
}

function pendingForRun(pending: ReadonlyMap<string, Pending>, runId: string): number {
  let count = 0;
  for (const item of pending.values()) if (item.runId === runId) count += 1;
  return count;
}

// Asks one human decision for an ask: it joins the open prompt for the same thing, or opens its own
// within the per-run and global bounds, or is `unavailable`.
function askHuman(
  state: RegistryState,
  input: {
    readonly runId: string;
    readonly onPermission: (event: SidecarPermissionEvent) => void;
    readonly signal: AbortSignal;
  },
  event: SidecarPermissionEvent,
  diagnostics: ServerDiagnosticSink | undefined,
): Promise<OpenCodeV2ApprovalOutcome> | "unavailable" {
  const { runId, onPermission, signal } = input;
  if (state.pending.has(event.requestId)) return "unavailable";
  const open = openPromptFor(state.pending, runId, event);
  if (open !== undefined) return open.join(signal);
  if (
    state.pending.size >= MAX_PENDING_ASKS ||
    pendingForRun(state.pending, runId) >= MAX_PENDING_ASKS_PER_RUN
  )
    return "unavailable";
  return humanDecision(state.pending, runId, event, onPermission, signal, diagnostics);
}

// Puts one parsed ask to the human.
async function decideAsk(
  state: RegistryState,
  input: ApprovalRequestInput,
  ask: ParsedAsk,
  diagnostics: ServerDiagnosticSink | undefined,
): Promise<OpenCodeV2ApprovalDecision> {
  return decided(ask, await askHuman(state, input, ask.event, diagnostics));
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
    requestNative: async (input): Promise<OpenCodeV2ApprovalDecision> => {
      const ask: ParsedAsk = { event: input.event, actionId: input.actionId ?? "" };
      if (input.signal.aborted || state.closed) return nativeDecided(ask, "cancelled");
      return nativeDecided(ask, await askHuman(state, input, ask.event, diagnostics));
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
