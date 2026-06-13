// Issue #211 — Memory Center detail route.
// Uses a query parameter (`?id=...`) to preserve static export compatibility.

import type { ReactNode } from "react";
import { Suspense } from "react";
import { MemoryDetailClient } from "../../memoriaviva/detail/MemoryDetailClient";

export const metadata = {
  title: "Memory Center Detail — Keiko",
};

export default function MemoryCenterDetailPage(): ReactNode {
  return (
    <main
      className="lk-page"
      aria-label="Memory Center detail"
      style={{ background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}
    >
      <Suspense
        fallback={
          <p role="status" aria-live="polite" className="lk-loading">
            Loading memory...
          </p>
        }
      >
        <MemoryDetailClient basePath="/memory" surfaceLabel="Memory Center" />
      </Suspense>
    </main>
  );
}
