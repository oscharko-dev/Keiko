// #3880: an unpaired window used to show five overlapping notices at once — the task session, the
// approved skills, the activity connection, the questions card and the editor bridge each reported
// its own failure to read a channel the missing pairing had closed. The run status sentence names
// the pairing once; while the window is unpaired, every secondary surface holds its notice behind
// that one state. Pairing, authority and fail-closed behaviour are unchanged: a held surface still
// reads its channel and shows its notice again as soon as the window is paired.
import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { ClientCodingWorkbenchHeldNotice } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { reportCodingWorkbenchInteraction } from "@/lib/coding-workbench-interaction";

const PairingHoldContext = createContext(false);

/** Holds the secondary notices of everything below it while `unpaired` is true. */
export function CodingWorkbenchPairingHold({
  unpaired,
  children,
}: {
  readonly unpaired: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return <PairingHoldContext.Provider value={unpaired}>{children}</PairingHoldContext.Provider>;
}

/**
 * True when the surface would show `notice` and the window is unpaired, so the surface renders
 * nothing instead. Each hold is recorded once on the Activity Log, with the closed notice only.
 */
export function useHeldNotice(notice: ClientCodingWorkbenchHeldNotice, shown: boolean): boolean {
  const held = useContext(PairingHoldContext) && shown;
  useEffect(() => {
    if (held) reportCodingWorkbenchInteraction({ interaction: "notice-held", notice });
  }, [held, notice]);
  return held;
}
