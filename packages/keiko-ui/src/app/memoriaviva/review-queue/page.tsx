// Issue #211 — Server Component entry for /memoriaviva/review-queue.
// Shows proposed and conflicted memories awaiting user action.
// Static export (ADR-0011 D1): fixed path, no generateStaticParams needed.

import type { ReactNode } from "react";
import { ReviewQueue } from "../components/ReviewQueue";

export const metadata = {
  title: "MemoriaViva Review Queue — Keiko",
};

export default function MemoryReviewQueuePage(): ReactNode {
  return (
    <main
      className="lk-page"
      aria-label="MemoriaViva review queue"
      style={{ background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}
    >
      <ReviewQueue />
    </main>
  );
}
