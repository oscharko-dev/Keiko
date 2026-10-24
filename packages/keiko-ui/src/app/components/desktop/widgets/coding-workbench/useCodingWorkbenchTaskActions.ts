"use client";

import { useRef } from "react";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

import type { CodingWorkbenchFollowUpInputs } from "@/lib/coding-workbench-runtime-mutations";
import type { CodingWorkbenchStartOptions } from "@/lib/coding-workbench-runtime-actions";
import type { CodingWorkbenchRuntimeActions } from "@/lib/useCodingWorkbenchRuntime";
import type { TaskComposerActions, TaskStartInputs } from "./CodingWorkbenchSections";
import type { CodingTaskForkSource } from "./useCodingTaskSession";
import type { useCodingWorkbenchIssueIntake } from "./useCodingWorkbenchIssueIntake";
import type { CodingWorkbenchRunWorkspaceBinding } from "./useCodingWorkbenchRunWorkspace";
import type { PromptDeliveryNoticeController } from "./usePromptDeliveryNotice";

export interface TaskActionsInput {
  readonly actions: CodingWorkbenchRuntimeActions;
  readonly issueIntake: ReturnType<typeof useCodingWorkbenchIssueIntake>;
  readonly runWorkspace: CodingWorkbenchRunWorkspaceBinding;
  readonly promptDelivery: PromptDeliveryNoticeController;
  /** The composer's draft, which a retry of the last start is compared with. */
  readonly taskIntent: string;
  readonly projectMemoryEnabled: boolean;
  readonly conversationId: string | undefined;
  /**
   * The fork the person asked for (S03): the start begins a new task from it and continues no
   * conversation.
   */
  readonly fork?: CodingTaskForkSource | null | undefined;
  /** The mode a paused run resumes in; none while the operator cannot resume. */
  readonly resumeMode: CodingWorkbenchMode | null;
}

export interface TaskActions {
  readonly composer: TaskComposerActions;
  /** Starts again with what the last start submitted, when the draft is still that text. */
  readonly retryStart: () => void;
}

interface LastStart {
  readonly draft: string;
  readonly inputs: TaskStartInputs | undefined;
}

/** What the first prompt carries beside its text; both fields are absent for the ordinary start. */
function startPromptInputs(
  inputs: TaskStartInputs | undefined,
): Pick<CodingWorkbenchStartOptions, "references" | "command"> {
  const references = inputs?.references ?? [];
  return {
    ...(references.length === 0 ? {} : { references }),
    ...(inputs?.command === undefined ? {} : { command: inputs.command }),
  };
}

/** The task a start continues, or the one it forks: never both. */
function startedFrom(
  input: TaskActionsInput,
): Pick<CodingWorkbenchStartOptions, "conversationId" | "fork"> {
  const { fork } = input;
  if (fork === null || fork === undefined) return { conversationId: input.conversationId };
  return {
    fork: {
      taskId: fork.taskId,
      ...(fork.beforeMessageId === undefined ? {} : { beforeMessageId: fork.beforeMessageId }),
    },
  };
}

// Resolves an issue reference in the prompt, then starts the run on the workspace the person is
// looking at. A command turn carries none of an issue's context, so its arguments are never read for
// an issue reference: an empty prompt resets the intake and starts the command as it is.
function beginStart(
  input: TaskActionsInput,
  draft: string,
  inputs: TaskStartInputs | undefined,
): void {
  const { actions, issueIntake, runWorkspace } = input;
  const submitted = draft.trim();
  const intakeText = inputs?.command === undefined ? submitted : "";
  void issueIntake.submit(intakeText, async (issue): Promise<void> => {
    runWorkspace.captureSubmission();
    await actions.start(submitted, {
      projectMemoryEnabled: input.projectMemoryEnabled,
      ...startedFrom(input),
      issue,
      ...startPromptInputs(inputs),
    });
  });
}

/** The historical single-argument call when the follow-up carries neither files nor a command. */
function sendFollowUp(
  actions: CodingWorkbenchRuntimeActions,
  draft: string,
  inputs: CodingWorkbenchFollowUpInputs,
): void {
  const text = draft.trim();
  void (Object.keys(inputs).length === 0
    ? actions.submitFollowUp(text)
    : actions.submitFollowUp(text, inputs));
}

/**
 * What the Workbench's composer does with a submitted prompt: starts a task, sends a follow-up to a
 * paused run, delivers a message to a running turn, or pauses, stops and resumes. The prompt's `@`
 * files and slash command ride along on the start and the follow-up (ADR-0137 D10).
 */
export function useTaskComposerActions(input: TaskActionsInput): TaskActions {
  const { actions, promptDelivery, resumeMode, taskIntent } = input;
  const lastStart = useRef<LastStart | null>(null);
  const startTask = (draft: string, inputs?: TaskStartInputs): void => {
    lastStart.current = { draft, inputs };
    beginStart(input, draft, inputs);
  };
  const retryStart = (): void => {
    const last = lastStart.current;
    const unchanged = last !== null && last.draft.trim() === taskIntent.trim();
    if (unchanged) startTask(last.draft, last.inputs);
    else startTask(taskIntent);
  };
  const composer: TaskComposerActions = {
    onStart: startTask,
    onPause: () => void actions.pause(),
    onStop: () => void actions.stop(),
    onResume: () => {
      if (resumeMode !== null) void actions.resume(resumeMode);
    },
    onSend: (draft, references, command): void =>
      sendFollowUp(actions, draft, {
        ...(references === undefined ? {} : { references }),
        ...(command === undefined ? {} : { command }),
      }),
    onDeliver: (draft, delivery, references): void => {
      promptDelivery.begin(delivery);
      void actions.submitFollowUp(draft.trim(), { delivery, references });
    },
  };
  return { composer, retryStart };
}
