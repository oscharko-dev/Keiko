"use client";

// F4 — /local-knowledge/capsule had no error.tsx and no boundary anywhere above CapsuleDetail:
// `<Suspense>` (in capsule-detail-page-body.tsx) only covers the loading fallback, not a thrown
// render error, so an unvalidated persisted job timestamp reaching `.toISOString()` took the
// whole page to a full white page. The read-boundary fix (JobRow's safe date formatting) closes
// that specific cause; this Next.js App Router error boundary is the route-level safety net for
// any OTHER render-time throw in this tree, mirroring the fallback idiom already used by
// WindowBodyBoundary (reuses the same global lk-empty/lk-btn classes — globals.css is SHA-gated,
// #1300 — and must not grow for this).

import { useEffect, type ReactNode } from "react";
import { useLocalKnowledgeTranslate as useTranslate } from "../local-knowledge-i18n";

export default function CapsuleDetailRouteError({
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
    console.warn("[keiko] local-knowledge capsule route crashed", error);
  }, [error]);

  return (
    <main className="lk-page">
      <div className="lk-empty" role="alert" data-route-crashed="local-knowledge-capsule">
        <p className="lk-empty-title">{t("localKnowledge.detail.routeError.title")}</p>
        <p className="lk-empty-body">{t("localKnowledge.detail.routeError.body")}</p>
        <button type="button" className="lk-btn lk-btn-ghost" onClick={reset}>
          {t("localKnowledge.detail.routeError.retry")}
        </button>
      </div>
    </main>
  );
}
