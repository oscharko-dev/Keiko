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
 * `stale`: a changeset's base digest no longer matched its file, so no human was asked (#3612).
 */
export type OpenCodeV2ApprovalOutcome =
  "approved" | "denied" | "expired" | "cancelled" | "unavailable" | "stale";

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

/** The digest a governed read of the file reports now, or undefined when it cannot say. */
export type OpenCodeV2EditBaseDigest = (
  relativePath: string,
  signal: AbortSignal,
) => Promise<string | undefined>;

/** How a human decision ended; a stale base never reaches one. */
type HumanDecisionOutcome = Exclude<OpenCodeV2ApprovalOutcome, "stale">;

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

// The first asked file whose governed read no longer reports the changeset's base digest. A file
// the read cannot answer for (a new file, a denied path) is left to the editor route's check.
async function staleBaseFile(
  bases: readonly EditBase[],
  editBaseDigest: OpenCodeV2EditBaseDigest,
  signal: AbortSignal,
): Promise<string | undefined> {
  for (const { file, expectedContentHash } of bases) {
    const current = await editBaseDigest(file, signal);
    if (current !== undefined && current !== expectedContentHash) return file;
  }
  return undefined;
}

// A failed base check fails the ask closed: the human is not asked about a change whose base no
// one could verify. A caller that went away meanwhile cancels the ask.
async function checkedBase(
  ask: ParsedAsk,
  runId: string,
  editBaseDigest: OpenCodeV2EditBaseDigest,
  signal: AbortSignal,
  diagnostics: ServerDiagnosticSink | undefined,
): Promise<OpenCodeV2ApprovalDecision | undefined> {
  try {
    const staleFile = await staleBaseFile(ask.bases, editBaseDigest, signal);
    if (signal.aborted) return { outcome: "cancelled", actionId: ask.actionId };
    return staleFile === undefined
      ? undefined
      : { outcome: "stale", actionId: ask.actionId, staleFile };
  } catch (error) {
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

/** The existing Keiko approval lane owns the decision; V2 plugin tools have no native ask API. */
export function createOpenCodeV2ApprovalRequests(
  diagnostics?: ServerDiagnosticSink,
): OpenCodeV2ApprovalRequests {
  const pending = new Map<string, Pending>();
  return {
    request: async (input): Promise<OpenCodeV2ApprovalDecision> => {
      const { runId, onPermission, signal } = input;
      const ask = parsedAsk(input.value, runId, input.sessionId);
      if (ask === undefined) return UNAVAILABLE;
      const { actionId, event } = ask;
      if (signal.aborted) return { outcome: "cancelled", actionId };
      // Only an edit's bases are checked; every other ask reaches the human without a wait.
      const { editBaseDigest } = input;
      if (editBaseDigest !== undefined && ask.bases.length > 0) {
        const refused = await checkedBase(ask, runId, editBaseDigest, signal, diagnostics);
        if (refused !== undefined) return refused;
      }
      if (pending.size >= MAX_PENDING_ASKS || pending.has(event.requestId)) {
        return { outcome: "unavailable", actionId };
      }
      const outcome = await humanDecision(pending, runId, event, onPermission, signal, diagnostics);
      return { outcome, actionId };
    },
    resolve: (runId, requestId, approved): boolean => {
      const item = pending.get(requestId);
      if (item?.runId !== runId) return false;
      item.resolve(approved ? "approved" : "denied");
      return true;
    },
    close: (): void => {
      for (const item of pending.values()) item.resolve("cancelled");
      pending.clear();
    },
  };
}
