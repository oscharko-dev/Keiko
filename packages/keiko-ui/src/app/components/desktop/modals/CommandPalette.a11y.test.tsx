// GEN-UI-TEST-GAP-002 / test-plan #23 — a11y smoke for the CommandPalette modal.
// jest-axe runs the WCAG 2.2 AA rule set over the open dialog, and we assert the
// Tab focus trap keeps keyboard focus inside the role=dialog container so users
// cannot tab out into the page behind the overlay (WCAG 2.4.3 / 2.1.2).

import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, type Command } from "./CommandPalette";

function commands(): Command[] {
  return [
    {
      id: "new-chat",
      label: "New Chat",
      group: "Workspace",
      icon: "newChat",
      shortcut: "⌘N",
      run: vi.fn(),
    },
    { id: "open-files", label: "Open Files", group: "Workspace", icon: "files", run: vi.fn() },
  ];
}

describe("CommandPalette accessibility", () => {
  it("has no axe violations while open", async () => {
    render(<CommandPalette commands={commands()} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: /command palette/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    expect(await axe(dialog)).toHaveNoViolations();
  });

  it("traps Tab focus inside the dialog", () => {
    render(<CommandPalette commands={commands()} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: /command palette/i });
    const input = screen.getByRole("combobox", { name: "Command query" });
    expect(input).toHaveFocus();

    // The query input is the sole tabbable control (option rows are
    // aria-activedescendant, tabindex=-1), so the trap wraps focus back onto it
    // in both directions — focus never leaves the dialog.
    fireEvent.keyDown(input, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(input).toHaveFocus();
  });
});
