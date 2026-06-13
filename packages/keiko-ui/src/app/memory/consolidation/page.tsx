// Issue #211 — Memory Center consolidation route.
// Included because the Memory Center list exposes consolidation as a governed
// review-support action for stale and conflicting memories.

import type { ReactNode } from "react";
import { MemoryConsolidation } from "../../memoriaviva/components/MemoryConsolidation";

export const metadata = {
  title: "Memory Center Consolidation — Keiko",
};

export default function MemoryCenterConsolidationPage(): ReactNode {
  return (
    <main
      className="lk-page"
      aria-label="Memory Center consolidation"
      style={{ background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}
    >
      <MemoryConsolidation basePath="/memory" surfaceLabel="Memory Center" />
    </main>
  );
}
