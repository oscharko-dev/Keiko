// Issue #153 — accessibility smoke tests for the governed workflow handoff surface (WCAG 2.2 AA).
//
// jest-axe sweeps each dialog in both step states (workflow list → input form) plus the
// RunSummaryCard, and pins the three targeted fixes from the #281 re-audit follow-up:
//   - RunSummaryCard announces run completion via an always-mounted polite live region that stays
//     empty until the status actually changes (WCAG 4.1.3, no load-time announcement burst).
//   - LaunchGroundedWorkflowButton stays in the tab order while busy (aria-disabled + a described
//     reason), not silently `disabled` (WCAG 4.1.2).
//   - Dialogs keep zero axe violations across the list/form step transition.

import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LaunchWorkflowButton,
  LaunchGroundedWorkflowButton,
  RunSummaryCard,
} from "./WorkflowHandoff";
import type { ChatMessage, GroundedAnswer, ModelCapability } from "@/lib/types";

afterEach(() => {
  cleanup();
});

function eligibleModel(): ModelCapability {
  return {
    id: "wf-model",
    kind: "chat",
    contextWindow: 8000,
    maxOutputTokens: 1000,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["Workflow"],
    knownLimitations: ["test fixture"],
  };
}

// The grounded button/dialog only read groundingKind, citations (multi-source check), and
// assistantMessageId; a minimal connected-context answer is enough to exercise the a11y surface.
function connectedAnswer(): GroundedAnswer {
  return {
    groundingKind: "connected-context",
    assistantMessageId: "msg-a",
    citations: [],
  } as unknown as GroundedAnswer;
}

function runMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "sys-1",
    chatId: "chat-1",
    role: "system",
    content: "Workflow run started.",
    timestamp: 1,
    runId: "qi-run-abcdef12",
    workflowId: "unit-test-generation",
    workflowStatus: "running",
    shortResult: undefined,
    taskType: "qi-handoff",
    ...overrides,
  } as ChatMessage;
}

describe("WorkflowHandoff — a11y (WCAG 2.2 AA)", () => {
  it("RunSummaryCard has no violations and its live region is empty on mount", async () => {
    const { container } = render(<RunSummaryCard message={runMessage()} />);
    const live = screen.getByTestId("run-summary-card-sr");
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveAttribute("aria-live", "polite");
    // No announcement burst on first render (historical cards must stay silent).
    expect(live.textContent).toBe("");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("RunSummaryCard announces the run status when it changes after mount", () => {
    const { rerender } = render(
      <RunSummaryCard message={runMessage({ workflowStatus: "running" })} />,
    );
    expect(screen.getByTestId("run-summary-card-sr").textContent).toBe("");
    rerender(<RunSummaryCard message={runMessage({ workflowStatus: "completed" })} />);
    expect(screen.getByTestId("run-summary-card-sr").textContent).toContain("completed");
  });

  it("LaunchGroundedWorkflowButton stays focusable + described (not silently disabled) while busy", async () => {
    const { container } = render(
      <LaunchGroundedWorkflowButton
        answer={connectedAnswer()}
        modelId="wf-model"
        busy
        launch={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: /launch grounded workflow/i });
    // aria-disabled keeps it in the tab order; native `disabled` would remove it.
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("disabled");
    const hintId = button.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId as string)?.textContent).toMatch(/run is in progress/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("WorkflowPickerDialog has no violations in the list step and the input step", async () => {
    const user = userEvent.setup();
    render(<LaunchWorkflowButton selectedModel={eligibleModel()} launch={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /launch workflow/i }));

    const dialog = await screen.findByRole("dialog", { name: /launch workflow/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(await axe(document.body)).toHaveNoViolations();

    const list = within(dialog).getByRole("list", { name: /available workflows/i });
    const [firstChoice] = within(list).getAllByRole("button");
    if (firstChoice === undefined) throw new Error("expected a workflow choice button");
    await user.click(firstChoice);
    // Now in the input-form step.
    expect(within(dialog).getByRole("button", { name: /^back$/i })).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("GroundedWorkflowDialog has no violations in the list step and the input step", async () => {
    const user = userEvent.setup();
    render(
      <LaunchGroundedWorkflowButton
        answer={connectedAnswer()}
        modelId="wf-model"
        launch={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /launch grounded workflow/i }));

    const dialog = await screen.findByRole("dialog", { name: /grounded workflow handoff/i });
    expect(await axe(document.body)).toHaveNoViolations();

    const list = within(dialog).getByRole("list", { name: /available grounded workflows/i });
    const [firstChoice] = within(list).getAllByRole("button");
    if (firstChoice === undefined) throw new Error("expected a grounded workflow choice button");
    await user.click(firstChoice);
    expect(within(dialog).getByRole("button", { name: /^back$/i })).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
