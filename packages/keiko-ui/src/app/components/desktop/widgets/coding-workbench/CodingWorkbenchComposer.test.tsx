import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const ALTERNATE_MODEL: ModelCapability = {
  ...CODING_MODEL,
  id: "gpt-5.5",
  reasoningEfforts: ["medium"],
};

type ComposerProps = Parameters<typeof TaskStartSection>[0];

function composerProps(
  runState: CodingWorkbenchRuntimeStateName,
  actions: TaskComposerActions,
  taskIntent = "Investigate the failing test",
  onReasoningEffortChange = vi.fn(),
  onOpenGit = vi.fn(),
): ComposerProps {
  return {
    taskIntent,
    onTaskIntentChange: vi.fn(),
    actions,
    canStart: true,
    canResume: true,
    runState,
    mutationPending: false,
    startBusy: false,
    repositoryLabel: "Keiko",
    branchLabel: "dev",
    onOpenGit,
    autonomyMode: "supervised-coding",
    autonomyLabel: "Supervised workspace",
    requestedMode: "supervised-coding",
    runtimePreference: "managed-gateway",
    configurationLocked: runState !== "idle",
    onRequestedModeChange: vi.fn(),
    onRuntimePreferenceChange: vi.fn(),
    models: [CODING_MODEL],
    selectedModelId: CODING_MODEL.id,
    reasoningEffort: null,
    onSelectedModelChange: vi.fn(),
    onReasoningEffortChange,
  };
}

function renderComposer(
  runState: CodingWorkbenchRuntimeStateName,
  actions: TaskComposerActions,
  taskIntent = "Investigate the failing test",
  onReasoningEffortChange = vi.fn(),
  onOpenGit = vi.fn(),
): void {
  render(
    <TaskStartSection
      {...composerProps(runState, actions, taskIntent, onReasoningEffortChange, onOpenGit)}
    />,
  );
}

function renderComposerWithOverrides(overrides: Partial<ComposerProps>): ComposerProps {
  const props = { ...composerProps("idle", composerActions()), ...overrides };
  render(<TaskStartSection {...props} />);
  return props;
}

describe("Coding Workbench composer", () => {
  afterEach(() => cleanup());

  it("uses the dedicated governed-coding glyph for the run-authority mode label (#2694)", () => {
    renderComposer("idle", composerActions());
    const authority = screen.getByRole("combobox", { name: "Run authority" });
    expect(authority.querySelector('path[d*="M16.4 6.5"]')).toBeInTheDocument();
    expect(authority.querySelector('path[d*="M13.5 5.5"]')).not.toBeInTheDocument();
  });

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

  it("changes the coding model, model source, and run authority", async () => {
    const user = userEvent.setup();
    const onSelectedModelChange = vi.fn();
    const onRuntimePreferenceChange = vi.fn();
    const onRequestedModeChange = vi.fn();
    renderComposerWithOverrides({
      models: [CODING_MODEL, ALTERNATE_MODEL],
      onSelectedModelChange,
      onRuntimePreferenceChange,
      onRequestedModeChange,
    });

    await user.click(screen.getByRole("combobox", { name: "Coding model" }));
    await user.click(screen.getByRole("option", { name: "gpt-5.5" }));
    await user.click(screen.getByRole("combobox", { name: "Model source" }));
    await user.click(screen.getByRole("option", { name: "ChatGPT/Codex subscription" }));
    await user.click(screen.getByRole("combobox", { name: "Run authority" }));
    await user.click(screen.getByRole("option", { name: "Full access" }));

    expect(onSelectedModelChange).toHaveBeenCalledWith("gpt-5.5");
    expect(onRuntimePreferenceChange).toHaveBeenCalledWith("codex-subscription");
    expect(onRequestedModeChange).toHaveBeenCalledWith("autonomous-delivery");
  });

  it("hides gateway-only controls for a Codex model with one reasoning level", () => {
    renderComposerWithOverrides({
      runtimePreference: "codex-subscription",
      models: [ALTERNATE_MODEL],
      selectedModelId: ALTERNATE_MODEL.id,
    });

    expect(screen.queryByRole("combobox", { name: "Coding model" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
  });

  it("keeps an unresolved empty composer blocked and accepts task text changes", async () => {
    const user = userEvent.setup();
    const actions = composerActions();
    const onTaskIntentChange = vi.fn();
    renderComposerWithOverrides({
      actions,
      taskIntent: "",
      canStart: false,
      repositoryLabel: null,
      branchLabel: null,
      autonomyMode: null,
      onTaskIntentChange,
    });
    const textbox = screen.getByRole("textbox", { name: "Task instructions" });
    const form = textbox.closest("form");
    if (form === null) throw new Error("Task composer form was not rendered");

    fireEvent.submit(form);
    await user.type(textbox, "Inspect the repository");

    expect(actions.onStart).not.toHaveBeenCalled();
    expect(onTaskIntentChange).toHaveBeenCalled();
    expect(screen.queryByLabelText("Coding context")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Run authority" })).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("marks only confirmed full access on the authority control", () => {
    renderComposerWithOverrides({
      autonomyMode: "autonomous-delivery",
      autonomyLabel: "Full access",
      requestedMode: "autonomous-delivery",
    });

    const authority = screen.getByRole("combobox", { name: "Run authority" });
    expect(authority).toHaveAttribute("aria-describedby");
    expect(authority.closest("[data-full-access='true']")).not.toBeNull();
  });
});
