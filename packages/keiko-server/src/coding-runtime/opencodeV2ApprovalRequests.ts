import { createHash } from "node:crypto";

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";

import { correlationIdOrUnknown } from "../correlation.js";
import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import type { ServerLogSink } from "../observability/server-log.js";
import type { SidecarPermissionEvent } from "./codingSidecarEventParser.js";
import type { CodingToolEditBaseRead } from "./codingToolFacadePorts.js";
import { projectOpenCodePermissionEvent } from "./opencodeProtocol.js";

/**
 * How one governed ask ended (#3610). Closed and body-free: the tool facade route logs a refusal
 * by it, so a denied or expired human decision is never recorded as an origin violation again.
 * `stale`: a changeset's base digest no longer matched its file, so no human was asked (#3612).
 * `authority-denied`: the run's live authority, or its workspace, no longer admits the edit's
 * reads, so no human was asked either (PR #3617 review).
 */
export type OpenCodeV2ApprovalOutcome =
  "approved" | "denied" | "expired" | "cancelled" | "unavailable" | "stale" | "authority-denied";

/** A refused governed ask as the bridge reports it to the tool facade route. */
export type ToolBridgeApprovalRejection =
  `approval-${Exclude<OpenCodeV2ApprovalOutcome, "approved">}`;

/**
 * The decision with the tool call it belongs to (#3612). `actionId` is the tool call's own
 * `sessionID:id` identity, bound to the ask id, so the bridge can settle that call; it is absent
 * only for an ask that did not parse. `staleFile` names the changeset file whose base was stale.
 */
export type OpenCodeV2ApprovalDecision =
  | { readonly outcome: "stale"; readonly actionId: string; readonly staleFile: string }
  | {
      readonly outcome: Exclude<OpenCodeV2ApprovalOutcome, "stale">;
      readonly actionId?: string | undefined;
    };

/** What a governed read of the file answers now: its digest, that it cannot say, or a denial. */
export type OpenCodeV2EditBaseDigest = (
  relativePath: string,
  signal: AbortSignal,
) => Promise<CodingToolEditBaseRead>;

/** How a human decision ended; a stale base or a denied authority never reaches one. */
type HumanDecisionOutcome = Exclude<OpenCodeV2ApprovalOutcome, "stale" | "authority-denied">;

interface Pending {
  readonly runId: string;
  readonly resolve: (outcome: HumanDecisionOutcome) => void;
}

export interface OpenCodeV2ApprovalRequests {
  request(input: {
    readonly value: unknown;
    readonly runId: string;
    readonly sessionId: string;
    readonly onPermission: (event: SidecarPermissionEvent) => void;
    readonly signal: AbortSignal;
    readonly editBaseDigest?: OpenCodeV2EditBaseDigest | undefined;
  }): Promise<OpenCodeV2ApprovalDecision>;
  resolve(runId: string, requestId: string, approved: boolean): boolean;
  close(): void;
}

interface EditBase {
  readonly file: string;
  readonly expectedContentHash: string;
}

interface ParsedAsk {
  readonly event: SidecarPermissionEvent;
  readonly actionId: string;
  readonly bases: readonly EditBase[];
}

// How a governed edit ask's base check ended (#3612), under the run's own correlation, so each stale
// edit and each check that let an ask reach the human is attributable from the log alone (PR #3617
// review). Body-free: the ask's request id, counts, and the stale file only as a digest.
const CODING_RUNTIME_APPROVAL_BASE_CHECKED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.approval.base-checked",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeV2ApprovalRequests.recordBaseCheck",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    requestId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["current", "stale", "denied", "failed", "cancelled"],
    },
    fileCount: { type: "integer", dataClass: "count", required: true },
    checkedFileCount: { type: "integer", dataClass: "count", required: true },
    staleFileSha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-approval-wait"],
  proofIds: ["coding-runtime.approval.base-checked.emitted-line"],
  releaseImpact: "patch",
});

type BaseCheckOutcome = "current" | "stale" | "denied" | "failed" | "cancelled";

interface BaseCheck {
  /** The asked files the governed read could answer for. */
  readonly checkedFileCount: number;
  readonly staleFile?: string | undefined;
  /** The run's live authority no longer admits a read of an asked file. */
  readonly authorityDenied?: boolean | undefined;
}

const BASE_CHECK_ENVELOPES = {
  current: {},
  cancelled: {},
  stale: { level: "warn", errorKind: "conflict" },
  denied: { level: "warn", errorKind: "authority-denied" },
  failed: { level: "warn", errorKind: "internal" },
} as const;

const MAX_PENDING_ASKS = 64;
const ASK_KEYS: readonly string[] = ["action", "runId", "actionId", "properties"];
const EDIT_ASK_KEYS: readonly string[] = [...ASK_KEYS, "baseDigests"];
const EDIT_BASE_KEYS: readonly string[] = ["file", "expectedContentHash"];
// The call id shape the safe-activity settlement accepts (productionOpenCodeBackend.ts).
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTENT_DIGEST = /^[a-f0-9]{64}$/u;
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

