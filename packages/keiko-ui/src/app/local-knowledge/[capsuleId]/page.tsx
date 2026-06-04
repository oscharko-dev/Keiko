// Issue #198 — Server Component entry point for /local-knowledge/[capsuleId].
// Static export (ADR-0011 D1): no dynamic routes at runtime. The capsuleId
// segment is treated as a client-side query that the Client Component reads
// via next/navigation's useParams(). generateStaticParams is not required
// because static export resolves dynamic segments as client-only routes.

import type { ReactNode } from "react";
import { CapsuleDetail } from "./capsule-detail";

export const metadata = {
  title: "Capsule Detail — Keiko",
};

export default function CapsuleDetailPage(): ReactNode {
  return (
    <main className="lk-page" aria-label="Capsule detail">
      <CapsuleDetail />
    </main>
  );
}
