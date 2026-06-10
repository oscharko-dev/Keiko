// Epic #518 issue #526 — tests for the shell-level status indicators
// surfaced by the workspace Footer.
//
// The architecture blueprint (docs/workspace/518-architecture-blueprint.md)
// names four shell-level status indicators that the workspace foundation
// must surface: connected project, model availability, workflow readiness,
// and evidence access. The Footer is the existing component that owns the
// indicator strip.
//
// These tests pin the contract so future Footer edits cannot silently
// remove an indicator.

import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Footer } from "./Footer";

function renderFooter(patch: Partial<ComponentProps<typeof Footer>> = {}): ReturnType<typeof render> {
  return render(
    <Footer
      winCount={0}
      mode="manual"
      selectedModel={undefined}
      projectName="Keiko"
      branchLabel="main"
      shellStatusLabel="Ready"
      evidenceStatusLabel="Open review"
      {...patch}
    />,
  );
}

describe("Footer — shell-level status indicators (epic #518 #526)", () => {
  it("renders the connected-project indicator with the live workspace label", () => {
    renderFooter({ projectName: "Regulated Workspace" });
    expect(screen.getByText("Regulated Workspace")).toBeInTheDocument();
  });

  it("renders the model-availability indicator with the selected model id", () => {
    renderFooter({ selectedModel: "claude-sonnet-4-6" });
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
  });

  it("renders an explicit no-model-selected state when no model is configured", () => {
    renderFooter();
    expect(screen.getByText("No model selected")).toBeInTheDocument();
  });

  it("renders the workflow-readiness indicator showing the active window count", () => {
    renderFooter({ winCount: 3 });
    expect(screen.getByText(/3 windows/)).toBeInTheDocument();
  });

  it("singularises the window-count indicator when a single window is open", () => {
    renderFooter({ winCount: 1 });
    expect(screen.getByText(/1 window\b/)).toBeInTheDocument();
  });

  it("renders the review and evidence-access indicator", () => {
    renderFooter({ evidenceStatusLabel: "Evidence ready" });
    expect(screen.getByText("Evidence ready")).toBeInTheDocument();
  });

  it("renders the shell trust-boundary status indicator", () => {
    renderFooter({ shellStatusLabel: "Gateway setup required" });
    expect(screen.getByText("Gateway setup required")).toBeInTheDocument();
  });

  it("renders the governance mode pill in manual mode", () => {
    renderFooter();
    expect(screen.getByText(/You · manual/)).toBeInTheDocument();
  });

  it("renders the governance mode pill in autonomous mode", () => {
    renderFooter({ mode: "autonomous" });
    expect(screen.getByText("Keiko governing")).toBeInTheDocument();
  });

  it("uses a single semantic footer landmark", () => {
    const { container } = renderFooter();
    const footers = container.querySelectorAll("footer");
    expect(footers).toHaveLength(1);
  });

  it("can receive keyboard focus as the shell status surface", async () => {
    const user = userEvent.setup();
    renderFooter();
    const footer = screen.getByRole("contentinfo", { name: "Workspace status" });
    await user.tab();
    expect(footer).not.toHaveFocus();
    footer.focus();
    expect(footer).toHaveFocus();
  });
});
