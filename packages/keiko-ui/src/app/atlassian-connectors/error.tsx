"use client";

// F3 — /atlassian-connectors had no error.tsx and no boundary anywhere above
// AtlassianConnectorsApp: an unvalidated persisted connector record (e.g. a malformed
// `createdAt`) threw during render with nothing to catch it, taking the whole route down to a
// full white page. The read-boundary fix (ConnectorCard's safe date formatting) closes that
// specific cause; this Next.js App Router error boundary is the route-level safety net for any
// OTHER render-time throw in this tree, mirroring the fallback idiom already used by
// WindowBodyBoundary (reuses the same global lk-empty/lk-btn classes — globals.css is SHA-gated,
// #1300 — and must not grow for this).

import { useEffect, type ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

export default function AtlassianConnectorsRouteError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): ReactNode {
  const t = useTranslate();

  useEffect(() => {
    // Same observable-not-silent idiom as WindowBodyBoundary/AppShellBoundary: the crash must
    // stay diagnosable from the console even though the UI only shows the recovery surface.
    reportClientDiagnostic(
      `[keiko] atlassian-connectors route crashed: ${clientErrorSummary(error)}`,
      { correlationId: correlationIdOf(error) },
    );
  }, [error]);

  return (
    <main className="lk-page">
      <div className="lk-empty" role="alert" data-route-crashed="atlassian-connectors">
        <p className="lk-empty-title">{t("atlassianConnectors.routeError.title")}</p>
        <p className="lk-empty-body">{t("atlassianConnectors.routeError.body")}</p>
        <button type="button" className="lk-btn lk-btn-ghost" onClick={reset}>
          {t("atlassianConnectors.routeError.retry")}
        </button>
      </div>
    </main>
  );
}
