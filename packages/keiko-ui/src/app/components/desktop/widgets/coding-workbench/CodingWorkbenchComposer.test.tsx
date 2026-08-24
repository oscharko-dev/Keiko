import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeStateName,
  ModelCapability,
} from "@oscharko-dev/keiko-contracts";

import { TaskStartSection, type TaskComposerActions } from "./CodingWorkbenchSections";

function composerActions(): TaskComposerActions {
  return { onStart: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onSend: vi.fn() };
}

const CODING_MODEL: ModelCapability = {
  id: "gpt-5.4",
  kind: "chat",
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  toolCalling: true,
  structuredOutput: true,
  streaming: true,
  supportsImageInput: false,
  supportsDocumentInput: false,
  workflowEligible: true,
  costClass: "medium",
  latencyClass: "standard",
  throughputHint: "standard",
  preferredUseCases: ["Coding"],
  knownLimitations: [],
  reasoningEfforts: ["low", "medium", "high"],
};

function renderComposer(
  runState: CodingWorkbenchRuntimeStateName,
  actions: TaskComposerActions,
  taskIntent = "Investigate the failing test",
  onReasoningEffortChange = vi.fn(),
  onOpenGit = vi.fn(),
): void {
  render(
    <TaskStartSection
      taskIntent={taskIntent}
      onTaskIntentChange={vi.fn()}
      actions={actions}
      canStart
      canResume
      runState={runState}
      mutationPending={false}
      startBusy={false}
      repositoryLabel="Keiko"
      branchLabel="dev"
      onOpenGit={onOpenGit}
      autonomyMode="supervised-coding"
      autonomyLabel="Supervised workspace"
      requestedMode="supervised-coding"
      runtimePreference="managed-gateway"
      configurationLocked={runState !== "idle"}
      onRequestedModeChange={vi.fn()}
      onRuntimePreferenceChange={vi.fn()}
      models={[CODING_MODEL]}
      selectedModelId={CODING_MODEL.id}
      reasoningEffort={null}
      onSelectedModelChange={vi.fn()}
      onReasoningEffortChange={onReasoningEffortChange}
    />,
  );
}

describe("Coding Workbench composer", () => {
  afterEach(() => cleanup());

  it("opens Git from the active repository and branch controls", async () => {
    const user = userEvent.setup();
    const onOpenGit = vi.fn();
    renderComposer("idle", composerActions(), undefined, undefined, onOpenGit);

    const context = screen.getByLabelText("Coding context");
    await user.click(within(context).getByRole("button", { name: "Manage repository Keiko" }));
    await user.click(within(context).getByRole("button", { name: "Manage branch dev" }));

    expect(onOpenGit).toHaveBeenCalledTimes(2);
    expect(within(context).getByText("MemoriaViva")).toBeInTheDocument();
  });

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

  it("offers only the reasoning levels declared by the selected model", async () => {
    const user = userEvent.setup();
    const selectReasoningEffort = vi.fn();
    renderComposer("idle", composerActions(), "Investigate", selectReasoningEffort);

    await user.click(screen.getByRole("combobox", { name: "Reasoning effort" }));
    await user.click(screen.getByRole("option", { name: "High" }));

    expect(selectReasoningEffort).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("option", { name: "Extra high" })).toBeNull();
  });
});
