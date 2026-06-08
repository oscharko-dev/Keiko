// Issue #211 — Server Component entry point for the /memoriaviva route.
// MemoriaViva: list view with filters and review queue.
// Static export (ADR-0011 D1): fixed path, no generateStaticParams needed.
// MemoryList uses useSearchParams → must be inside a Suspense boundary.

import type { ReactNode } from "react";
import { Suspense } from "react";
import { MemoryList } from "./components/MemoryList";

export const metadata = {
  title: "MemoriaViva — Keiko",
};

export default function MemoryCenterPage(): ReactNode {
  return (
    <main
      className="lk-page"
      aria-label="MemoriaViva"
      style={{ background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}
    >
      <Suspense
        fallback={
          <p role="status" aria-live="polite" className="lk-loading">
            Loading memories…
          </p>
        }
      >
        <MemoryList />
      </Suspense>
    </main>
  );
}
