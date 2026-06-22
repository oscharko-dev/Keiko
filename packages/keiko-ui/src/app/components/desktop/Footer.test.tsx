// Tests for the workspace Footer.
//
// The footer currently exposes only the open-window count trigger and its
// restore/focus palette. Other shell status indicators are intentionally hidden
// from this surface.

import type { ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Footer } from "./Footer";
import type { AppWindow } from "./windows/types";
import { fetchHealth } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchHealth: vi.fn(),
}));

const fetchHealthMock = vi.mocked(fetchHealth);

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
  fetchHealthMock.mockResolvedValue({ status: "ok", version: "0.2.0-test" });
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("Footer — window status trigger", () => {
  it("renders the centered product/version signature from the installed backend version", async () => {
    fetchHealthMock.mockResolvedValueOnce({ status: "ok", version: "0.2.0-beta.5" });
    renderFooter();

    expect(screen.getByText("Keiko | version loading")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Keiko | 0.2.0-beta.5")).toBeInTheDocument();
    });
    expect(fetchHealthMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the footer signature present when the version request fails", async () => {
    fetchHealthMock.mockRejectedValueOnce(new Error("offline"));
    renderFooter();

    await waitFor(() => {
      expect(screen.getByText("Keiko | version unavailable")).toBeInTheDocument();
    });
  });

  it("does not render the connected-project indicator", () => {
    renderFooter({ projectName: "Regulated Workspace" });
    expect(screen.queryByText("Regulated Workspace")).not.toBeInTheDocument();
  });

  it("does not render the selected model indicator", () => {
    renderFooter({ selectedModel: "claude-sonnet-4-6" });
    expect(screen.queryByText("claude-sonnet-4-6")).not.toBeInTheDocument();
  });

  it("does not render an explicit no-model-selected state", () => {
    renderFooter();
    expect(screen.queryByText("No model selected")).not.toBeInTheDocument();
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

  it("does not render the review and evidence-access indicator", () => {
    renderFooter({ evidenceStatusLabel: "Evidence ready" });
    expect(screen.queryByText("Evidence ready")).not.toBeInTheDocument();
  });

  it("does not render the shell trust-boundary status indicator", () => {
    renderFooter({ shellStatusLabel: "Gateway setup required" });
    expect(screen.queryByText("Gateway setup required")).not.toBeInTheDocument();
  });

  it("does not render the governance mode pill in manual mode", () => {
    renderFooter();
    expect(screen.queryByText(/You · manual/)).not.toBeInTheDocument();
  });

  it("does not render the governance mode pill in autonomous mode", () => {
    renderFooter({ mode: "autonomous" });
    expect(screen.queryByText("Keiko governing")).not.toBeInTheDocument();
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

  // SH-02 (WCAG 2.4.3) — the footer is a programmatic jump-to-region target (Alt+S);
  // tabIndex={-1} keeps it out of natural tab order while still accepting .focus() calls.
  it("has tabIndex=-1 so it is a programmatic focus target but not a natural tab stop", () => {
    renderFooter();
    const footer = screen.getByRole("contentinfo", { name: "Workspace status" });
    expect(footer).toHaveAttribute("tabindex", "-1");
  });
});
