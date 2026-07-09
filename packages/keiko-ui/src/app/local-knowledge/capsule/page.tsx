// Issue #198 — Server Component entry point for /local-knowledge/capsule.
// Static export (ADR-0011 D1): the selected capsule is addressed by the
// client-side `?capsuleId=` query, not by a dynamic path segment, so Next can
// emit this route as a normal static page under `output: "export"`.

import type { ReactNode } from "react";

import { CapsuleDetailPageBody } from "./capsule-detail-page-body";

export const metadata = {
  title: "Knowledge Pod Detail — Keiko",
};

export default function CapsuleDetailPage(): ReactNode {
  return <CapsuleDetailPageBody />;
}
