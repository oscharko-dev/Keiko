import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import { StagePlaceholder } from "./StagePlaceholder";
import type { WindowStage } from "../hooks/useWindowStageEvidence";

// Named, not just styled. A window body chunk and the chat bind that follows it both render a
// "Loading…" placeholder, and while they were indistinguishable a stalled chunk, a stalled bind and a
// bound-but-empty body all presented as the same absent locator — which is what made the grounded-ask
// journey report a missing composer instead of the state it was actually stuck in.
//
// One factory for every lazy chunk. The chat, editor and files chunks behind the session hosts name
// their own stage on the diagnostic sink; the window registry's other lazy chunks share the generic
// `window chunk` stage, told apart by their per-mount sequence number rather than by kind (naming
// each of them is a follow-up, not a claim this file makes).
export function createWindowChunkFallback(stage: WindowStage): () => ReactNode {
  function WindowChunkFallback(): ReactNode {
    const t = useTranslate();
    return (
      <StagePlaceholder
        stage={stage}
        marker={{
          "data-window-chunk": "loading",
        }} /* i18n-exempt: DOM state marker, never rendered */
      >
        {t("common.loading")}
      </StagePlaceholder>
    );
  }
  return WindowChunkFallback;
}
