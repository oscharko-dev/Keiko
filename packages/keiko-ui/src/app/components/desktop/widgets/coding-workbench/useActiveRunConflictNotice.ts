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

// Identifies one read of the run snapshot: a re-render of the same read keeps the key, a newer
// revision of the run changes it.
function runReadKey(run: CodingWorkbenchRuntimeState["run"]["value"]): string {
  return run === null ? "none" : `${run.runId ?? ""}:${String(run.revision)}`;
}

function startsTaskIntent(mutation: CodingWorkbenchMutationState): boolean {
  return mutation.status === "pending" && TASK_INTENT_KINDS.has(mutation.kind);
}

export interface ActiveRunConflictNotice {
  /** True while the person's kept task is waiting for the other window's run to end. */
  readonly visible: boolean;
  /** What the composer shows and sends: the kept task while one is held, else the draft. */
  readonly taskIntent: string;
  /** The composer's own edits: the person's text replaces the kept one, and may be empty. */
  readonly onTaskIntentChange: (taskIntent: string) => void;
  /** A deliberate reset (New task, a history selection): it drops the kept task and the notice. */
  readonly onDraftReset: () => void;
}

/**
 * U-14: a start refused because another window of this installation already runs a task must never
 * cost the person the task they typed. The refusal holds that text in this window's own state and
 * the composer shows it from there: it is never written back to the draft the windows share, so
 * another window cannot adopt it and a deliberate clear there cannot bring it back. The held text
 * ends on the person's own edit, a deliberate reset, or a new Start (which commits it to the draft
 * first, so a failed Start keeps it). The notice ends with the other run. Every report is
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
  const [kept, setKept] = useState<string | null>(null);
  const keptRef = useRef(kept);
  keptRef.current = kept;
  const armed = useRef(false);
  const sawRun = useRef(false);
  // The run snapshot the refusal was read against: only a later read can say the other run ended.
  const armedRun = useRef<string | undefined>(undefined);
  const runRef = useRef(state.run);
  runRef.current = state.run;
  const latestIntent = useRef(taskIntent);
  latestIntent.current = taskIntent;

  useEffect(() => {
    if (startsTaskIntent(mutation)) {
      if (keptRef.current !== null) setTaskIntent(keptRef.current);
      armed.current = false;
      sawRun.current = false;
      setKept(null);
      setVisible(false);
      return;
    }
    if (!refusedAsActiveRunConflict(mutation) || armed.current) return;
    armed.current = true;
    armedRun.current = runReadKey(runRef.current.value);
    setKept(latestIntent.current === "" ? null : latestIntent.current);
    setVisible(true);
    reportClientDiagnostic("[keiko] coding workbench start refused: active-run-elsewhere");
  }, [mutation, setTaskIntent]);

  useEffect(() => {
    if (runIsActive) sawRun.current = true;
    else if (sawRun.current) {
      armed.current = false;
      sawRun.current = false;
      setVisible(false);
    }
  }, [runIsActive]);

  // The other window's run may have ended before this window read it: it is never seen active, so
  // the notice would stay for good. A fresh read after the refusal that finds no active run ends it.
  useEffect(() => {
    if (!armed.current || runIsActive || state.run.status !== "ready") return;
    if (runReadKey(state.run.value) === armedRun.current) return;
    armed.current = false;
    sawRun.current = false;
    setVisible(false);
  }, [state.run, runIsActive]);

  const edits = useHeldTaskEdits({ held: kept !== null, setKept, setVisible, setTaskIntent });
  return { visible, taskIntent: kept ?? taskIntent, ...edits };
}

// The person's own ways to end the held task: an edit replaces it, a deliberate reset drops it and
// the notice with it. Neither writes the held text anywhere.
function useHeldTaskEdits({
  held,
  setKept,
  setVisible,
  setTaskIntent,
}: {
  readonly held: boolean;
  readonly setKept: (kept: string | null) => void;
  readonly setVisible: (visible: boolean) => void;
  readonly setTaskIntent: (taskIntent: string) => void;
}): Pick<ActiveRunConflictNotice, "onTaskIntentChange" | "onDraftReset"> {
  useHeldTaskUnloadWarning(held);
  const onTaskIntentChange = useCallback(
    (value: string): void => {
      setKept(null);
      setTaskIntent(value);
    },
    [setKept, setTaskIntent],
  );
  const onDraftReset = useCallback((): void => {
    setKept(null);
    setVisible(false);
    setTaskIntent("");
  }, [setKept, setVisible, setTaskIntent]);
  return { onTaskIntentChange, onDraftReset };
}

// The draft's own unload guard sees only the draft, and a held task is not in it: while one is held,
// closing or reloading the tab asks first, as it does for an unsaved draft.
function useHeldTaskUnloadWarning(held: boolean): void {
  useEffect(() => {
    if (!held) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return (): void => window.removeEventListener("beforeunload", warn);
  }, [held]);
}
