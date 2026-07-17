import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeReadiness,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";

import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import {
  ModeAuthority,
  TaskStartSection,
  type TaskComposerActions,
} from "./CodingWorkbenchSections";

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

function readiness(
  effectiveMode: CodingWorkbenchRuntimeReadiness["effectiveMode"],
): CodingWorkbenchRuntimeReadiness {
  return {
    schemaVersion: "1",
    requestedMode: "supervised-coding",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode,
    runtimeAvailable: true,
  };
}

function stateWith(
  readinessValue: CodingWorkbenchRuntimeReadiness,
  runState?: CodingWorkbenchRuntimeStateName,
): CodingWorkbenchRuntimeState {
  const base = createInitialCodingWorkbenchRuntimeState();
  return {
    ...base,
    runtime: { status: "ready", value: readinessValue, error: null },
    run:
      runState === undefined
        ? base.run
        : {
            status: "ready",
            value: {
              schemaVersion: "1",
              state: runState,
              revision: 2,
              updatedAt: "x",
              runId: "run-1",
            },
            error: null,
          },
  };
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
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeDisabled();
  });
});

describe("Coding Workbench mode authority", () => {
  afterEach(() => cleanup());

  it("defaults the requested mode to Supervised workspace", () => {
    render(
      <ModeAuthority
        state={stateWith(readiness("supervised-coding"))}
        onModeChange={vi.fn()}
        locked={false}
      />,
    );
    expect(screen.getByRole("radio", { name: /Supervised workspace/u })).toBeChecked();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces the server stop-before-widening reason when the request widens the effective mode", () => {
    render(
      <ModeAuthority
        state={stateWith(readiness("governed-assist"), "paused")}
        onModeChange={vi.fn()}
        locked={false}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/widening authority requires stopping/u);
  });

  it("locks the mode radios while a run is active", () => {
    render(
      <ModeAuthority
        state={stateWith(readiness("supervised-coding"))}
        onModeChange={vi.fn()}
        locked
      />,
    );
    expect(screen.getByRole("radio", { name: /Supervised workspace/u })).toBeDisabled();
  });
});
