"use client";

// GEN-STAB-WINDOW-002 — the desktop shell had no unhandledrejection listener: an async
// failure that escaped every catch (a fetch settling after its window closed, a defect
// in a lazily-loaded widget's background work) vanished into the void, and long sessions
// degraded with zero operator-visible signal. This surfaces the first few per session
// through the same console idiom AppShell already uses; the cap keeps a rejection storm
// (e.g. a poll loop failing every tick while the BFF restarts) from flooding the console.
// Every rejection past the cap is counted as suppressed loss (#3532), and the report carries the
// closed kind `unhandled-rejection`. Installed once for every route by the root layout's
// `ClientDiagnosticsRoot`. Lives in its own module — AppShell's test suite mocks sibling component
// files wholesale, and shared hooks must not ride inside them (see hooks/useLinkRevision.ts).

import { useEffect } from "react";
import { recordClientDiagnosticLoss, reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";

const MAX_LOGGED_REJECTIONS = 5;

export function useUnhandledRejectionLog(): void {
  useEffect(() => {
    let logged = 0;
    const onRejection = (event: PromiseRejectionEvent): void => {
      if (logged >= MAX_LOGGED_REJECTIONS) {
        recordClientDiagnosticLoss("rejectionsSuppressed");
        return;
      }
      logged += 1;
      reportClientDiagnostic(
        `[keiko] unhandled promise rejection: ${clientErrorSummary(event.reason)}`,
        { correlationId: correlationIdOf(event.reason), kind: "unhandled-rejection" },
      );
    };
    window.addEventListener("unhandledrejection", onRejection);
    return (): void => {
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
}
