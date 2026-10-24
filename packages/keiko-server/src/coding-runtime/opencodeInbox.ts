import {
  CODING_WORKBENCH_RUNTIME_INBOX_ITEMS_MAX,
  type CodingWorkbenchRuntimeInboxItem,
  type CodingWorkbenchRuntimePromptInputs,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import {
  activityLogErrorKindOr,
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  causeChain,
  errorKindOf,
  keikoStackFrames,
  type ServerLogSink,
} from "@oscharko-dev/keiko-activity-log";

import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type {
  CodingRuntimeInboxActionInput,
  CodingRuntimeInboxItems,
  CodingRuntimeInboxOutcome,
  CodingRuntimeInboxResult,
} from "./codingRuntimeInbox.js";
import type { OpenCodeRuntimeAdapter } from "./opencodeRuntimeAdapter.js";
import type { MintedNativeInput, OpenCodePromptInputsRunPort } from "./opencodePromptInputs.js";
import {
  OpenCodeV2HttpStatusError,
  type OpenCodeV2HttpClient,
  type OpenCodeV2InboxEntry,
} from "./opencodeV2HttpClient.js";

/**
 * The messages an operator sent into a running native turn that the runtime has not handed to the
 * model yet (S07, ADR-0137 D10). The runtime keeps them in the session's inbox: a `steer` message
 * joins the turn at its next step, a `queue` message after the turn's current work. Keiko lists the
 * ones it delivered itself, withdraws one on request (`DELETE`) and promotes a queued one to `steer`
 * (`PATCH`). Nothing else is ever listed or changed: an entry the runtime queued on its own, or one
 * Keiko did not mint for this run, is invisible here and an action naming it is refused, so a
 * hostile or stale id cannot reach another input. The text shown is the operator's own, kept by the
 * delivery ledger (`opencodePromptInputs.ts`); the runtime's payload is never read.
 */

/** The part of a ready run the inbox needs; `ReadyRun` of the composition satisfies it. */
export interface InboxRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly client: Pick<
    OpenCodeV2HttpClient,
    "cancelInboxEntry" | "inbox" | "promoteInboxEntry" | "recentMessageIds"
  >;
  readonly runtimeAdapter: Pick<OpenCodeRuntimeAdapter, "turnInFlight">;
}

export interface OpenCodeInboxRunPort {
  /**
   * The pending messages of the turn in flight, in the order the runtime will hand them to the model
   * (every `steer` message, then every `queue` message, each in the order it was delivered), or
   * `undefined` when the run offers none: its profile takes no delivery, it is not live, no turn is
   * running, or the listing failed. Never throws; every outcome is one body-free line.
   */
  readonly listInbox: (
    runId: string,
    correlationId?: string,
  ) => Promise<CodingRuntimeInboxItems | undefined>;
  /**
   * Withdraws or promotes one pending message of the turn in flight. The message must be one Keiko
   * delivered into this run. One the runtime already took is the truthful outcome
   * `already-delivered`, not a failure. Never throws; the refusal or outcome is one body-free line.
   */
  readonly actOnInbox: (
    runId: string,
    input: CodingRuntimeInboxActionInput,
    correlationId?: string,
  ) => Promise<CodingRuntimeInboxResult>;
  /**
   * Withdraws every message Keiko delivered that the runtime still holds, for the moment the turn
   * is interrupted: the runtime keeps pending messages through an interrupt and would hand them to
   * the model with the next prompt, a turn the operator never meant them for. Never throws.
   */
  readonly withdrawPendingInbox: (
    runId: string,
    correlationId?: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface OpenCodeInboxRunPortDeps {
  readonly readyRun: (runId: string) => InboxRun | undefined;
  readonly capabilities: CodingWorkbenchRuntimePromptInputs;
  readonly activityLog: ServerLogSink | undefined;
  /** The delivery ledger of the prompt inputs: which messages are the operator's own. */
  readonly nativeInput: OpenCodePromptInputsRunPort["nativeInput"];
  readonly withdrawNativeInput: OpenCodePromptInputsRunPort["withdrawNativeInput"];
}

const INBOX_ACTION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.inbox.action",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeInbox.recordInboxAction",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["cancel", "list", "promote", "withdraw"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "already-cancelled",
        "already-delivered",
        "cancelled",
        "failed",
        "listed",
        "promoted",
        "run-unavailable",
        "turn-not-running",
        "unknown-item",
        "unsupported",
        "withdrawn",
      ],
    },
    // How many pending messages the browser was given (a listing) or the interrupt withdrew, and how
    // many of the runtime's entries were left out (not the operator's own, or past the bound).
    itemCount: { type: "integer", dataClass: "count", required: false },
    ignoredCount: { type: "integer", dataClass: "count", required: false },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
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
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-prompt-inputs"],
  proofIds: ["coding-runtime.inbox.action.emitted-line"],
  releaseImpact: "patch",
});

type InboxLoggedAction = "cancel" | "list" | "promote" | "withdraw";

