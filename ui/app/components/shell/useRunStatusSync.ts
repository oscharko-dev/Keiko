/**
 * Issue #66 — useRunStatusSync.
 *
 * For a system run-summary message whose persisted workflowStatus is non-terminal, polls the
 * BFF until the run reaches a terminal state, PATCHes the message row, and notifies the parent
 * via onPatched. On `/api/runs/:runId` 404 it falls back to the persistent evidence manifest;
 * if both 404, it surfaces an `unavailable` flag (presentation-only — the DB row is unchanged).
 *
 * Why polling, not SSE: the chat shows the terminal status + redacted shortResult only, never
 * the event stream. GET /api/runs/:runId cleanly returns either `{report:{status:"running"}}`
 * or the terminal report; polling is the smaller, lower-risk surface (D3).
 *
 * Cadence: 1500ms baseline, 6000ms after 60s of continuous running. Stops on terminal, unmount,
 * or unavailable. A `cancelled` flag in the effect closure is the single source of truth for
 * "should this loop keep running?" — it gates every state mutation after an await so a slow
 * fetch cannot PATCH after the component unmounts.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError, fetchEvidenceManifest, fetchRunReport, patchChatMessage } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";
import { classifyRunReport, formatRunSummaryFromManifest } from "@/lib/run-summary";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const BASE_INTERVAL_MS = 1500;
const BACKOFF_INTERVAL_MS = 6000;
const BACKOFF_AFTER_MS = 60_000;

export interface RunStatusSyncResult {
  readonly unavailable: boolean;
}

interface FallbackKind {
  readonly workflowId?: string;
  readonly taskType?: string;
}

function isTerminal(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.has(status);
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function logSyncError(scope: string, error: unknown): void {
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.error(`[useRunStatusSync ${scope}]`, error);
  }
}

export function useRunStatusSync(
  message: ChatMessage,
  projectPath: string,
  onPatched: (m: ChatMessage) => void,
): RunStatusSyncResult {
  const [unavailable, setUnavailable] = useState(false);
  // Pin the latest onPatched in a ref so the effect closure stays stable across re-renders.
  const onPatchedRef = useRef(onPatched);
  onPatchedRef.current = onPatched;

  const runId = message.runId;
  const persistedStatus = message.workflowStatus;
  const messageId = message.id;
  // FallbackKind is read by both the report and manifest branches; pulling primitives into the
  // dep array keeps the effect stable across renders that change unrelated message fields.
  const workflowId = message.workflowId;
  const taskType = message.taskType;

  useEffect(() => {
    setUnavailable(false);
    if (runId === undefined || isTerminal(persistedStatus)) {
      return undefined;
    }
    // Pin runId for the async closures so TS retains the narrowed `string` type after awaits.
    const activeRunId: string = runId;

    // The cancelled flag is the single source of truth for loop termination. fetchJson does not
    // expose an AbortSignal at this surface, so a fetch in flight at unmount-time still
    // resolves; the flag gates every state mutation that follows.
    let cancelled = false;
    const startedAt = Date.now();
    let intervalId: ReturnType<typeof setTimeout> | undefined;
    const fallbackKind: FallbackKind = {
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(taskType !== undefined ? { taskType } : {}),
    };

    function scheduleNext(): void {
      if (cancelled) return;
      const interval =
        Date.now() - startedAt >= BACKOFF_AFTER_MS ? BACKOFF_INTERVAL_MS : BASE_INTERVAL_MS;
      intervalId = setTimeout(() => {
        void tick();
      }, interval);
    }

    async function applyTerminal(
      workflowStatus: "completed" | "failed" | "cancelled",
      shortResult: string,
    ): Promise<void> {
      try {
        const result = await patchChatMessage(
          messageId,
          message.chatId,
          projectPath,
          { workflowStatus, shortResult },
        );
        if (!cancelled) onPatchedRef.current(result.message);
      } catch (error) {
        // A transient PATCH failure (5xx, network blip) must not strand the row in a
        // non-terminal status — without rescheduling, the loop stops and reload becomes the
        // only recovery. scheduleNext() honours `cancelled`, so unmount still cleans up.
        logSyncError("patch", error);
        scheduleNext();
      }
    }

    async function pollManifest(): Promise<void> {
      try {
        const { manifest } = await fetchEvidenceManifest(activeRunId);
        if (cancelled) return;
        const summary = formatRunSummaryFromManifest(manifest, fallbackKind);
        if (
          summary.workflowStatus === "completed" ||
          summary.workflowStatus === "failed" ||
          summary.workflowStatus === "cancelled"
        ) {
          await applyTerminal(summary.workflowStatus, summary.shortResult);
        } else {
          // Manifest should always be terminal; defensive fall-through schedules another tick.
          scheduleNext();
        }
      } catch (error) {
        if (cancelled) return;
        if (isNotFound(error)) {
          setUnavailable(true);
          return;
        }
        logSyncError("manifest", error);
        scheduleNext();
      }
    }

    async function tick(): Promise<void> {
      if (cancelled) return;
      try {
        const { report } = await fetchRunReport(activeRunId);
        if (cancelled) return;
        const outcome = classifyRunReport(report, fallbackKind);
        if (outcome.kind === "terminal") {
          await applyTerminal(outcome.summary.workflowStatus, outcome.summary.shortResult);
        } else {
          // running OR unknown — keep polling. An unknown-shape response (no recognisable
          // status field) MUST NOT be treated as a terminal completion: doing so would mark
          // a still-running row as completed on a malformed BFF response (self-critique #3).
          scheduleNext();
        }
      } catch (error) {
        if (cancelled) return;
        if (isNotFound(error)) {
          await pollManifest();
          return;
        }
        logSyncError("report", error);
        scheduleNext();
      }
    }

    void tick();

    return (): void => {
      cancelled = true;
      if (intervalId !== undefined) clearTimeout(intervalId);
    };
  }, [runId, persistedStatus, messageId, workflowId, taskType, message.chatId, projectPath]);

  return { unavailable };
}
