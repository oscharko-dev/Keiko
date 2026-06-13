"use client";

// Issue #211 — Client wrapper that extracts the memory id from useSearchParams
// and renders the existing MemoryDetail component. Lives in detail/ alongside
// page.tsx so the route's Suspense boundary in page.tsx covers the
// useSearchParams call (required by Next.js static export).

import type { ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MemoryDetail } from "../components/MemoryDetail";

export function MemoryDetailClient(): ReactNode {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  if (id === "") {
    // Permanent empty state, not a transient status (uiux-fix F005 C066):
    // a stale deep link without ?id= must offer a way back to the list
    // instead of a loading-styled dead end.
    return (
      <div className="lk-empty">
        <div>
          <p className="lk-empty-title">No memory selected</p>
          <p className="lk-empty-body">
            This link is missing a memory id. Open a memory from the list instead.
          </p>
          <p>
            <Link href="/memoriaviva" className="lk-btn lk-btn-ghost">
              Back to MemoriaViva
            </Link>
          </p>
        </div>
      </div>
    );
  }
  return <MemoryDetail id={id} />;
}
