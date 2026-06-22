import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    { id: "unknown", label: "Mystery", icon: "missing-icon" as Command["icon"], run: vi.fn() },
  ];
}

describe("CommandPalette", () => {
  it("filters commands, runs the selected command with Enter, and restores trigger focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const items = commands();
    const onClose = vi.fn();
    const user = userEvent.setup();

    const { unmount } = render(<CommandPalette commands={items} onClose={onClose} />);

    const input = screen.getByRole("combobox", { name: "Command query" });
    expect(input).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("3 commands");

    await user.type(input, "files");
    expect(screen.getByRole("status")).toHaveTextContent("1 command");
    expect(screen.getByRole("option", { name: /Open Files/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{Enter}");
    expect(items[1]?.run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("supports arrow navigation, mouse selection, empty state and Escape close", async () => {
    const items = commands();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<CommandPalette commands={items} onClose={onClose} />);

    const input = screen.getByRole("combobox", { name: "Command query" });
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Open Files/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: /New Chat/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveFocus();

    await user.hover(screen.getByRole("option", { name: /Mystery/i }));
    expect(screen.getByRole("option", { name: /Mystery/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("option", { name: /Mystery/i }));
    expect(items[2]?.run).toHaveBeenCalledOnce();

    await user.clear(input);
    await user.type(input, "nothing");
    expect(screen.getAllByText("No matching commands")).toHaveLength(2);
    expect(input).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{Enter}");

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
