// Read-authority guard for content-bearing Code routes (ADR-0141 D2, #2478 W1.5).
//
// A route handler that serves (or mutates) content calls this before ANY runId or runtime
// resolution. No authority means the caller must return its constant content-free projection —
// for reads — or the existence-concealing not-found result — for question mutations — without
// touching run-derived state, so an unpaired probe can never distinguish "not paired" from "does
// not exist" (ADR-0141 D6). The W1.6–W1.9 content surfaces (transcript, plan, tool activity,
// diffs) join by calling this same guard; no re-plumbing is required.

import type { IncomingMessage } from "node:http";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { processServerLogSink } from "../process-log-sink.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { UiHandlerDeps } from "../deps.js";
import { readSessionCookie } from "./sessionCookie.js";
import type { AppSession } from "./sessionRegistry.js";

/**
 * Resolve the request's app-session read authority, or `undefined` for every request that does not
 * present a valid session cookie. Fail-closed by construction: an absent channel (no composition)
 * grants nothing, exactly like an absent pairing port grants no session (ADR-0141 D2).
 */
export function resolveAppSessionReadAuthority(
  deps: Pick<UiHandlerDeps, "codingAppSessionChannel">,
  req: IncomingMessage,
): AppSession | undefined {
  return deps.codingAppSessionChannel?.verifySession(readSessionCookie(req));
}

const SESSION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-app-session.operation.state",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "coding-app-session.appSessionReadAuthority.logOperationState",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["acquired", "released"],
    },
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["grounded-chat", "desktop-chat", "streaming-chat", "git-description", "unspecified"],
    },
    releaseReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["settled", "aborted"],
    },
    concurrentOperations: { type: "integer", dataClass: "count", required: false },
    authorityState: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["active", "unavailable", "unobserved"],
    },
    durationMs: { type: "integer", dataClass: "duration", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-app-session-pairing"],
  proofIds: ["coding-app-session.operation.state.line"],
  releaseImpact: "patch",
});
interface OperationContext {
  readonly correlationId?: string | undefined;
  readonly surface?: "grounded-chat" | "desktop-chat" | "streaming-chat" | "git-description";
}
type OperationDeps = Pick<UiHandlerDeps, "codingAppSessionChannel" | "activityLog">;
function operationAuthorityState(
  observed: boolean,
  concurrentOperations: number | undefined,
): "active" | "unavailable" | "unobserved" {
  if (!observed) return "unobserved";
  return concurrentOperations === undefined ? "unavailable" : "active";
}
function logOperationState(
  deps: OperationDeps,
  token: string | undefined,
  context: OperationContext,
  phase: "acquired" | "released",
  durationMs: number,
  releaseReason?: "settled" | "aborted",
): void {
  const inspect = deps.codingAppSessionChannel?.inspectOperationCount;
  const concurrentOperations = inspect?.(token);
  const authorityState = operationAuthorityState(inspect !== undefined, concurrentOperations);
  const event = activityLogEvent(
    SESSION_OPERATION,
    { correlationId: context.correlationId ?? UNKNOWN_CORRELATION_ID, level: "info" },
    {
      phase,
      surface: context.surface ?? "unspecified",
      authorityState,
      durationMs,
      ...(concurrentOperations === undefined ? {} : { concurrentOperations }),
      ...(releaseReason === undefined ? {} : { releaseReason }),
      completeness: "complete",
      loss: "none",
    },
  );
  const fallbackSink = processServerLogSink();
  try {
    (deps.activityLog ?? fallbackSink).write(event);
  } catch {
    // The process logger safely delivers the same body-free state if an injected port fails.
    fallbackSink.write(event);
  }
}
/** Keep a valid existing session active only for this explicit request, including cancellation. */
export function beginAppSessionOperation(
  deps: OperationDeps,
  req: IncomingMessage | undefined,
  signal: AbortSignal,
  context: OperationContext = {},
): () => void {
  if (req === undefined || deps.codingAppSessionChannel === undefined) return (): void => undefined;
  const token = readSessionCookie(req);
  const release = deps.codingAppSessionChannel.beginOperation(token);
  if (release === undefined) return (): void => undefined;
  const startedAt = performance.now();
  let released = false;
  const settle = (): void => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", settle);
    try {
      release();
    } finally {
      logOperationState(
        deps,
        token,
        context,
        "released",
        Math.max(0, Math.round(performance.now() - startedAt)),
        signal.aborted ? "aborted" : "settled",
      );
    }
  };
  let logged = false;
  try {
    logOperationState(deps, token, context, "acquired", 0);
    logged = true;
  } finally {
    if (!logged) release();
  }
  if (signal.aborted) settle();
  else signal.addEventListener("abort", settle, { once: true });
  return settle;
}
