import { useEffect, useRef } from "react";
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
export type WindowStage =
  "window chunk" | "chat window chunk" | "editor widget chunk" | "files widget chunk" | "chat bind";

let nextStageSequence = 0;

export function useWindowStageEvidence(stage: WindowStage): void {
  const sequence = useRef<number | undefined>(undefined);
  useEffect((): (() => void) => {
    nextStageSequence += 1;
    const token = nextStageSequence;
    sequence.current = token;
    const startedAt = Date.now();
    // i18n-exempt: body-free diagnostic message for the activity log, never rendered
    reportClientDiagnostic(`desktop ${stage} #${String(token)}: started`);
    return (): void => {
      // i18n-exempt: body-free diagnostic message for the activity log, never rendered
      reportClientDiagnostic(
        `desktop ${stage} #${String(token)}: settled after ${String(Date.now() - startedAt)}ms`,
      );
    };
  }, [stage]);
}
