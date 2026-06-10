"use client";

// Issue #211 — Client wrapper that extracts the memory id from useSearchParams
// and renders the existing MemoryDetail component. Lives in detail/ alongside
// page.tsx so the route's Suspense boundary in page.tsx covers the
// useSearchParams call (required by Next.js static export).

import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { MemoryDetail } from "../components/MemoryDetail";

export function MemoryDetailClient(): ReactNode {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  if (id === "") {
    return (
      <p role="status" aria-live="polite" className="lk-loading">
        No memory id supplied.
      </p>
    );
  }
  return <MemoryDetail id={id} />;
}
