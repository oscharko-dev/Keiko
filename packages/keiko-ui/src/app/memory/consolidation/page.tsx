import type { ReactNode } from "react";
import { MemoryConsolidation } from "../components/MemoryConsolidation";

export const metadata = {
  title: "Memory Consolidation — Keiko",
};

export default function MemoryConsolidationPage(): ReactNode {
  return (
    <main
      className="lk-page"
      aria-label="Memory consolidation"
      style={{ background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-ui)" }}
    >
      <MemoryConsolidation />
    </main>
  );
}
