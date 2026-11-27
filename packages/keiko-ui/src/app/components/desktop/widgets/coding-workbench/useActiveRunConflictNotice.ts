"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type {
  CodingWorkbenchMutationState,
  CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import { activeRunState } from "./codingWorkbenchLabels";

// The server's closed code for a start refused because another run holds the installation. Another
// paired window of the same installation can hold it without this window having read it yet.
const ACTIVE_RUN_CONFLICT_CODE = "CODING_RUNTIME_ACTIVE_RUN_CONFLICT";

const TASK_INTENT_KINDS: ReadonlySet<string | null> = new Set(["start", "follow-up", "retry"]);

// The refusal is read from the failed mutation, or from the superseded failure the state keeps when
// the other window's run arrived in the same render as the refusal.
function refusedAsActiveRunConflict(mutation: CodingWorkbenchMutationState): boolean {
  if (mutation.supersededFailure !== undefined) {
    return (
      mutation.supersededFailure.kind === "start" &&
      mutation.supersededFailure.code === ACTIVE_RUN_CONFLICT_CODE
    );
  }
  return (
    mutation.status === "error" &&
    mutation.kind === "start" &&
    mutation.error?.code === ACTIVE_RUN_CONFLICT_CODE
  );
}

function startsTaskIntent(mutation: CodingWorkbenchMutationState): boolean {
  return mutation.status === "pending" && TASK_INTENT_KINDS.has(mutation.kind);
}

export interface ActiveRunConflictNotice {
  /** True while the person's kept task is waiting for the other window's run to end. */
  readonly visible: boolean;
  /** The composer's own edits: they move the kept text, and clearing it is the person's choice. */
  readonly onTaskIntentChange: (taskIntent: string) => void;
}

/**
 * U-14: a start refused because another window of this installation already runs a task must never
 * cost the person the task they typed. The refusal arms a guard that holds the text; anything other
 * than the person's own edit that empties the composer while the guard is armed puts it back. The
 * guard ends when the person edits the text, starts again, or the other run ends. Every report is
 * body-free: the text itself never leaves the composer.
 */
export function useActiveRunConflictNotice({
  state,
  taskIntent,
  setTaskIntent,
}: {
  readonly state: Pick<CodingWorkbenchRuntimeState, "mutation" | "run">;
  readonly taskIntent: string;
  readonly setTaskIntent: (taskIntent: string) => void;
}): ActiveRunConflictNotice {
  const { mutation } = state;
  const runIsActive = activeRunState(state.run.value?.state);
  const [visible, setVisible] = useState(false);
  const kept = useRef<string | null>(null);
  const armed = useRef(false);
  const sawRun = useRef(false);
  const latestIntent = useRef(taskIntent);
  latestIntent.current = taskIntent;
  const disarm = useCallback((): void => {
    armed.current = false;
    kept.current = null;
    sawRun.current = false;
    setVisible(false);
  }, []);

  useEffect(() => {
    if (startsTaskIntent(mutation)) {
      disarm();
      return;
    }
    if (!refusedAsActiveRunConflict(mutation) || armed.current) return;
    armed.current = true;
    kept.current = latestIntent.current === "" ? null : latestIntent.current;
    setVisible(true);
    reportClientDiagnostic("[keiko] coding workbench start refused: active-run-elsewhere");
  }, [mutation, disarm]);

  useEffect(() => {
    if (runIsActive) sawRun.current = true;
    else if (sawRun.current) disarm();
  }, [runIsActive, disarm]);

  const onTaskIntentChange = useKeptTaskGuard(kept, taskIntent, setTaskIntent);
  return { visible, onTaskIntentChange };
}

// While a task is kept, anything other than the person's own edit that empties the composer puts it
// back; the person's own edits move the kept text, and clearing it on purpose ends the guard.
function useKeptTaskGuard(
  kept: { current: string | null },
  taskIntent: string,
  setTaskIntent: (taskIntent: string) => void,
): (taskIntent: string) => void {
  useEffect(() => {
    if (kept.current === null || taskIntent !== "") return;
    setTaskIntent(kept.current);
    reportClientDiagnostic("[keiko] coding workbench kept task restored: active-run-elsewhere");
  }, [kept, taskIntent, setTaskIntent]);
  return useCallback(
    (value: string): void => {
      if (kept.current !== null) kept.current = value === "" ? null : value;
      setTaskIntent(value);
    },
    [kept, setTaskIntent],
  );
}
