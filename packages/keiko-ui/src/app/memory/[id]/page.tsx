// Issue #211 — Server Component entry point for the /memory/:id route.
// Memory Center: detail view for a single memory record.
// Static export (ADR-0011 D1): generateStaticParams returns [] to satisfy Next.js
// static export requirement for dynamic segments — the actual data is fetched
// client-side by MemoryDetail on mount.

import type { ReactNode } from "react";
import { Suspense } from "react";
import { MemoryDetail } from "../components/MemoryDetail";

export const metadata = {
  title: "Memory Detail — Keiko",
};

// Required by Next.js static export for dynamic routes.
export function generateStaticParams(): readonly Record<string, string>[] {
  return [];
}

export default function MemoryDetailPage({
  params,
}: {
  readonly params: { readonly id: string };
}): ReactNode {
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
        <MemoryDetail id={params.id} />
      </Suspense>
    </main>
  );
}
