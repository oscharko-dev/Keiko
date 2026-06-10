// Issue #197 — Server Component entry point for the /local-knowledge route.
// This page renders the connector graph UI for the Files window → Local Knowledge Connector →
// Knowledge Capsule → Conversation Center pipeline. It passes an initial empty capsule list;
// the ConnectorGraph Client Component hydrates via the BFF on mount.
//
// Static export (ADR-0011 D1): no `generateStaticParams` needed because this is a fixed path
// with no dynamic segments.

import type { ReactNode } from "react";
import { ConnectorGraph } from "./connector-graph";

export const metadata = {
  title: "Local Knowledge — Keiko",
};

export default function LocalKnowledgePage(): ReactNode {
  return (
    <main
      className="local-knowledge-page"
      aria-label="Local Knowledge connector graph"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg)",
        color: "var(--fg)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <ConnectorGraph />
    </main>
  );
}
