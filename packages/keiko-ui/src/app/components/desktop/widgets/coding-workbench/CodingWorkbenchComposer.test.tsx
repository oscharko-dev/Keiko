import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeStateName,
  ModelCapability,
} from "@oscharko-dev/keiko-contracts";
import { I18N_STORAGE_KEY, resetLoadedMessageCatalogs } from "@/lib/i18n";
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import { sha256Hex } from "../../hooks/canonical-voice-hasher-runtime";

import { TaskStartSection, type TaskComposerActions } from "./CodingWorkbenchSections";
import { operatorResumeAvailable } from "./CodingWorkbenchWindow";

function composerActions(): TaskComposerActions {
  return {
    onStart: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
  };
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

const GEMMA_MODEL: ModelCapability = {
  ...CODING_MODEL,
  id: "gemma-4-31b-it",
  reasoningEfforts: [],
};

// The composer is mounted on its own, outside any page landmark, and its listboxes portal to the
// document body; the page-composition "region" rule says nothing about the controls themselves.
const AXE_OPTIONS = { rules: { region: { enabled: false } } } as const;

type ComposerProps = Parameters<typeof TaskStartSection>[0];

function composerProps(
  runState: CodingWorkbenchRuntimeStateName,
  actions: TaskComposerActions,
  taskIntent = "Investigate the failing test",
  onReasoningEffortChange = vi.fn(),
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
    startBlockedReason: null,
    projectMemoryEnabled: true,
    onProjectMemoryEnabledChange: vi.fn(),
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
): void {
  render(
    <TaskStartSection {...composerProps(runState, actions, taskIntent, onReasoningEffortChange)} />,
  );
}

function renderComposerWithOverrides(overrides: Partial<ComposerProps>): ComposerProps {
  const props = { ...composerProps("idle", composerActions()), ...overrides };
  render(<TaskStartSection {...props} />);
  return props;
}

describe("Coding Workbench composer", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(I18N_STORAGE_KEY);
    resetLoadedMessageCatalogs();
    resetClientDiagnosticWriter();
  });

  it("uses the dedicated governed-coding glyph for the run-authority mode label (#2694)", () => {
    renderComposer("idle", composerActions());
    const authority = screen.getByRole("combobox", { name: "Run authority" });
    expect(authority.querySelector('path[d*="M16.4 6.5"]')).toBeInTheDocument();
    expect(authority.querySelector('path[d*="M13.5 5.5"]')).not.toBeInTheDocument();
  });

  // Repository and branch selection belong to the window above the composer. This pin keeps the
  // composer itself free of duplicate context controls and the hidden MemoriaViva toggle.
  it("does not render the repository, branch or MemoriaViva chips in the composer", () => {
    renderComposer("idle", composerActions());
    expect(screen.queryByLabelText("Coding context")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Choose repository" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Manage branch/u })).toBeNull();
    expect(screen.queryByText("MemoriaViva")).toBeNull();
  });

  it("shows Start while idle and calls the start handler", async () => {
    const user = userEvent.setup();
    const actions = composerActions();
    renderComposer("idle", actions);
    expect(screen.queryByRole("button", { name: "Pause run" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(actions.onStart).toHaveBeenCalledOnce();
  });

  it.each(["idle", "paused"] as const)(
    "submits the captured native input instead of stale React draft state while %s (#3877)",
    async (state) => {
      const user = userEvent.setup();
      const actions = composerActions();
      renderComposer(state, actions, "Old unsent task");
      const textarea = screen.getByRole("textbox", { name: "Task instructions" });
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter === undefined) throw new Error("Missing native textarea setter");
      setter.call(textarea, "Visible replacement task");
      await user.click(
        screen.getByRole("button", {
          name: state === "idle" ? "Start coding run" : "Send follow-up",
        }),
      );
      expect(state === "idle" ? actions.onStart : actions.onSend).toHaveBeenCalledExactlyOnceWith(
        "Visible replacement task",
      );
    },
  );

  it("does not submit a native input cleared before React state catches up (#3877)", async () => {
    const user = userEvent.setup();
    const actions = composerActions();
    renderComposer("idle", actions, "Old unsent task");
    const textarea = screen.getByRole("textbox", { name: "Task instructions" });
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("Missing native textarea setter");
    setter.call(textarea, "");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(actions.onStart).not.toHaveBeenCalled();
  });

  it("records captured input and normalized payload digests without claiming acceptance (#3877)", async () => {
    const evidence: ClientDiagnosticMeta[] = [];
    setClientDiagnosticWriter((_message, meta): void => {
      if (meta?.composerSubmission !== undefined) evidence.push(meta);
    });
    const user = userEvent.setup();
    const actions = composerActions();
    renderComposer("idle", actions, "  PRIVATE_TASK_CANARY\n ");
    await user.click(screen.getByRole("button", { name: "Start coding run" }));
    expect(actions.onStart).toHaveBeenCalledExactlyOnceWith("  PRIVATE_TASK_CANARY\n ");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.composerSubmission).toEqual({
      kind: "start",
      outcome: "attempted",
      normalization: "trim",
      displayedDigest: sha256Hex("  PRIVATE_TASK_CANARY\n "),
      submittedDigest: sha256Hex("PRIVATE_TASK_CANARY"),
      draftMatchesInput: true,
      inputCharacterCount: 23,
      submittedCharacterCount: 19,
    });
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_TASK_CANARY");
  });

  it("offers pause and stop in the composer while the run is active", async () => {
    const user = userEvent.setup();
    const actions = composerActions();
    renderComposer("running", actions);
    expect(screen.queryByRole("button", { name: "Send follow-up" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Pause run" }));
    expect(actions.onPause).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Stop run" }));
    expect(actions.onStop).toHaveBeenCalledOnce();
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

  // A run paused because a governed tool is waiting on the operator's decision resumes itself when
  // that decision lands, and the server refuses an operator resume while the reason stands. The
  // control must not offer a second exit that does not exist.
  it.each([
    ["an operator's own pause", undefined, true],
    ["a run waiting on a package-script trust decision", "workspace-script-trust" as const, false],
  ] as const)("withholds the resume control for %s", (_label, pauseReason, expected) => {
    expect(operatorResumeAvailable("supervised-coding", pauseReason)).toBe(expected);
  });

  it("has no resume control to offer without a resolved mode", () => {
    expect(operatorResumeAvailable(null, undefined)).toBe(false);
  });

  it("disables the resume control when the run may not be resumed by the operator", () => {
    renderComposerWithOverrides({ runState: "paused", canResume: false });
    expect(screen.getByRole("button", { name: "Resume run" })).toBeDisabled();
  });

  // #3452: the follow-up resumes the run before replacing its task, through the same one exit a
  // decision-paused run keeps for the operator's decision. When the operator may not resume it
  // themselves, sending a follow-up must not submit either -- it stays a plain, non-submitting
  // button, exactly like the resume control above.
  it("keeps the follow-up Send button a non-submitting button when the run may not be resumed", () => {
    renderComposerWithOverrides({ runState: "paused", canResume: false });
    const send = screen.getByRole("button", { name: "Send follow-up" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveAttribute("type", "button");
  });

  it("submits the follow-up Send button once the run may be resumed and nothing else blocks it", () => {
    renderComposerWithOverrides({ runState: "paused", canResume: true });
    const send = screen.getByRole("button", { name: "Send follow-up" });
    expect(send).toHaveAttribute("aria-disabled", "false");
    expect(send).toHaveAttribute("type", "submit");
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

  // #3563 owner directive: only Keiko Gateway ships today; the Model source dropdown is hidden
  // (SourceControl component kept for a one-line re-enable once a second source is decided).
  it("changes the coding model and run authority without exposing a Model source dropdown", async () => {
    const user = userEvent.setup();
    const onSelectedModelChange = vi.fn();
    const onRequestedModeChange = vi.fn();
    renderComposerWithOverrides({
      models: [CODING_MODEL, ALTERNATE_MODEL],
      onSelectedModelChange,
      onRequestedModeChange,
    });

    expect(screen.queryByRole("combobox", { name: "Model source" })).toBeNull();

    await user.click(screen.getByRole("combobox", { name: "Coding model: gpt-5.4" }));
    await user.click(screen.getByRole("option", { name: "gpt-5.5" }));
    await user.click(screen.getByRole("combobox", { name: "Run authority" }));
    await user.click(screen.getByRole("option", { name: "Full access" }));

    expect(onSelectedModelChange).toHaveBeenCalledWith("gpt-5.5");
    expect(onRequestedModeChange).toHaveBeenCalledWith("autonomous-delivery");
  });

  // #3873 live review: both listboxes exposed every option as a nameless "option" in the
  // accessibility tree while showing "gpt-5.4" and "gemma-4-31b-it", so a screen reader announced
  // nothing. Each option carries its visible text as its own accessible name.
  it("names every coding model and run authority option by its visible text", async () => {
    const user = userEvent.setup();
    renderComposerWithOverrides({ models: [CODING_MODEL, GEMMA_MODEL] });

    await user.click(screen.getByRole("combobox", { name: /^Coding model/u }));
    for (const id of [CODING_MODEL.id, GEMMA_MODEL.id]) {
      expect(screen.getByRole("option", { name: id })).toHaveAttribute("aria-label", id);
    }
    expect(screen.getByRole("option", { name: "gemma-4-31b-it" })).toHaveTextContent(
      "gemma-4-31b-it",
    );
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("combobox", { name: "Run authority" }));
    for (const label of ["Ask for approval", "Supervised workspace", "Full access"]) {
      expect(screen.getByRole("option", { name: label })).toHaveAttribute("aria-label", label);
    }
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
  });

  // #3873 live review: the chip showed "gemma-4-…", and neither a tooltip nor the accessible name
  // said which model was selected. Both now carry the full identifier, however long it is.
  it("exposes the full selected model identifier through the chip's title and name", () => {
    const longId = "qwen3-coder-480b-a35b-instruct-fp8-dynamic-preview-2026-10";
    renderComposerWithOverrides({
      models: [CODING_MODEL, { ...GEMMA_MODEL, id: longId }],
      selectedModelId: longId,
    });

    const chip = screen.getByRole("combobox", { name: `Coding model: ${longId}` });
    expect(chip).toHaveAttribute("title", `Coding model: ${longId}`);
    expect(chip).toHaveTextContent(longId);
  });

  it("keeps the plain chip name and no title while no coding model is selected", () => {
    renderComposerWithOverrides({ models: [], selectedModelId: null });

    const chip = screen.getByRole("combobox", { name: "Coding model" });
    expect(chip).not.toHaveAttribute("title");
    expect(chip).toHaveTextContent("No coding model available");
  });

  // Same hiding rule applies regardless of the runtimePreference the state carries; the operator
  // never sees the Codex option, so the choice cannot be made from this surface.
  it("still hides the Model source dropdown when the state carries a codex-subscription runtime", () => {
    renderComposerWithOverrides({
      runtimePreference: "codex-subscription",
      models: [ALTERNATE_MODEL],
      selectedModelId: ALTERNATE_MODEL.id,
    });

    expect(screen.queryByRole("combobox", { name: "Model source" })).toBeNull();
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

  it("explains why a typed start request is blocked instead of swallowing the click", async () => {
    const user = userEvent.setup();
    const actions = composerActions();
    renderComposerWithOverrides({
      actions,
      canStart: false,
      startBlockedReason: "This browser session is not paired.",
      taskIntent: "Can you answer a normal question?",
    });

    const start = screen.getByRole("button", { name: "Start coding run" });
    await user.click(start);

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("This browser session is not paired.");
    expect(start).toHaveAttribute("aria-describedby", notice.id);
    expect(actions.onStart).not.toHaveBeenCalled();
  });

  it("explains a decision-paused run when Enter cannot send a follow-up", () => {
    const actions = composerActions();
    renderComposerWithOverrides({
      actions,
      runState: "paused",
      canResume: false,
      taskIntent: "Please continue differently.",
    });

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task instructions" }), {
      key: "Enter",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This paused run is waiting for a required decision.",
    );
    expect(actions.onSend).not.toHaveBeenCalled();
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
