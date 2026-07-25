import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";

import { TaskStartSection, type TaskComposerActions } from "./CodingWorkbenchSections";

function composerActions(): TaskComposerActions {
  return { onStart: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onSend: vi.fn() };
}

function renderComposer(
  runState: CodingWorkbenchRuntimeStateName,
  actions: TaskComposerActions,
  taskIntent = "Investigate the failing test",
): void {
  render(
    <TaskStartSection
      taskIntent={taskIntent}
      onTaskIntentChange={vi.fn()}
      actions={actions}
      canStart
      runState={runState}
      mutationPending={false}
      startBusy={false}
    />,
  );
}

describe("Coding Workbench composer", () => {
  afterEach(() => cleanup());

  it("shows Start while idle and calls the start handler", async () => {
    const user = userEvent.setup();
    const actions = composerActions();
    renderComposer("idle", actions);
    expect(screen.queryByRole("button", { name: "Pause run" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(actions.onStart).toHaveBeenCalledOnce();
  });

  it("replaces Send with Pause while the run is active", async () => {
    const user = userEvent.setup();
    const actions = composerActions();
    renderComposer("running", actions);
    expect(screen.queryByRole("button", { name: "Send follow-up" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Pause run" }));
    expect(actions.onPause).toHaveBeenCalledOnce();
  });

  it("admits a follow-up only while paused and offers a resume control", async () => {
    const user = userEvent.setup();
    const actions = composerActions();
    renderComposer("paused", actions);
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    await user.click(screen.getByRole("button", { name: "Resume run" }));
    expect(actions.onSend).toHaveBeenCalledOnce();
    expect(actions.onResume).toHaveBeenCalledOnce();
  });

  it("disables the follow-up Send button when the draft is empty", () => {
    renderComposer("paused", composerActions(), "   ");
    expect(screen.getByRole("button", { name: "Send follow-up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
