"use client";

import { useEffect, useState } from "react";
import type { CodingWorkbenchRuntimeRevertState } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import {
  codingAppSessionPairingSettled,
  useCodingAppSessionRedemptions,
} from "./coding-app-session-client";
import { getCodingWorkbenchRuntimeRevertState } from "./coding-workbench-runtime-api";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";
import { reportClientDiagnostic } from "./client-diagnostics";

/** Coalesces the burst of revisions and settled tools one turn produces into one read. */
export const CODING_WORKBENCH_REVERT_REFRESH_DEBOUNCE_MS = 300;

export interface UseCodingWorkbenchRevertInput {
  readonly runId: string | undefined;
  /** Only a running or paused run holds a session an undo can act on. */
  readonly live: boolean;
  /** The run revision: every undo and restore advances it, so the counts are read again. */
  readonly revision: number | undefined;
  /** Changes when a settled tool may have changed the worktree (`changesRefreshSignal`). */
  readonly changeSignal: string | null;
}

export interface UseCodingWorkbenchRevertResult {
  /** Counts of the newest turn, or of the staged undo; `null` when the run offers no undo. */
  readonly revert: CodingWorkbenchRuntimeRevertState | null;
}

interface ScopedRevert {
  readonly runId: string | undefined;
  readonly value: CodingWorkbenchRuntimeRevertState | null;
}

/**
 * Reads what an undo would do or has done from its one authenticated channel (B3, S04). Counts
 * only: the channel carries no path. An unpaired, unsupported or failing read renders no control at
 * all, never a stale or guessed count, and a read for another run is never shown.
 */
export function useCodingWorkbenchRevert(
  input: UseCodingWorkbenchRevertInput,
): UseCodingWorkbenchRevertResult {
  const { runId, live, revision, changeSignal } = input;
  const [scoped, setScoped] = useState<ScopedRevert>({ runId: undefined, value: null });
  // A re-pair without a page load reads the counts again.
  const redemptions = useCodingAppSessionRedemptions();

  useEffect(() => {
    if (runId === undefined || !live) {
      setScoped({ runId, value: null });
      return;
    }
    return startRevertSync(runId, (value) => setScoped({ runId, value }));
  }, [runId, live, revision, changeSignal, redemptions]);

  return { revert: live && scoped.runId === runId ? scoped.value : null };
}

function startRevertSync(
  runId: string,
  publish: (value: CodingWorkbenchRuntimeRevertState | null) => void,
): () => void {
  const controller = new AbortController();

  async function refresh(): Promise<void> {
    try {
      await codingAppSessionPairingSettled();
      if (controller.signal.aborted) return;
      const payload = await getCodingWorkbenchRuntimeRevertState(runId, controller.signal);
      if (controller.signal.aborted) return;
      publish(payload.session === "active" ? (payload.revert ?? null) : null);
    } catch (error) {
      if (controller.signal.aborted) return;
      reportClientDiagnostic(
        `[keiko] revert channel refresh failed: ${clientErrorSummary(error)}`,
        {
          correlationId: correlationIdOf(error),
        },
      );
      publish(null);
    }
  }

  const timer = setTimeout(() => {
    void refresh();
  }, CODING_WORKBENCH_REVERT_REFRESH_DEBOUNCE_MS);
  return (): void => {
    clearTimeout(timer);
    controller.abort();
  };
}
