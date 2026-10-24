import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { CodingWorkbenchRuntimeActions } from "@/lib/useCodingWorkbenchRuntime";

const previewIssueMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  previewCodingWorkbenchIssue: previewIssueMock,
}));

import { useCodingWorkbenchIssueIntake } from "./useCodingWorkbenchIssueIntake";
import {
  useTaskComposerActions,
  type TaskActions,
  type TaskActionsInput,
} from "./useCodingWorkbenchTaskActions";

type IssueIntake = ReturnType<typeof useCodingWorkbenchIssueIntake>;

// ADR-0137 D10: what the Workbench window does with a prompt the composer submitted, files and
// slash command included. The real issue intake runs here, because the one thing a command start must
// not do is let its arguments resolve an issue.

function runtimeActions(): CodingWorkbenchRuntimeActions {
  return {
    start: vi.fn(() => Promise.resolve()),
    submitFollowUp: vi.fn(() => Promise.resolve()),
    pause: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
  } as unknown as CodingWorkbenchRuntimeActions;
}

function setup(
  overrides: Partial<TaskActionsInput> = {},
  taskIntent = "",
): {
  readonly result: { readonly current: TaskActions & { readonly issueIntake: IssueIntake } };
  readonly rerender: (props: { taskIntent: string }) => void;
  readonly actions: CodingWorkbenchRuntimeActions;
  readonly captureSubmission: Mock;
  readonly begin: Mock;
} {
  const actions = runtimeActions();
  const captureSubmission = vi.fn();
  const begin = vi.fn();
  const { result, rerender } = renderHook(
    (props: { taskIntent: string }) => {
      const issueIntake = useCodingWorkbenchIssueIntake("/repo", "scope");
      return {
        issueIntake,
        ...useTaskComposerActions({
          actions,
          issueIntake,
          runWorkspace: { bound: null, mismatched: false, captureSubmission },
          promptDelivery: { notice: null, begin },
          taskIntent: props.taskIntent,
          projectMemoryEnabled: true,
          conversationId: "conv-1",
          resumeMode: null,
          ...overrides,
        }),
      };
    },
    { initialProps: { taskIntent } },
  );
  return { result, rerender, actions, captureSubmission, begin };
}

beforeEach(() => {
  previewIssueMock.mockReset();
  previewIssueMock.mockResolvedValue({
    preview: { provenance: { ownerAndRepo: "owner/repo", issueNumber: 13 } },
    binding: { bindingDigest: "d".repeat(64) },
  });
});

describe("starting a task", () => {
  it("starts with the trimmed draft on the workspace being looked at, as it always did", async () => {
    const { result, actions, captureSubmission } = setup();

    act(() => result.current.composer.onStart("  fix the flaky test \n"));

    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
    expect(captureSubmission).toHaveBeenCalledOnce();
    expect(actions.start).toHaveBeenCalledWith("fix the flaky test", {
      projectMemoryEnabled: true,
      conversationId: "conv-1",
      issue: undefined,
    });
    const options = vi.mocked(actions.start).mock.calls[0]?.[1] ?? {};
    expect(options).not.toHaveProperty("references");
    expect(options).not.toHaveProperty("command");
  });

  it("sends the first prompt's referenced files with the start", async () => {
    const { result, actions } = setup();

    act(() =>
      result.current.composer.onStart("look at @src/app.ts", {
        references: [{ path: "src/app.ts" }],
      }),
    );

    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
    expect(actions.start).toHaveBeenCalledWith("look at @src/app.ts", {
      projectMemoryEnabled: true,
      conversationId: "conv-1",
      issue: undefined,
      references: [{ path: "src/app.ts" }],
    });
  });

  it("omits an empty reference list", async () => {
    const { result, actions } = setup();

    act(() => result.current.composer.onStart("go", { references: [] }));

    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
    expect(vi.mocked(actions.start).mock.calls[0]?.[1]).not.toHaveProperty("references");
  });

  it("starts a fork instead of continuing the conversation, and never sends both", async () => {
    const { result, actions } = setup({
      fork: { taskId: "conv-1", title: "Inspect the parser", beforeMessageId: "m-3" },
    });

    act(() => result.current.composer.onStart("try another approach"));

    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
    expect(actions.start).toHaveBeenCalledWith("try another approach", {
      projectMemoryEnabled: true,
      fork: { taskId: "conv-1", beforeMessageId: "m-3" },
      issue: undefined,
    });
    expect(vi.mocked(actions.start).mock.calls[0]?.[1]).not.toHaveProperty("conversationId");
  });

  it("forks the task as it ended when no message was chosen", async () => {
    const { result, actions } = setup({ fork: { taskId: "conv-1", title: "Inspect the parser" } });

    act(() => result.current.composer.onStart("go"));

    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
    const options = vi.mocked(actions.start).mock.calls[0]?.[1];
    expect(options?.fork).toEqual({ taskId: "conv-1" });
    expect(options).not.toHaveProperty("conversationId");
  });

  it("still resolves an issue named in an ordinary prompt, with the files beside it", async () => {
    const { result, actions } = setup();

    act(() =>
      result.current.composer.onStart("fix #13 in @src/app.ts", {
        references: [{ path: "src/app.ts" }],
      }),
    );

    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
    expect(previewIssueMock).toHaveBeenCalledOnce();
    expect(actions.start).toHaveBeenCalledWith(
      "fix #13 in @src/app.ts",
      expect.objectContaining({
        issue: { issueRef: "#13", expectedIssueBindingDigest: "d".repeat(64) },
        references: [{ path: "src/app.ts" }],
      }),
    );
  });

  it("starts a command with its name and arguments, and never reads the arguments for an issue", async () => {
    const { result, actions, captureSubmission } = setup();

    act(() =>
      result.current.composer.onStart("  pr #13 \n", {
        references: [],
        command: { name: "review" },
      }),
    );

    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
    expect(previewIssueMock).not.toHaveBeenCalled();
    expect(captureSubmission).toHaveBeenCalledOnce();
    expect(actions.start).toHaveBeenCalledWith("pr #13", {
      projectMemoryEnabled: true,
      conversationId: "conv-1",
      issue: undefined,
      command: { name: "review" },
    });
  });

  it("starts a bare command with an empty text", async () => {
    const { result, actions } = setup();

    act(() => result.current.composer.onStart("", { references: [], command: { name: "init" } }));

    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
    expect(actions.start).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ command: { name: "init" } }),
    );
  });

  it("clears an issue intake failure a command start would otherwise leave on screen", async () => {
    const { result, actions } = setup();
    // Two issues in one prompt: the intake refuses and keeps its failure.
    act(() => result.current.composer.onStart("fix #13 and #14"));
    await waitFor(() => expect(result.current.issueIntake.state.kind).toBe("failed"));
    expect(actions.start).not.toHaveBeenCalled();

    act(() => result.current.composer.onStart("", { references: [], command: { name: "init" } }));

    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
    expect(result.current.issueIntake.state.kind).toBe("empty");
  });
});

