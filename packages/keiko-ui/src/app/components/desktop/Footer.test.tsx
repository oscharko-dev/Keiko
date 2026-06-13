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
import { describe, expect, it, vi } from "vitest";
import { Footer } from "./Footer";
import type { AppWindow } from "./windows/types";

function footerWindow(patch: Partial<AppWindow> & Pick<AppWindow, "id" | "type">): AppWindow {
  return {
    x: 40,
    y: 40,
    w: 320,
    h: 260,
    z: 1,
    cfg: {},
    max: false,
    zoom: 1,
    ...patch,
  };
}

function renderFooter(
  patch: Partial<ComponentProps<typeof Footer>> = {},
): ReturnType<typeof render> {
  return render(
    <Footer
      winCount={0}
      windows={[]}
      windowPaletteOpen={false}
      onToggleWindowPalette={vi.fn()}
      onSelectWindow={vi.fn()}
      onCloseWindowPalette={vi.fn()}
      mode="manual"
      selectedModel={undefined}
      projectName="Keiko"
      branchLabel="main"
      shellStatusLabel="Ready"
      evidenceStatusLabel="No review open"
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
    renderFooter({ winCount: 1, windows: [footerWindow({ id: "files-1", type: "files" })] });
    expect(screen.getByText(/1 window\b/)).toBeInTheDocument();
  });

  it("exposes the window-count indicator as a palette trigger", async () => {
    const user = userEvent.setup();
    const onToggleWindowPalette = vi.fn();
    renderFooter({
      winCount: 2,
      windows: [
        footerWindow({ id: "files-1", type: "files", cfg: { root: "/repo" }, z: 1 }),
        footerWindow({ id: "chat-1", type: "chat", cfg: { title: "Sprint triage" }, z: 2 }),
      ],
      onToggleWindowPalette,
    });

    await user.click(screen.getByRole("button", { name: /2 windows/ }));

    expect(onToggleWindowPalette).toHaveBeenCalledTimes(1);
  });

  it("renders open and minimized windows in the footer palette", () => {
    renderFooter({
      winCount: 2,
      windowPaletteOpen: true,
      windows: [
        footerWindow({ id: "files-1", type: "files", cfg: { root: "/repo" }, z: 1 }),
        footerWindow({
          id: "chat-1",
          type: "chat",
          cfg: { title: "Sprint triage" },
          minimized: true,
          z: 2,
        }),
      ],
    });

    expect(screen.getByRole("menu", { name: "Open windows" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Restore Chat window - Sprint triage" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Focus Files window - /repo" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Minimized")).toBeInTheDocument();
  });

  it("selects a window from the footer palette", async () => {
    const user = userEvent.setup();
    const onSelectWindow = vi.fn();
    renderFooter({
      winCount: 1,
      windowPaletteOpen: true,
      windows: [
        footerWindow({ id: "files-1", type: "files", cfg: { root: "/repo" }, minimized: true }),
      ],
      onSelectWindow,
    });

    await user.click(screen.getByRole("menuitem", { name: "Restore Files window - /repo" }));

    expect(onSelectWindow).toHaveBeenCalledWith("files-1");
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
