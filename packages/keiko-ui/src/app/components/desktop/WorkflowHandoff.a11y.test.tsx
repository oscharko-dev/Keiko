// Issue #153 — accessibility smoke tests for chat-side workflow evidence.
// Workflow launch controls live exclusively in the Agent widget surface.

import { cleanup, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it } from "vitest";
import { RunSummaryCard } from "./WorkflowHandoff";
import type { ChatMessage } from "@/lib/types";

afterEach(() => {
  cleanup();
});

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
});