describe("sending to a paused run and to a running turn", () => {
  it("sends the historical single argument for a plain follow-up", () => {
    const { result, actions } = setup();

    act(() => result.current.composer.onSend("  add a test \n"));

    expect(actions.submitFollowUp).toHaveBeenCalledExactlyOnceWith("add a test");
  });

  it("sends the referenced files and the command beside the follow-up's text", () => {
    const { result, actions } = setup();

    act(() => result.current.composer.onSend("see @a.ts", [{ path: "a.ts" }]));
    expect(actions.submitFollowUp).toHaveBeenLastCalledWith("see @a.ts", {
      references: [{ path: "a.ts" }],
    });

    act(() => result.current.composer.onSend("", [], { name: "review" }));
    expect(actions.submitFollowUp).toHaveBeenLastCalledWith("", {
      references: [],
      command: { name: "review" },
    });

    act(() => result.current.composer.onSend(" pr @a.ts ", [{ path: "a.ts" }], { name: "review" }));
    expect(actions.submitFollowUp).toHaveBeenLastCalledWith("pr @a.ts", {
      references: [{ path: "a.ts" }],
      command: { name: "review" },
    });
  });

  it("delivers a message into the running turn and notes which delivery it was", () => {
    const { result, actions, begin } = setup();

    act(() => result.current.composer.onDeliver?.(" also this ", "queue", [{ path: "a.ts" }]));

    expect(begin).toHaveBeenCalledExactlyOnceWith("queue");
    expect(actions.submitFollowUp).toHaveBeenCalledExactlyOnceWith("also this", {
      delivery: "queue",
      references: [{ path: "a.ts" }],
    });
  });

  it("pauses, stops, and resumes only in a mode it was given", () => {
    const none = setup();
    act(() => {
      none.result.current.composer.onPause();
      none.result.current.composer.onStop();
      none.result.current.composer.onResume();
    });
    expect(none.actions.pause).toHaveBeenCalledOnce();
    expect(none.actions.stop).toHaveBeenCalledOnce();
    expect(none.actions.resume).not.toHaveBeenCalled();

    const resumable = setup({ resumeMode: "supervised-coding" });
    act(() => resumable.result.current.composer.onResume());
    expect(resumable.actions.resume).toHaveBeenCalledExactlyOnceWith("supervised-coding");
  });
});

describe("retrying a start the issue intake stopped", () => {
  it("starts again with the files of the last start while the draft is still that text", async () => {
    const { result, actions } = setup({}, "look at @src/app.ts");
    act(() =>
      result.current.composer.onStart("look at @src/app.ts", {
        references: [{ path: "src/app.ts" }],
      }),
    );
    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());

    act(() => result.current.retryStart());

    await waitFor(() => expect(actions.start).toHaveBeenCalledTimes(2));
    expect(vi.mocked(actions.start).mock.calls[1]?.[1]).toMatchObject({
      references: [{ path: "src/app.ts" }],
    });
  });

  it("starts again from the draft as it is now once the person changed it", async () => {
    const { result, rerender, actions } = setup({}, "look at @src/app.ts");
    act(() =>
      result.current.composer.onStart("look at @src/app.ts", {
        references: [{ path: "src/app.ts" }],
      }),
    );
    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());

    rerender({ taskIntent: "a different task" });
    act(() => result.current.retryStart());

    await waitFor(() => expect(actions.start).toHaveBeenCalledTimes(2));
    expect(vi.mocked(actions.start).mock.calls[1]?.[0]).toBe("a different task");
    expect(vi.mocked(actions.start).mock.calls[1]?.[1]).not.toHaveProperty("references");
  });

  it("starts from the draft when nothing was started before", async () => {
    const { result, actions } = setup({}, " the draft ");

    act(() => result.current.retryStart());

    await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
    expect(vi.mocked(actions.start).mock.calls[0]?.[0]).toBe("the draft");
  });
});
