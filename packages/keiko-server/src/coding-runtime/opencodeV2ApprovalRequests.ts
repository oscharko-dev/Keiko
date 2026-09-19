import { GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS } from "@oscharko-dev/keiko-contracts/runtime/tools";

import type { SidecarPermissionEvent } from "./codingSidecarEventParser.js";
import { projectOpenCodePermissionEvent } from "./opencodeProtocol.js";

interface Pending {
  readonly runId: string;
  readonly resolve: (approved: boolean) => void;
}

export interface OpenCodeV2ApprovalRequests {
  request(input: {
    readonly value: unknown;
    readonly runId: string;
    readonly sessionId: string;
    readonly onPermission: (event: SidecarPermissionEvent) => void;
    readonly signal: AbortSignal;
  }): Promise<boolean>;
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

/** The existing Keiko approval lane owns the decision; V2 plugin tools have no native ask API. */
export function createOpenCodeV2ApprovalRequests(): OpenCodeV2ApprovalRequests {
  const pending = new Map<string, Pending>();
  return {
    request: async ({ value, runId, sessionId, onPermission, signal }): Promise<boolean> => {
      const event = projected(value, runId, sessionId);
      if (
        event === undefined ||
        pending.size >= 64 ||
        pending.has(event.requestId) ||
        signal.aborted
      ) {
        return false;
      }
      return new Promise<boolean>((resolve) => {
        const settle = (approved: boolean): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          pending.delete(event.requestId);
          resolve(approved);
        };
        const onAbort = (): void => {
          settle(false);
        };
        const timer = setTimeout(() => {
          settle(false);
        }, GOVERNED_TOOL_HUMAN_DECISION_WAIT_MS);
        timer.unref();
        pending.set(event.requestId, { runId, resolve: settle });
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          onPermission(event);
        } catch {
          settle(false);
        }
      });
    },
    resolve: (runId, requestId, approved): boolean => {
      const item = pending.get(requestId);
      if (item?.runId !== runId) return false;
      item.resolve(approved);
      return true;
    },
    close: (): void => {
      for (const item of pending.values()) item.resolve(false);
      pending.clear();
    },
  };
}