function editBase(entry: unknown, askedFile: unknown): EditBase | undefined {
  const base = record(entry);
  if (base === undefined || !exactKeys(base, EDIT_BASE_KEYS)) return undefined;
  const { file, expectedContentHash } = base;
  if (typeof file !== "string" || file !== askedFile) return undefined;
  return typeof expectedContentHash === "string" && CONTENT_DIGEST.test(expectedContentHash)
    ? { file, expectedContentHash }
    : undefined;
}

// One base per asked file, in the ask's own order: a base for a file the human is not asked about,
// or an asked file without one, fails closed.
function editBases(value: unknown, patterns: unknown): readonly EditBase[] | undefined {
  if (!Array.isArray(value) || !Array.isArray(patterns)) return undefined;
  if (value.length === 0 || value.length !== patterns.length) return undefined;
  const bases: EditBase[] = [];
  for (const [index, entry] of value.entries()) {
    const base = editBase(entry, patterns[index]);
    if (base === undefined) return undefined;
    bases.push(base);
  }
  return bases;
}

// The ask body of this run's session that names its own tool call.
function boundAsk(
  value: unknown,
  runId: string,
  sessionId: string,
):
  | {
      readonly body: Readonly<Record<string, unknown>>;
      readonly properties: Readonly<Record<string, unknown>>;
      readonly actionId: string;
    }
  | undefined {
  const body = record(value);
  if (body?.action !== "permission-request" || body.runId !== runId) return undefined;
  const properties = record(body.properties);
  if (properties?.sessionID !== sessionId) return undefined;
  const { actionId } = body;
  return boundActionId(actionId, sessionId, properties.id)
    ? { body, properties, actionId }
    : undefined;
}

function parsedAsk(value: unknown, runId: string, sessionId: string): ParsedAsk | undefined {
  const bound = boundAsk(value, runId, sessionId);
  if (bound === undefined) return undefined;
  const { body, properties, actionId } = bound;
  const edit = record(properties.metadata)?.actionKind === "file-edit";
  if (!exactKeys(body, edit ? EDIT_ASK_KEYS : ASK_KEYS)) return undefined;
  const bases = edit ? editBases(body.baseDigests, properties.patterns) : [];
  if (bases === undefined) return undefined;
  const event = projectOpenCodePermissionEvent(
    { id: properties.id, type: "permission.asked", properties },
    sessionId,
  );
  return event === undefined ? undefined : { event, actionId, bases };
}

// Stops at the first asked file whose governed read no longer reports the changeset's base digest,
// or that the run's authority no longer admits. A file the read cannot answer for (a new file, a
// denied path) is left to the editor route's check. `progress` counts the files checked so far, so
// a check that throws still says how far it got (PR #3617 review).
async function baseCheck(
  bases: readonly EditBase[],
  editBaseDigest: OpenCodeV2EditBaseDigest,
  signal: AbortSignal,
  progress: { checkedFileCount: number },
): Promise<BaseCheck> {
  for (const { file, expectedContentHash } of bases) {
    const current = await editBaseDigest(file, signal);
    if (current.kind === "authority-denied") {
      return { checkedFileCount: progress.checkedFileCount, authorityDenied: true };
    }
    if (current.kind === "unreadable") continue;
    progress.checkedFileCount += 1;
    if (current.digest !== expectedContentHash) {
      return { checkedFileCount: progress.checkedFileCount, staleFile: file };
    }
  }
  return { checkedFileCount: progress.checkedFileCount };
}

// A check that ended with its caller or its registry records the teardown, never a verdict.
function baseCheckOutcome(check: BaseCheck, ended: boolean): BaseCheckOutcome {
  if (ended) return "cancelled";
  if (check.authorityDenied === true) return "denied";
  return check.staleFile === undefined ? "current" : "stale";
}

function baseCheckDecision(
  outcome: BaseCheckOutcome,
  ask: ParsedAsk,
  check: BaseCheck,
): OpenCodeV2ApprovalDecision | undefined {
  if (outcome === "current") return undefined;
  if (outcome === "stale" && check.staleFile !== undefined) {
    return { outcome: "stale", actionId: ask.actionId, staleFile: check.staleFile };
  }
  return { outcome: BASE_CHECK_DECISIONS[outcome], actionId: ask.actionId };
}

const BASE_CHECK_DECISIONS = {
  current: "unavailable",
  stale: "unavailable",
  denied: "authority-denied",
  failed: "unavailable",
  cancelled: "cancelled",
} as const satisfies Readonly<Record<BaseCheckOutcome, OpenCodeV2ApprovalOutcome>>;

function staleFileDigest(file: string): string {
  return createHash("sha256").update("keiko.approval.base-file.v1\0").update(file).digest("hex");
}

