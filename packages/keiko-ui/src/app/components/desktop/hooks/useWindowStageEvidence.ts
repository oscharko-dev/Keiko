import { useEffect, useRef } from "react";
import { CLIENT_STAGE_DURATION_MS_MAX } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

// The stages a desktop window passes through before its body is interactive. Each renders a named
// placeholder for the live DOM (`data-window-chunk`, `data-chat-bind`), but a DOM attribute is not
// support evidence: a stalled chunk or bind in a customer run left nothing an exported log could
// tell apart afterwards — chunk loading, session binding and a bound-but-empty body all read the
// same (#3376 review P2). This hook is the body-free evidence for those stages, on the one client
// diagnostic sink (AGENTS.md §8): a `started` line when the placeholder mounts and a
// `settled after Nms` line when it unmounts. A stage that started and never settled is the
// reconstruction of a stall; a chunk that failed to load surfaces separately as a page error.
//
// Every mount carries an opaque per-tab sequence number so two windows of one kind binding at the
// same time stay attributable — `#3 started, #4 started, #4 settled, #3 never settled` names the
// stalled one — without a chat id, window id or title ever leaving the browser. In development,
// React StrictMode mounts effects twice, which shows as `#n started, #n settled after 0ms` followed
// by `#n+1 started`: an artifact of the dev runtime, not a settled stage; the static export does not
// double-invoke.
//
// This IS the routine case, not a failure — every window goes through it — so alongside the
// human-readable `message` (kept for the console, unchanged), each report also carries a structured
// `meta.stageReport`. That is what the server persists, as its own `client.stage.started`/
// `client.stage.settled` lifecycle operation, instead of the failure-shaped `client.diagnostic` the
// free-text message alone used to become (KEIKO-3557: 416 of 449 `client.diagnostic` lines in a live
// log were this evidence, all misclassified warn/unknown and burying the rare real failures).
export type WindowStage =
  "window chunk" | "chat window chunk" | "editor widget chunk" | "files widget chunk" | "chat bind";

let nextStageSequence = 0;

// A stage that watches for a stall and has not settled this long after it started is reported as
// stalled, under its own correlation id, so the log names the stall instead of leaving only a
// `started` line behind (dev CI run 35438847738: a WebKit network process crash lost a window
// chunk's request, and the window waited on "Loading…" until the journey timed out).
export const WINDOW_STAGE_STALL_MS = 10_000;

function reportStageStall(stage: WindowStage, token: number, correlationId: string): void {
  // i18n-exempt: body-free diagnostic message for the activity log, never rendered
  reportClientDiagnostic(
    `desktop ${stage} #${String(token)}: stalled after ${String(WINDOW_STAGE_STALL_MS)}ms`,
    { correlationId, errorKind: "timeout" },
  );
}

// Monotonic, so a wall-clock step between mount and cleanup can never yield a negative duration,
// and bounded to the contract's ceiling, so a tab left open for days still settles its stage
// instead of sending a report the server must refuse, which would leave a false stall (#3557 review).
function elapsedStageMs(startedAt: number): number {
  const elapsed = Math.round(performance.now() - startedAt);
  return Math.min(Math.max(elapsed, 0), CLIENT_STAGE_DURATION_MS_MAX);
}

/**
 * Reports a stage's start and settlement. A caller that passes `onStall` also learns when the stage
 * has not settled after WINDOW_STAGE_STALL_MS; the stall is reported once, under the stage's id.
 */
export function useWindowStageEvidence(
  stage: WindowStage,
  onStall?: (stalled: boolean) => void,
): void {
  const sequence = useRef<number | undefined>(undefined);
  useEffect((): (() => void) => {
    nextStageSequence += 1;
    const token = nextStageSequence;
    sequence.current = token;
    // One id for the whole mounted stage: `started` and `settled` join in the log even when
    // another tab reuses the same stage and ordinal (#3557 review).
    const correlationId = newClientCorrelationId();
    const startedAt = performance.now();
    // i18n-exempt: body-free diagnostic message for the activity log, never rendered
    reportClientDiagnostic(`desktop ${stage} #${String(token)}: started`, {
      correlationId,
      stageReport: { stage, phase: "started", ordinal: token },
    });
    const stall =
      onStall === undefined
        ? undefined
        : setTimeout((): void => {
            reportStageStall(stage, token, correlationId);
            onStall(true);
          }, WINDOW_STAGE_STALL_MS);
    return (): void => {
      if (stall !== undefined) clearTimeout(stall);
      const durationMs = elapsedStageMs(startedAt);
      // i18n-exempt: body-free diagnostic message for the activity log, never rendered
      reportClientDiagnostic(
        `desktop ${stage} #${String(token)}: settled after ${String(durationMs)}ms`,
        {
          correlationId,
          stageReport: { stage, phase: "settled", ordinal: token, durationMs },
        },
      );
    };
  }, [onStall, stage]);
}
