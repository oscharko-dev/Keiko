"use client";

// #3532 — the page had no `window` error listener: an exception thrown outside React's render tree
// (an event handler, a timer, a lazily loaded widget's script) reached the browser's own console
// and nothing else. This reports the first few per session through the one client diagnostic sink
// with the closed kind `window-error` — the error's CLASS only, never its message or stack — and
// counts every further one as suppressed loss, so a storm is bounded without disappearing.
// Lives in its own module for the same reason as `useUnhandledRejectionLog`: the shell's test
// suites mock sibling component files wholesale.

import { useEffect } from "react";
import { isBenignWindowNotification } from "@/lib/benign-browser-error";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { recordClientDiagnosticLoss, reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";

const MAX_LOGGED_WINDOW_ERRORS = 5;

export function useWindowErrorLog(): void {
  useEffect(() => {
    let logged = 0;
    const onError = (event: ErrorEvent): void => {
      if (isBenignWindowNotification(event)) return;
      if (logged >= MAX_LOGGED_WINDOW_ERRORS) {
        recordClientDiagnosticLoss("errorsSuppressed");
        return;
      }
      logged += 1;
      reportClientDiagnostic(`[keiko] uncaught window error: ${clientErrorSummary(event.error)}`, {
        kind: "window-error",
        globalFailure: true,
        errorEvidence: clientErrorEvidence(event.error),
        correlationId: correlationIdOf(event.error) ?? crypto.randomUUID(),
      });
    };
    window.addEventListener("error", onError);
    return (): void => {
      window.removeEventListener("error", onError);
    };
  }, []);
}