export type InboxSettlement =
  | {
      readonly action: InboxLoggedAction;
      readonly outcome: "run-unavailable" | "turn-not-running" | "unknown-item" | "unsupported";
    }
  | { readonly action: "cancel" | "promote"; readonly outcome: CodingRuntimeInboxOutcome }
  | {
      readonly action: "list";
      readonly outcome: "listed";
      readonly itemCount: number;
      readonly ignoredCount: number;
    }
  | { readonly action: "withdraw"; readonly outcome: "withdrawn"; readonly itemCount: number }
  | { readonly action: InboxLoggedAction; readonly outcome: "failed"; readonly error: unknown };

function settlementFields(settled: InboxSettlement): {
  readonly itemCount?: number;
  readonly ignoredCount?: number;
  readonly frames?: readonly string[];
  readonly causeChain?: readonly string[];
} {
  switch (settled.outcome) {
    case "listed":
      return { itemCount: settled.itemCount, ignoredCount: settled.ignoredCount };
    case "withdrawn":
      return { itemCount: settled.itemCount };
    case "failed":
      return { frames: keikoStackFrames(settled.error), causeChain: causeChain(settled.error) };
    default:
      return {};
  }
}

/**
 * One body-free line per inbox action: the run, the closed action and outcome, and counts. A failed
 * action carries the closed error kind, the Keiko frames and the cause chain, so a list that did
 * not come up or a cancel that did not take is explained by the log alone. No message text, id or
 * preview ever enters it.
 */
export function recordInboxAction(
  activityLog: ServerLogSink | undefined,
  runId: string,
  settled: InboxSettlement,
  correlationId?: string,
): void {
  const failed = settled.outcome === "failed";
  const refused =
    settled.outcome === "run-unavailable" ||
    settled.outcome === "turn-not-running" ||
    settled.outcome === "unknown-item" ||
    settled.outcome === "unsupported";
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      INBOX_ACTION_OPERATION,
      {
        level: failed || refused ? "warn" : "info",
        correlationId: correlationIdOrUnknown(correlationId ?? runId),
        ...(failed
          ? { errorKind: activityLogErrorKindOr(errorKindOf(settled.error), "internal") }
          : {}),
      },
      { runId, action: settled.action, outcome: settled.outcome, ...settlementFields(settled) },
    ),
  );
}

type InboxGate =
  | { readonly run: InboxRun }
  | { readonly refusal: "run-unavailable" | "turn-not-running" | "unsupported" };

/** What every inbox read and change needs: a profile that takes messages and a turn to hold them. */
function openGate(deps: OpenCodeInboxRunPortDeps, runId: string): InboxGate {
  if (!deps.capabilities.delivery) return { refusal: "unsupported" };
  const run = deps.readyRun(runId);
  if (run === undefined) return { refusal: "run-unavailable" };
  return run.runtimeAdapter.turnInFlight() ? { run } : { refusal: "turn-not-running" };
}

/** The order the runtime hands pending messages to the model: steered first, queued after. */
function deliveryOrder(entries: readonly OpenCodeV2InboxEntry[]): readonly OpenCodeV2InboxEntry[] {
  return [
    ...entries.filter((entry) => entry.delivery === "steer"),
    ...entries.filter((entry) => entry.delivery === "queue"),
  ];
}

interface PendingProjection {
  readonly items: CodingRuntimeInboxItems;
  readonly ignoredCount: number;
}

/** The runtime's inbox as the operator's own pending messages: nothing else is shown. */
function projectPending(
  deps: OpenCodeInboxRunPortDeps,
  runId: string,
  entries: readonly OpenCodeV2InboxEntry[],
): PendingProjection {
  const items: CodingWorkbenchRuntimeInboxItem[] = [];
  for (const entry of deliveryOrder(entries)) {
    if (entry.kind !== "user" || items.length === CODING_WORKBENCH_RUNTIME_INBOX_ITEMS_MAX) {
      continue;
    }
    const minted = deps.nativeInput(runId, entry.id);
    if (minted === undefined || minted.withdrawn) continue;
    items.push({ itemId: entry.id, delivery: entry.delivery, preview: minted.preview });
  }
  return { items, ignoredCount: entries.length - items.length };
}

async function listPending(
  deps: OpenCodeInboxRunPortDeps,
  runId: string,
  correlationId: string | undefined,
): Promise<CodingRuntimeInboxItems | undefined> {
  const settle = (settled: InboxSettlement): void => {
    recordInboxAction(deps.activityLog, runId, settled, correlationId);
  };
  const gate = openGate(deps, runId);
  if ("refusal" in gate) {
    settle({ action: "list", outcome: gate.refusal });
    return undefined;
  }
  try {
    const projection = projectPending(deps, runId, await gate.run.client.inbox(gate.run.sessionId));
    settle({
      action: "list",
      outcome: "listed",
      itemCount: projection.items.length,
      ignoredCount: projection.ignoredCount,
    });
    return projection.items;
  } catch (error) {
    recordInboxAction(
      deps.activityLog,
      runId,
      { action: "list", outcome: "failed", error },
      correlationId,
    );
    return undefined;
  }
}

