import { useState, type ReactNode } from "react";
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
//
// A chunk request the browser loses never settles. On dev CI (run 35438847738) WebKit's network
// process crashed, every request in flight failed without an error event, and the Chat History
// window waited on "Loading…" for good: webpack and Turbopack both keep a pending chunk request, so
// no retry inside the page can request it again. A stalled chunk therefore says so and offers the
// reload that requests it fresh, and the workspace restores every window after it.
export function createWindowChunkFallback(
  stage: WindowStage,
  reload: () => void = reloadKeiko,
): () => ReactNode {
  function WindowChunkFallback(): ReactNode {
    const t = useTranslate();
    const [stalled, setStalled] = useState(false);
    return (
      <>
        <StagePlaceholder
          stage={stage}
          marker={{
            "data-window-chunk": stalled ? "stalled" : "loading",
          }} /* i18n-exempt: DOM state marker, never rendered */
          onStall={setStalled}
        >
          {t(stalled ? "window.chunkStalled" : "common.loading")}
        </StagePlaceholder>
        {stalled ? (
          <button type="button" className="lk-btn" onClick={reload}>
            {t("shell.error.reload")}
          </button>
        ) : null}
      </>
    );
  }
  return WindowChunkFallback;
}

function reloadKeiko(): void {
  window.location.reload();
}
