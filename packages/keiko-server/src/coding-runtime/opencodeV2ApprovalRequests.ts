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
  }): Promise<OpenCodeV2ApprovalOutcome>;
  resolve(runId: string, requestId: string, approved: boolean): boolean;
  close(): void;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function projected(
  value: unknown,
  runId: string,
  sessionId: string,
): SidecarPermissionEvent | undefined {
  const body = record(value);
  if (
    body === undefined ||
    Object.keys(body).length !== 3 ||
    body.action !== "permission-request" ||
    body.runId !== runId
  )
    return undefined;
  const properties = record(body.properties);
  if (properties?.sessionID !== sessionId) return undefined;
  return projectOpenCodePermissionEvent(
    {
      id: properties.id,
      type: "permission.asked",
      properties,
    },
    sessionId,
  );
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

/** The existing Keiko approval lane owns the decision; V2 plugin tools have no native ask API. */
export function createOpenCodeV2ApprovalRequests(
  diagnostics?: ServerDiagnosticSink,
): OpenCodeV2ApprovalRequests {
  const pending = new Map<string, Pending>();
  return {
    request: async ({
      value,
      runId,
      sessionId,
      onPermission,
      signal,
    }): Promise<OpenCodeV2ApprovalOutcome> => {
      const event = projected(value, runId, sessionId);
      if (event === undefined || pending.size >= 64 || pending.has(event.requestId)) {
        return "unavailable";
      }
      if (signal.aborted) return "cancelled";
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
