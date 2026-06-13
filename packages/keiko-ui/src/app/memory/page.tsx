// Issue #211 — first-class Memory Center route.
// Reuses the governed Memory Center implementation while preserving the
// existing /memoriaviva compatibility route.

import type { ReactNode } from "react";
import { Suspense } from "react";
import { MemoryList } from "../memoriaviva/components/MemoryList";

export const metadata = {
  title: "Memory Center — Keiko",
};

export default function MemoryCenterPage(): ReactNode {
  return (
    <main
      className="lk-page"
      aria-label="Memory Center"
      style={{ background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}
    >
      <Suspense
        fallback={
          <p role="status" aria-live="polite" className="lk-loading">
            Loading memories...
          </p>
        }
      >
        <MemoryList basePath="/memory" surfaceLabel="Memory Center" />
      </Suspense>
    </main>
  );
}
