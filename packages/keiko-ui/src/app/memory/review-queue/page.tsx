// Issue #211 — Memory Center review queue route.

import type { ReactNode } from "react";
import { ReviewQueue } from "../../memoriaviva/components/ReviewQueue";

export const metadata = {
  title: "Memory Center Review Queue — Keiko",
};

export default function MemoryCenterReviewQueuePage(): ReactNode {
  return (
    <main
      className="lk-page"
      aria-label="Memory Center review queue"
      style={{ background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}
    >
      <ReviewQueue basePath="/memory" surfaceLabel="Memory Center" />
    </main>
  );
}
