"use client";

import { useEffect, useRef, useState } from "react";

import type { CodingWorkbenchMutationState } from "@/lib/coding-workbench-live-state";

import { SELECTION_MISMATCH_ERROR_CODE } from "@/lib/coding-workbench-runtime-mutations";

/** The branch the chip showed when a start was refused, kept with the refused request it belongs to. */
interface RefusedSelection {
  readonly requestId: string;
  readonly shownBranch: string | null;
}

/**
 * A start or retry the server refused because its active workspace is not the one the window shows.
 * The window's cached workspace state was stale, so it is read again and the displayed repository is
 * bound afresh; the person's next Start then runs in what they see, or is refused again with the
 * same named cause. Acts once per refused request.
 *
 * It returns the branch the window showed at the refusal (U-39, #4491): once the checkout is read
 * again, a current branch that differs from it means the branch changed outside Keiko, and the alert
 * says that instead of claiming another repository.
 */
export function useSelectionMismatchRecovery(
  mutation: CodingWorkbenchMutationState,
  refreshWorkspace: () => Promise<boolean>,
  rebindSelection: () => void,
  shownBranch: string | null = null,
): string | null {
  const handled = useRef<string | null>(null);
  const shown = useRef(shownBranch);
  const [refused, setRefused] = useState<RefusedSelection | null>(null);
  const { error, kind, requestId, status } = mutation;
  useEffect(() => {
    shown.current = shownBranch;
  }, [shownBranch]);
  useEffect(() => {
    const isRefusal =
      status === "error" &&
      (kind === "start" || kind === "retry") &&
      error?.code === SELECTION_MISMATCH_ERROR_CODE;
    if (!isRefusal || requestId === null || handled.current === requestId) return;
    handled.current = requestId;
    setRefused({ requestId, shownBranch: shown.current });
    void refreshWorkspace().then((refreshed) => {
      if (refreshed) rebindSelection();
    });
  }, [error?.code, kind, rebindSelection, refreshWorkspace, requestId, status]);
  return refused !== null && refused.requestId === requestId ? refused.shownBranch : null;
}
