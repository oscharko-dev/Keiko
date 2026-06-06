// Issue #540 (Epic #532) — Relationships route page.
//
// Next.js App Router static-export page. The interactive surface is a Client Component
// (`RelationshipsView`) that reads URL search params via `useSearchParams()`.
// `<Suspense>` boundary is REQUIRED around any component using useSearchParams() under
// Next.js static export (memory #64 trap).
//
// URL state model (visual-density-rules.md §"URL state"):
//   ?relType=       – RelationshipType filter
//   ?relLifecycle=  – RelationshipLifecycleState filter
//   ?relActivity=   – RelationshipActivityState filter
//   ?relSrcKind=    – source ObjectKind filter
//   ?relTgtKind=    – target ObjectKind filter
//   ?relDensity=    – "minimal" | "standard" | "dense"
//   ?relFocus=      – focused relationship id
//
// WCAG 2.2 AA throughout (focus-visible rings, 24×24 touch targets, aria-live).
// No new third-party dependency. No new @keyframes. No new CSS variables.

import type { ReactNode } from "react";
import { Suspense } from "react";
import { RelationshipsView } from "./RelationshipsView";

// ─── Loading skeleton ──────────────────────────────────────────────────────────
// Shown while the Client Component shell hydrates. Reuses existing CSS variables only.

function RelationshipsLoadingSkeleton(): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--fg-muted)",
        fontSize: 13,
      }}
      aria-busy="true"
      aria-label="Loading relationships"
    >
      Loading…
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RelationshipsPage(): ReactNode {
  return (
    <Suspense fallback={<RelationshipsLoadingSkeleton />}>
      <RelationshipsView />
    </Suspense>
  );
}
