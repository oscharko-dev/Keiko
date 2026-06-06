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

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Footer } from "./Footer";

describe("Footer — shell-level status indicators (epic #518 #526)", () => {
  it("renders the connected-project indicator with the workspace label", () => {
    render(<Footer winCount={0} mode="manual" selectedModel={undefined} />);
    expect(screen.getByText("example-workspace")).toBeInTheDocument();
  });

  it("renders the model-availability indicator with the selected model id", () => {
    render(<Footer winCount={0} mode="manual" selectedModel="claude-sonnet-4-6" />);
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
  });

  it("renders an explicit no-model-selected state when no model is configured", () => {
    render(<Footer winCount={0} mode="manual" selectedModel={undefined} />);
    expect(screen.getByText("No model selected")).toBeInTheDocument();
  });

  it("renders the workflow-readiness indicator showing the active window count", () => {
    render(<Footer winCount={3} mode="manual" selectedModel={undefined} />);
    expect(screen.getByText(/3 windows/)).toBeInTheDocument();
  });

  it("singularises the window-count indicator when a single window is open", () => {
    render(<Footer winCount={1} mode="manual" selectedModel={undefined} />);
    expect(screen.getByText(/1 window\b/)).toBeInTheDocument();
  });

  it("renders the evidence-equivalent autosaved indicator", () => {
    render(<Footer winCount={0} mode="manual" selectedModel={undefined} />);
    expect(screen.getByText("autosaved")).toBeInTheDocument();
  });

  it("renders the governance mode pill in manual mode", () => {
    render(<Footer winCount={0} mode="manual" selectedModel={undefined} />);
    expect(screen.getByText(/You · manual/)).toBeInTheDocument();
  });

  it("renders the governance mode pill in autonomous mode", () => {
    render(<Footer winCount={0} mode="autonomous" selectedModel={undefined} />);
    expect(screen.getByText("Keiko governing")).toBeInTheDocument();
  });

  it("uses a single semantic footer landmark", () => {
    const { container } = render(<Footer winCount={0} mode="manual" selectedModel={undefined} />);
    const footers = container.querySelectorAll("footer");
    expect(footers).toHaveLength(1);
  });
});
