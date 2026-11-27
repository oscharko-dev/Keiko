"use client";

import { useEffect, useRef } from "react";

import type { CodingWorkbenchMutationState } from "@/lib/coding-workbench-live-state";

import { SELECTION_MISMATCH_ERROR_CODE } from "@/lib/coding-workbench-runtime-mutations";

export { SELECTION_MISMATCH_ERROR_CODE };

/**
 * A start or retry the server refused because its active workspace is another repository than the
 * one the window shows. The window's cached workspace state was stale, so it is read again and the
 * displayed repository is bound afresh; the person's next Start then runs in what they see, or is
 * refused again with the same named cause. Acts once per refused request.
 */
export function useSelectionMismatchRecovery(
  mutation: CodingWorkbenchMutationState,
  refreshWorkspace: () => Promise<boolean>,
  rebindSelection: () => void,
): void {
  const handled = useRef<string | null>(null);
  const { error, kind, requestId, status } = mutation;
  useEffect(() => {
    const refused =
      status === "error" &&
      (kind === "start" || kind === "retry") &&
      error?.code === SELECTION_MISMATCH_ERROR_CODE;
    if (!refused || requestId === null || handled.current === requestId) return;
    handled.current = requestId;
    void refreshWorkspace().then((refreshed) => {
      if (refreshed) rebindSelection();
    });
  }, [error?.code, kind, rebindSelection, refreshWorkspace, requestId, status]);
}
