// Issue #280 (Epic #270) — Server Component entry point for the /quality-intelligence route.
// Scaffolds the native Quality Intelligence UI surface as a static export page (ADR-0011 D1).
// The client component handles data fetching via BFF routes added in M2.
// Static export: no `generateStaticParams` needed — fixed path, no dynamic segments.

import type { ReactNode } from "react";
import { Suspense } from "react";
import { QualityIntelligencePanel } from "./QualityIntelligencePanel";

export const metadata = {
  title: "Quality Intelligence — Keiko",
};

export default function QualityIntelligencePage(): ReactNode {
  return (
    <main
      className="lk-page"
      aria-label="Quality Intelligence"
      style={{ background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}
    >
      <Suspense
        fallback={
          <p role="status" aria-live="polite" className="lk-loading">
            Loading Quality Intelligence…
          </p>
        }
      >
        <QualityIntelligencePanel />
      </Suspense>
    </main>
  );
}
