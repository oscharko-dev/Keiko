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

  it.each([
    {
      title: "does not expose Plugins in the left rail while the product surface is hidden",
      name: "Plugins",
    },
    {
      title: "does not expose Search in the left rail while the product surface is hidden",
      name: "Search",
    },
    {
      title: "does not expose Project in the left rail while the product surface is hidden",
      name: "Project",
    },
    {
      title: "does not expose Automations in the left rail while the product surface is hidden",
      name: "Automations",
    },
    {
      title: "does not expose Keiko Mobile in the left rail while the product surface is hidden",
      name: "Keiko Mobile",
    },
    {
      title: "does not expose Relationships in the left rail while the product surface is hidden",
      name: "Relationships",
    },
    { title: "does not expose the Account user icon in the left rail", name: "Account" },
  ])("$title", ({ name }) => {
    renderRail();
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });

  it.each([
    {
      title: "renders MemoriaViva as a tool button instead of a page-route link",
      name: "MemoriaViva",
    },
    {
      title: "renders Quality Intelligence as a tool button (not a page-route link)",
      name: "Quality Intelligence",
    },
    {
      title: "renders Coding Workbench as a tool button (not a page-route link)",
      name: "Coding Workbench",
    },
    {
      title: "renders Local Knowledge as a tool button (not a page-route link)",
      name: "Local Knowledge",
    },
    {
      title: "renders Figma Snapshot as a tool button (not a page-route link)",
      name: "Figma Snapshot",
    },
  ])("$title", ({ name }) => {
    renderRail();
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
  });

  it.each([
    {
      title: "opens the MemoriaViva window via onTool('memoria') when clicked",
      name: "MemoriaViva",
      tool: "memoria",
    },
    {
      title: "opens the Quality Intelligence hub via onTool('quality') when clicked",
      name: "Quality Intelligence",
      tool: "quality",
    },
    {
      title: "opens the Coding Workbench via onTool('coding') when clicked",
      name: "Coding Workbench",
      tool: "coding",
    },
    {
      title: "opens the Git window via onTool('governedGit') when clicked",
      name: "Git",
      tool: "governedGit",
    },
    {
      title: "opens the Local Knowledge window via onTool('localKnowledge') when clicked",
      name: "Local Knowledge",
      tool: "localKnowledge",
    },
    {
      title: "opens the Figma Snapshot manager via onTool('figma') when clicked",
      name: "Figma Snapshot",
      tool: "figma",
    },
  ] as const)("$title", async ({ name, tool }) => {
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
    await user.click(screen.getByRole("button", { name }));
    expect(onTool).toHaveBeenCalledWith(tool);
  });

  it("marks the MemoriaViva button pressed when its window is open", () => {
    renderRail(new Set(["memoria"]));
    expect(screen.getByRole("button", { name: "MemoriaViva" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("marks the Quality Intelligence button pressed when its window is open", () => {
    renderRail(new Set(["quality"]));
    expect(screen.getByRole("button", { name: "Quality Intelligence" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("marks the Coding Workbench button pressed when its window is open", () => {
    renderRail(new Set(["coding"]));
    expect(screen.getByRole("button", { name: "Coding Workbench" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("marks the Git button pressed when its window is open", () => {
    renderRail(new Set(["governedGit"]));
    expect(screen.getByRole("button", { name: "Git" })).toHaveAttribute("aria-pressed", "true");
  });

  it("marks the Local Knowledge button pressed when its window is open", () => {
    renderRail(new Set(["localKnowledge"]));
    expect(screen.getByRole("button", { name: "Local Knowledge" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("marks the Figma Snapshot button pressed when its window is open", () => {
    renderRail(new Set(["figma"]));
    expect(screen.getByRole("button", { name: "Figma Snapshot" })).toHaveAttribute(
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