function recordBaseCheck(
  activityLog: ServerLogSink | undefined,
  runId: string,
  ask: ParsedAsk,
  outcome: BaseCheckOutcome,
  check: BaseCheck,
): void {
  activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_APPROVAL_BASE_CHECKED_OPERATION,
      { correlationId: correlationIdOrUnknown(runId), ...BASE_CHECK_ENVELOPES[outcome] },
      {
        runId,
        requestId: ask.event.requestId,
        outcome,
        fileCount: ask.bases.length,
        checkedFileCount: check.checkedFileCount,
        ...(outcome === "stale" && check.staleFile !== undefined
          ? { staleFileSha256: staleFileDigest(check.staleFile) }
          : {}),
      },
    ),
  );
}

interface ApprovalSinks {
  readonly diagnostics: ServerDiagnosticSink | undefined;
  readonly activityLog: ServerLogSink | undefined;
}

// A failed base check fails the ask closed: the human is not asked about a change whose base no
// one could verify, nor about one the run's authority no longer admits. A caller that went away, or
// a registry that closed, meanwhile cancels the ask. Every outcome is logged.
async function checkedBase(
  ask: ParsedAsk,
  runId: string,
  editBaseDigest: OpenCodeV2EditBaseDigest,
  signal: AbortSignal,
  context: { readonly sinks: ApprovalSinks; readonly ended: () => boolean },
): Promise<OpenCodeV2ApprovalDecision | undefined> {
  const { diagnostics, activityLog } = context.sinks;
  const progress = { checkedFileCount: 0 };
  try {
    const check = await baseCheck(ask.bases, editBaseDigest, signal, progress);
    const outcome = baseCheckOutcome(check, context.ended());
    recordBaseCheck(activityLog, runId, ask, outcome, check);
    return baseCheckDecision(outcome, ask, check);
  } catch (error) {
    // A read that rejects because its run is being torn down is the teardown, not a failure.
    if (context.ended()) {
      recordBaseCheck(activityLog, runId, ask, "cancelled", progress);
      return { outcome: "cancelled", actionId: ask.actionId };
    }
    recordBaseCheck(activityLog, runId, ask, "failed", progress);
    emitServerDiagnostic(diagnostics, {
      correlationId: runId,
      timestamp: new Date().toISOString(),
      operation: "coding-runtime.opencode-composition",
      source: "opencode.permission",
      errorClass: contentFreeErrorClass(error),
      message: "runtime-turn-failed",
      code: "stage=permission-base-check",
    });
    return { outcome: "unavailable", actionId: ask.actionId };
  }
}

function dispatchPermission(
  runId: string,
  event: SidecarPermissionEvent,
  onPermission: (event: SidecarPermissionEvent) => void,
  settle: (outcome: HumanDecisionOutcome) => void,
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
): Promise<HumanDecisionOutcome> {
  return new Promise<HumanDecisionOutcome>((resolve) => {
    const settle = (outcome: HumanDecisionOutcome): void => {
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

// Only an edit's bases are checked; every other ask reaches the human without a wait. A registry
// closed meanwhile, its run disposed, asks no one: nothing would answer (PR #3617 review).
async function decideAsk(
  state: RegistryState,
  input: ApprovalRequestInput,
  ask: ParsedAsk,
  sinks: ApprovalSinks,
): Promise<OpenCodeV2ApprovalDecision> {
  const { runId, onPermission, signal, editBaseDigest } = input;
  const { actionId, event } = ask;
  if (editBaseDigest !== undefined && ask.bases.length > 0) {
    const ended = (): boolean => signal.aborted || state.closed;
    const refused = await checkedBase(ask, runId, editBaseDigest, signal, { sinks, ended });
    if (refused !== undefined) return refused;
    // Teardown may close the registry after the check returned and before this resumes.
    if (ended()) return { outcome: "cancelled", actionId };
  }
  if (state.pending.size >= MAX_PENDING_ASKS || state.pending.has(event.requestId)) {
    return { outcome: "unavailable", actionId };
  }
  const outcome = await humanDecision(
    state.pending,
    runId,
    event,
    onPermission,
    signal,
    sinks.diagnostics,
  );
  return { outcome, actionId };
}

/** The existing Keiko approval lane owns the decision; V2 plugin tools have no native ask API. */
export function createOpenCodeV2ApprovalRequests(
  diagnostics?: ServerDiagnosticSink,
  activityLog?: ServerLogSink,
): OpenCodeV2ApprovalRequests {
  const state: RegistryState = { pending: new Map<string, Pending>(), closed: false };
  const sinks: ApprovalSinks = { diagnostics, activityLog };
  return {
    request: async (input): Promise<OpenCodeV2ApprovalDecision> => {
      const ask = parsedAsk(input.value, input.runId, input.sessionId);
      if (ask === undefined) return UNAVAILABLE;
      if (input.signal.aborted || state.closed) {
        return { outcome: "cancelled", actionId: ask.actionId };
      }
      return decideAsk(state, input, ask, sinks);
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
