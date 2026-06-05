// Issue #211 — Server Component entry for the /memory/detail route.
// Memory Center: detail view for a single memory record. Uses a query-parameter
// route (`?id=...`) instead of a Next.js dynamic segment because the UI ships
// as a static export (ADR-0011 D1) and dynamic segments require a non-empty
// generateStaticParams set — which we cannot enumerate at build time. The
// MemoryDetailClient extracts `id` from useSearchParams and fetches client-side.

import type { ReactNode } from "react";
import { Suspense } from "react";
import { MemoryDetailClient } from "./MemoryDetailClient";

export const metadata = {
  title: "Memory Detail — Keiko",
};

export default function MemoryDetailPage(): ReactNode {
  return (
    <main
      className="lk-page"
      aria-label="Memory detail"
      style={{ background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}
    >
      <Suspense
        fallback={
          <p role="status" aria-live="polite" className="lk-loading">
            Loading memory…
          </p>
        }
      >
        <MemoryDetailClient />
      </Suspense>
    </main>
  );
}
