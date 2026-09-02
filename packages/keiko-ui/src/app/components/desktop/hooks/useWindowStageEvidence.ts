import { useEffect } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

// The stages a desktop window passes through before its body is interactive. Each renders a named
// placeholder for the live DOM (`data-window-chunk`, `data-chat-bind`), but a DOM attribute is not
// support evidence: a stalled chunk or bind in a customer run left nothing an exported log could
// tell apart afterwards — chunk loading, session binding and a bound-but-empty body all read the
// same (#3376 review P2). This hook is the body-free evidence for those stages, on the one client
// diagnostic sink (AGENTS.md §8): a `started` line when the placeholder mounts and a
// `settled after Nms` line when it unmounts. A stage that started and never settled is the
// reconstruction of a stall; a chunk that failed to load surfaces separately as a page error.
export type WindowStage =
  "window chunk" | "chat window chunk" | "editor widget chunk" | "files widget chunk" | "chat bind";

export function useWindowStageEvidence(stage: WindowStage): void {
  useEffect((): (() => void) => {
    const startedAt = Date.now();
    reportClientDiagnostic(`desktop ${stage}: started`);
    return (): void => {
      reportClientDiagnostic(`desktop ${stage}: settled after ${String(Date.now() - startedAt)}ms`);
    };
  }, [stage]);
}