/** What an entry the runtime no longer holds became: Keiko's own withdrawal, or a delivery. */
function leftTheInbox(minted: MintedNativeInput): CodingRuntimeInboxOutcome {
  return minted.withdrawn ? "already-cancelled" : "already-delivered";
}

/**
 * Withdraws the message and proves it did not reach the model. The runtime answers a withdrawal of
 * an input it already took with the same success as one it removed, so the answer alone proves
 * nothing: a message in the session's newest history was delivered in the instant between the read
 * and the withdrawal.
 */
async function cancelPending(
  deps: OpenCodeInboxRunPortDeps,
  run: InboxRun,
  itemId: string,
): Promise<CodingRuntimeInboxOutcome> {
  await run.client.cancelInboxEntry(run.sessionId, itemId);
  if ((await run.client.recentMessageIds(run.sessionId)).includes(itemId)) {
    return "already-delivered";
  }
  deps.withdrawNativeInput(run.runId, itemId);
  return "cancelled";
}

function isConflict(error: unknown): boolean {
  return error instanceof OpenCodeV2HttpStatusError && error.status === 409;
}

/**
 * Changes the message to `steer`. The runtime answers a message it no longer holds as pending with
 * 409; that is only believed after the inbox is read again and no longer lists it, since a conflict
 * about an entry that is still there is a refusal, not a delivery.
 */
async function promotePending(
  run: InboxRun,
  itemId: string,
  minted: MintedNativeInput,
): Promise<CodingRuntimeInboxOutcome> {
  try {
    await run.client.promoteInboxEntry(run.sessionId, itemId);
    return "promoted";
  } catch (error) {
    if (!isConflict(error)) throw error;
    const stillPending = (await run.client.inbox(run.sessionId)).some(
      (entry) => entry.id === itemId,
    );
    if (stillPending) throw error;
    return leftTheInbox(minted);
  }
}

async function changePending(
  deps: OpenCodeInboxRunPortDeps,
  run: InboxRun,
  input: CodingRuntimeInboxActionInput,
  minted: MintedNativeInput,
): Promise<CodingRuntimeInboxOutcome> {
  const pending = (await run.client.inbox(run.sessionId)).find(
    (entry) => entry.id === input.itemId && entry.kind === "user",
  );
  if (pending === undefined) return leftTheInbox(minted);
  return input.action === "cancel"
    ? cancelPending(deps, run, input.itemId)
    : promotePending(run, input.itemId, minted);
}

async function actOnPending(
  deps: OpenCodeInboxRunPortDeps,
  runId: string,
  input: CodingRuntimeInboxActionInput,
  correlationId: string | undefined,
): Promise<CodingRuntimeInboxResult> {
  const settle = (settled: InboxSettlement): void => {
    recordInboxAction(deps.activityLog, runId, settled, correlationId);
  };
  const gate = openGate(deps, runId);
  if ("refusal" in gate) {
    settle({ action: input.action, outcome: gate.refusal });
    return { ok: false, reason: gate.refusal };
  }
  const minted = deps.nativeInput(runId, input.itemId);
  if (minted === undefined) {
    settle({ action: input.action, outcome: "unknown-item" });
    return { ok: false, reason: "unknown-item" };
  }
  try {
    const outcome = await changePending(deps, gate.run, input, minted);
    settle({ action: input.action, outcome });
    return { ok: true, outcome };
  } catch (error) {
    recordInboxAction(
      deps.activityLog,
      runId,
      { action: input.action, outcome: "failed", error },
      correlationId,
    );
    return { ok: false, reason: "inbox-failed" };
  }
}

async function withdrawPending(
  deps: OpenCodeInboxRunPortDeps,
  runId: string,
  correlationId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const run = deps.capabilities.delivery ? deps.readyRun(runId) : undefined;
  if (run === undefined) return;
  try {
    let withdrawn = 0;
    for (const entry of await run.client.inbox(run.sessionId, signal)) {
      const minted = entry.kind === "user" ? deps.nativeInput(runId, entry.id) : undefined;
      if (minted === undefined || minted.withdrawn) continue;
      await run.client.cancelInboxEntry(run.sessionId, entry.id, signal);
      deps.withdrawNativeInput(runId, entry.id);
      withdrawn += 1;
    }
    if (withdrawn > 0) {
      recordInboxAction(
        deps.activityLog,
        runId,
        { action: "withdraw", outcome: "withdrawn", itemCount: withdrawn },
        correlationId,
      );
    }
  } catch (error) {
    recordInboxAction(
      deps.activityLog,
      runId,
      { action: "withdraw", outcome: "failed", error },
      correlationId,
    );
  }
}

export function createOpenCodeInboxRunPort(deps: OpenCodeInboxRunPortDeps): OpenCodeInboxRunPort {
  return {
    listInbox: (runId, correlationId) => listPending(deps, runId, correlationId),
    actOnInbox: (runId, input, correlationId) => actOnPending(deps, runId, input, correlationId),
    withdrawPendingInbox: (runId, correlationId, signal) =>
      withdrawPending(deps, runId, correlationId, signal),
  };
}
