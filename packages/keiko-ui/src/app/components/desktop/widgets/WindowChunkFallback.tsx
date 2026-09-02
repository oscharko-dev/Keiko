import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import { useWindowStageEvidence, type WindowStage } from "../hooks/useWindowStageEvidence";

// Named, not just styled. A window body chunk and the chat bind that follows it both render a
// "Loading…" placeholder, and while they were indistinguishable a stalled chunk, a stalled bind and a
// bound-but-empty body all presented as the same absent locator — which is what made the grounded-ask
// journey report a missing composer instead of the state it was actually stuck in. `output` carries
// the status role natively; it is inline by default and `.lk-loading` sets no display, so the block
// layout the previous div had is kept explicitly.
//
// One factory for every lazy chunk, so each dynamic import names ITS stage on the diagnostic sink: a
// stalled editor chunk must be reconstructable as an editor stall, not labelled as a chat one
// (Cursor review on f50133b95).
export function createWindowChunkFallback(stage: WindowStage): () => ReactNode {
  function WindowChunkFallback(): ReactNode {
    const t = useTranslate();
    useWindowStageEvidence(stage);
    return (
      <output className="lk-loading" data-window-chunk="loading" style={{ display: "block" }}>
        {t("common.loading")}
      </output>
    );
  }
  return WindowChunkFallback;
}
