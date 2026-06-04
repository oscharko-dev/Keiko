// Issue #198 — Server Component entry point for /local-knowledge/capsule.
// Static export (ADR-0011 D1): the selected capsule is addressed by the
// client-side `?capsuleId=` query, not by a dynamic path segment, so Next can
// emit this route as a normal static page under `output: "export"`.

import { Suspense, type ReactNode } from "react";
import { CapsuleDetail } from "../[capsuleId]/capsule-detail";

export const metadata = {
  title: "Capsule Detail — Keiko",
};

export default function CapsuleDetailPage(): ReactNode {
  return (
    <main className="lk-page" aria-label="Capsule detail">
      <Suspense
        fallback={
          <p role="status" aria-live="polite" className="lk-loading">
            Loading capsule…
          </p>
        }
      >
        <CapsuleDetail />
      </Suspense>
    </main>
  );
}
