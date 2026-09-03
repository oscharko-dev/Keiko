"use client";

// #3381 review: run attribution must not follow the shell's live workspace pointer.
//
// The active task workspace is a global singleton the operator can move at any moment, and a Code
// task run's authority is not: the server binds a run to the workspace that was active when the
// Start request arrived, and keeps that authority for the run's whole life. Everything the window
// says ABOUT a run — the composer's repository/branch chips, the session context bar, the Git
// target, and the root the headless editor bridge registers its session for — therefore has to be
// answered from the run's own workspace, captured when Start was SUBMITTED. The live pointer is
// consulted for exactly one thing: telling the operator that it no longer names the run's
// workspace, so the inert Changes panel and editor bridge have a stated cause.

import { useCallback, useRef } from "react";

import type { CodingWorkbenchWorkspaceProjection } from "@/lib/coding-workbench-live-state";

/** The task-workspace identity one run is attributed to, frozen at that run's submission. */
export interface CodingWorkbenchRunWorkspace {
  /** The active root the run was submitted against: the Git target and the editor-bridge root. */
  readonly root: string | null;
  /** The task branch of the instance the run was submitted against. */
  readonly taskBranch: string | null;
  /** The runtime workspace projection (task id, branch, health) at submission. */
  readonly workspace: CodingWorkbenchWorkspaceProjection | null;
}

export interface UseCodingWorkbenchRunWorkspaceInput {
  readonly runId: string | undefined;
  /** The shell's live workspace identity — the singleton pointer the operator may move. */
  readonly live: CodingWorkbenchRunWorkspace;
  /** True while the live binding is unsettled: loading, switching, or unreadable. */
  readonly bindingPending: boolean;
}

export interface CodingWorkbenchRunWorkspaceBinding {
  /** The run's own workspace, or null while no run is bound. */
  readonly bound: CodingWorkbenchRunWorkspace | null;
  /** True only when the live pointer PROVABLY no longer names the bound run's workspace. */
  readonly mismatched: boolean;
  /** Captures the submission-time identity; the next new run adopts it. Call when Start is issued. */
  readonly captureSubmission: () => void;
}

const UNBOUND: CodingWorkbenchRunWorkspace = { root: null, taskBranch: null, workspace: null };

interface SubmissionCapture {
  /** The run that was current when Start was submitted; the capture belongs to the NEXT one. */
  readonly precedingRunId: string | undefined;
  readonly workspace: CodingWorkbenchRunWorkspace;
}

interface BoundRun {
  readonly runId: string;
  readonly workspace: CodingWorkbenchRunWorkspace;
}

/**
 * Locks the workspace identity a run is attributed to, mirroring `useRunBoundRoot`'s lock: armed
 * once per `runId`, never re-armed while that run is current, re-armed from scratch by a new one.
 *
 * It arms from the submission capture when one is pending, which is the whole point — the server
 * binds the run to the pointer it read synchronously at Start and only then awaits runtime
 * startup, so the response's `runId` can arrive long after the operator moved that pointer. A run
 * adopted without a capture (a run already live when this window opened) arms from the live
 * identity once the binding has settled, exactly as before.
 */
export function useCodingWorkbenchRunWorkspace(
  input: UseCodingWorkbenchRunWorkspaceInput,
): CodingWorkbenchRunWorkspaceBinding {
  const submission = useRef<SubmissionCapture | null>(null);
  const bound = useRef<BoundRun | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const captureSubmission = useCallback((): void => {
    submission.current = {
      precedingRunId: latest.current.runId,
      workspace: latest.current.live,
    };
  }, []);
  const armed = nextBoundRun(bound.current, submission.current, input);
  // A capture is consumed by the run it armed, and only then — never by the "adopt the first
  // resolved root" recovery below it, which belongs to a run that is already bound.
  if (armed !== null && armed.runId !== bound.current?.runId) submission.current = null;
  bound.current = armed;
  const workspace = armed?.workspace ?? null;
  return { bound: workspace, mismatched: isMismatched(workspace, input), captureSubmission };
}

/** The lock's next state: armed once per run id, then held — except that a run first seen while
 * the binding was unsettled adopts the first root that does resolve, exactly as `useRunBoundRoot`
 * does, so a run bound during a refresh is not stranded rootless for its whole life. */
function nextBoundRun(
  current: BoundRun | null,
  submission: SubmissionCapture | null,
  input: UseCodingWorkbenchRunWorkspaceInput,
): BoundRun | null {
  const { bindingPending, live, runId } = input;
  if (runId === undefined) return null;
  if (current?.runId !== runId) {
    return { runId, workspace: armedWorkspace(submission, runId, input) };
  }
  if (current.workspace.root === null && !bindingPending && live.root !== null) {
    return { runId, workspace: live };
  }
  return current;
}

function armedWorkspace(
  submission: SubmissionCapture | null,
  runId: string,
  input: UseCodingWorkbenchRunWorkspaceInput,
): CodingWorkbenchRunWorkspace {
  if (submission !== null && submission.precedingRunId !== runId) return submission.workspace;
  return input.bindingPending ? UNBOUND : input.live;
}

/**
 * A mismatch is a PROVEN divergence, never an unproven one: an unsettled binding (loading,
 * switching, unreadable) is not evidence that the pointer moved, and claiming one there would
 * flash a false notice on every ordinary refresh. The run's own attribution stays frozen either
 * way, so nothing is presented under the wrong workspace's name while the question is open.
 */
function isMismatched(
  bound: CodingWorkbenchRunWorkspace | null,
  input: UseCodingWorkbenchRunWorkspaceInput,
): boolean {
  const boundRoot = bound?.root ?? null;
  if (boundRoot === null || input.bindingPending) return false;
  return input.live.root !== boundRoot;
}
