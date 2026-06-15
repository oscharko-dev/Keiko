// Issue #189 — tests for the LeftRail navigation controls.
// Verifies that visible features render as Workspace tool buttons and hidden/unreleased
// surfaces stay out of the rail.
// Epic #518 — also verifies aria-pressed state on toggle buttons (WCAG 4.1.2).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LeftRail } from "./LeftRail";

function renderRail(openTools: ReadonlySet<string> = new Set()): void {
  render(
    <LeftRail
      openTools={openTools}
      onTool={vi.fn()}
      onNewChat={vi.fn()}
      theme="dark"
      onToggleTheme={vi.fn()}
    />,
  );
}

describe("LeftRail — workspace tool buttons", () => {
  it("renders the left rail as a labeled navigation landmark", () => {
    renderRail();
    expect(
      screen.getByRole("navigation", { name: "Primary workspace navigation" }),
    ).toBeInTheDocument();
  });

  it("does not expose Plugins in the left rail while the product surface is hidden", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: "Plugins" })).not.toBeInTheDocument();
  });

  it("does not expose Search in the left rail while the product surface is hidden", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });

  it("does not expose Project in the left rail while the product surface is hidden", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: "Project" })).not.toBeInTheDocument();
  });

  it("does not expose Keiko Digital Twin in the left rail while the product surface is hidden", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: "Keiko" })).not.toBeInTheDocument();
  });

  it("does not expose Automations in the left rail while the product surface is hidden", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
  });

  it("does not expose Keiko Mobile in the left rail while the product surface is hidden", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: "Keiko Mobile" })).not.toBeInTheDocument();
  });

  it("does not expose Relationships in the left rail while the product surface is hidden", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: "Relationships" })).not.toBeInTheDocument();
  });

  it("does not expose the Account user icon in the left rail", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: "Account" })).not.toBeInTheDocument();
  });

  it("renders MemoriaViva as a tool button instead of a page-route link", () => {
    renderRail();
    expect(screen.getByRole("button", { name: "MemoriaViva" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "MemoriaViva" })).not.toBeInTheDocument();
  });

  it("opens the MemoriaViva window via onTool('memoria') when clicked", async () => {
    const onTool = vi.fn();
    const user = userEvent.setup();
    render(
      <LeftRail
        openTools={new Set()}
        onTool={onTool}
        onNewChat={vi.fn()}
        theme="dark"
        onToggleTheme={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "MemoriaViva" }));
    expect(onTool).toHaveBeenCalledWith("memoria");
  });

  it("marks the MemoriaViva button pressed when its window is open", () => {
    renderRail(new Set(["memoria"]));
    expect(screen.getByRole("button", { name: "MemoriaViva" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders Quality Intelligence as a tool button (not a page-route link)", () => {
    renderRail();
    expect(screen.getByRole("button", { name: "Quality Intelligence" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Quality Intelligence" })).not.toBeInTheDocument();
  });

  it("opens the Quality Intelligence hub via onTool('quality') when clicked", async () => {
    const onTool = vi.fn();
    const user = userEvent.setup();
    render(
      <LeftRail
        openTools={new Set()}
        onTool={onTool}
        onNewChat={vi.fn()}
        theme="dark"
        onToggleTheme={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Quality Intelligence" }));
    expect(onTool).toHaveBeenCalledWith("quality");
  });

  it("marks the Quality Intelligence button pressed when its window is open", () => {
    renderRail(new Set(["quality"]));
    expect(screen.getByRole("button", { name: "Quality Intelligence" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders Local Knowledge as a tool button (not a page-route link)", () => {
    renderRail();
    expect(screen.getByRole("button", { name: "Local Knowledge" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Local Knowledge" })).not.toBeInTheDocument();
  });

  it("opens the Local Knowledge window via onTool('localKnowledge') when clicked", async () => {
    const onTool = vi.fn();
    const user = userEvent.setup();
    render(
      <LeftRail
        openTools={new Set()}
        onTool={onTool}
        onNewChat={vi.fn()}
        theme="dark"
        onToggleTheme={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Local Knowledge" }));
    expect(onTool).toHaveBeenCalledWith("localKnowledge");
  });

  it("marks the Local Knowledge button pressed when its window is open", () => {
    renderRail(new Set(["localKnowledge"]));
    expect(screen.getByRole("button", { name: "Local Knowledge" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

});

describe("LeftRail — aria-pressed on toggle buttons (WCAG 4.1.2)", () => {
  it("sets aria-pressed=false on tool buttons when the panel is closed", () => {
    renderRail(new Set());
    const chatHistoryBtn = screen.getByRole("button", { name: "Chat History" });
    expect(chatHistoryBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("sets aria-pressed=true on tool buttons when the panel is open", () => {
    renderRail(new Set(["chatHistory"]));
    const chatHistoryBtn = screen.getByRole("button", { name: "Chat History" });
    expect(chatHistoryBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("sets aria-pressed=false on the Settings button when settings panel is closed", () => {
    renderRail(new Set());
    const settingsBtn = screen.getByRole("button", { name: "Settings" });
    expect(settingsBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("sets aria-pressed=true on the Settings button when settings panel is open", () => {
    renderRail(new Set(["settings"]));
    const settingsBtn = screen.getByRole("button", { name: "Settings" });
    expect(settingsBtn).toHaveAttribute("aria-pressed", "true");
  });

});

// SH-01 (WCAG 4.1.2) — theme-toggle button aria-pressed tracks the active theme.
describe("LeftRail — theme-toggle aria-pressed (SH-01)", () => {
  it("sets aria-pressed=true on the theme button when light theme is active", () => {
    render(
      <LeftRail
        openTools={new Set()}
        onTool={vi.fn()}
        onNewChat={vi.fn()}
        theme="light"
        onToggleTheme={vi.fn()}
      />,
    );
    // When light theme is active the button label is "Dark mode" (next action).
    expect(screen.getByRole("button", { name: "Dark mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("sets aria-pressed=false on the theme button when dark theme is active", () => {
    render(
      <LeftRail
        openTools={new Set()}
        onTool={vi.fn()}
        onNewChat={vi.fn()}
        theme="dark"
        onToggleTheme={vi.fn()}
      />,
    );
    // When dark theme is active the button label is "Light mode" (next action).
    expect(screen.getByRole("button", { name: "Light mode" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

// SH-01 (WCAG 4.1.2) — theme-toggle button aria-pressed tracks the active theme.
describe("LeftRail — theme-toggle aria-pressed (SH-01)", () => {
  it("sets aria-pressed=true on the theme button when light theme is active", () => {
    render(
      <LeftRail
        openTools={new Set()}
        onTool={vi.fn()}
        onNewChat={vi.fn()}
        theme="light"
        onToggleTheme={vi.fn()}
      />,
    );
    // When light theme is active the button label is "Dark mode" (next action).
    expect(screen.getByRole("button", { name: "Dark mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("sets aria-pressed=false on the theme button when dark theme is active", () => {
    render(
      <LeftRail
        openTools={new Set()}
        onTool={vi.fn()}
        onNewChat={vi.fn()}
        theme="dark"
        onToggleTheme={vi.fn()}
      />,
    );
    // When dark theme is active the button label is "Light mode" (next action).
    expect(screen.getByRole("button", { name: "Light mode" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
