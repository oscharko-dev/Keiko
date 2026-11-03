"use client";

import { useCallback, useEffect, useState } from "react";
import type { CodingWorkbenchRuntimeInboxItem } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import {
  codingAppSessionPairingSettled,
  useCodingAppSessionRedemptions,
} from "./coding-app-session-client";
import { fetchCodingWorkbenchRuntimeInbox } from "./coding-workbench-runtime-api";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";
import { reportClientDiagnostic } from "./client-diagnostics";

/** Coalesces the burst of revisions and delivered messages one turn produces into one read. */
export const CODING_WORKBENCH_INBOX_REFRESH_DEBOUNCE_MS = 300;

export type CodingWorkbenchInboxStatus = "idle" | "loading" | "ready" | "error";

export interface UseCodingWorkbenchInboxInput {
  readonly runId: string | undefined;
  /** Only a run whose turn is running holds messages the runtime has not taken yet. */
  readonly live: boolean;
  /** The run revision: every cancel, Send now and delivered message advances it. */
  readonly revision: number | undefined;
  /**
   * Changes when the turn takes a waiting message: it then appears in the live feed as a message of
   * the conversation. This is the existing refresh signal; nothing polls.
   */
  readonly deliveredSignal: number | null;
}

export interface UseCodingWorkbenchInboxResult {
  readonly status: CodingWorkbenchInboxStatus;
  /** The waiting messages in the order the model receives them; empty unless `status` is `ready`. */
  readonly items: readonly CodingWorkbenchRuntimeInboxItem[];
  /** Reads the list again, the operator's recourse after a failed read. */
  readonly retry: () => void;
}

interface InboxState {
  readonly status: CodingWorkbenchInboxStatus;
  readonly items: readonly CodingWorkbenchRuntimeInboxItem[];
}

const NO_ITEMS: readonly CodingWorkbenchRuntimeInboxItem[] = Object.freeze([]);
const IDLE: InboxState = { status: "idle", items: NO_ITEMS };
const LOADING: InboxState = { status: "loading", items: NO_ITEMS };
const FAILED: InboxState = { status: "error", items: NO_ITEMS };

interface ScopedInbox {
  readonly runId: string | undefined;
  readonly value: InboxState;
}

/**
 * Reads the messages the operator sent into the running turn that the runtime has not taken yet,
 * from their one authenticated channel (S07, ADR-0137 D10). It refreshes on the run's revision and on
 * the signal that the turn took a message, with a short debounce, and never polls: the turn settling
 * moves the run out of `running`, which clears the list. A failed or unpaired read is reported
 * body-free and shown as a retryable error, never as an empty list that would pass for "nothing is
 * waiting"; a list read for another run is never shown. The list kept from the previous read stays
 * until the next one arrives, so a refresh does not make the rows flicker.
 */
export function useCodingWorkbenchInbox(
  input: UseCodingWorkbenchInboxInput,
): UseCodingWorkbenchInboxResult {
  const { runId, live, revision, deliveredSignal } = input;
  const [scoped, setScoped] = useState<ScopedInbox>({ runId: undefined, value: IDLE });
  // Bumped only by `retry()` to re-run the read below without any input having changed.
  const [epoch, setEpoch] = useState(0);
  const retry = useCallback((): void => setEpoch((value) => value + 1), []);
  // A re-pair without a page load reads the list again.
  const redemptions = useCodingAppSessionRedemptions();

  useEffect(() => {
    if (runId === undefined || !live) {
      setScoped({ runId, value: IDLE });
      return;
    }
    setScoped((held) => (held.runId === runId ? held : { runId, value: LOADING }));
    return startInboxSync(runId, (value) => setScoped({ runId, value }));
  }, [runId, live, revision, deliveredSignal, epoch, redemptions]);

  const current = live && scoped.runId === runId ? scoped.value : IDLE;
  return { ...current, retry };
}

function startInboxSync(runId: string, publish: (value: InboxState) => void): () => void {
  const controller = new AbortController();

  async function refresh(): Promise<void> {
    try {
      await codingAppSessionPairingSettled();
      if (controller.signal.aborted) return;
      const payload = await fetchCodingWorkbenchRuntimeInbox(runId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      publish(projectInbox(payload.session, payload.items));
    } catch (error) {
      if (controller.signal.aborted) return;
      // The list shows the content-free retryable error; the failure itself stays diagnosable.
      reportClientDiagnostic(`[keiko] inbox channel read failed: ${clientErrorSummary(error)}`, {
        correlationId: correlationIdOf(error),
      });
      publish(FAILED);
    }
  }

  const timer = setTimeout(() => {
    void refresh();
  }, CODING_WORKBENCH_INBOX_REFRESH_DEBOUNCE_MS);
  return (): void => {
    clearTimeout(timer);
    controller.abort();
  };
}

/** An unpaired window has no list to show; a paired one shows what the run holds, maybe nothing. */
function projectInbox(
  session: "active" | "unpaired",
  items: readonly CodingWorkbenchRuntimeInboxItem[] | undefined,
): InboxState {
  if (session === "unpaired") return FAILED;
  return { status: "ready", items: items ?? NO_ITEMS };
}
