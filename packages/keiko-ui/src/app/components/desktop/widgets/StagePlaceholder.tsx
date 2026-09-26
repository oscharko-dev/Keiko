import type { ReactNode } from "react";
import { useWindowStageEvidence, type WindowStage } from "../hooks/useWindowStageEvidence";

// The one placeholder every pre-interactive desktop stage renders: an `<output>` (status role) that
// names its stage for the live DOM through a data attribute and leaves body-free start/settled
// evidence on the client diagnostic sink. `output` is inline by default and `.lk-loading` sets no
// display, so the block layout the previous `div` had is kept explicitly.
export function StagePlaceholder({
  stage,
  marker,
  onStall,
  children,
}: {
  readonly stage: WindowStage;
  readonly marker:
    | { readonly "data-window-chunk": "loading" | "stalled" }
    | { readonly "data-chat-bind": "opening" };
  // A stable callback (a state setter) that learns when the stage has not settled in time.
  readonly onStall?: ((stalled: boolean) => void) | undefined;
  readonly children: ReactNode;
}): ReactNode {
  useWindowStageEvidence(stage, onStall);
  return (
    <output className="lk-loading" style={{ display: "block" }} {...marker}>
      {children}
    </output>
  );
}
