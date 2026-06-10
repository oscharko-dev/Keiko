import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, type Command } from "./CommandPalette";

function makeCommands(count: number): readonly Command[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `cmd-${String(i)}`,
    label: `Command ${String(i)}`,
    icon: "spark" as const,
    run: vi.fn(),
  }));
}

describe("CommandPalette", () => {
  // vitest.setup.ts stubs HTMLElement.prototype.scrollIntoView (jsdom lacks
  // it) — spy on that exact prototype so calls are observable (audit C019).
  let scrollIntoViewMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scrollIntoViewMock = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scrolls the active option into view while navigating with arrow keys (C019)", () => {
    render(<CommandPalette commands={makeCommands(25)} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    scrollIntoViewMock.mockClear();

    for (let i = 0; i < 14; i += 1) {
      fireEvent.keyDown(dialog, { key: "ArrowDown" });
    }

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "nearest" });
    const lastCallTarget = scrollIntoViewMock.mock.contexts.at(-1) as HTMLElement;
    expect(lastCallTarget.id).toBe("cmdk-row-14");
    expect(lastCallTarget.getAttribute("aria-selected")).toBe("true");
  });

  it("announces the result count in a status live region (C188)", () => {
    render(<CommandPalette commands={makeCommands(3)} onClose={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("3 commands");

    const input = screen.getByRole("combobox", { name: /command query/i });
    fireEvent.change(input, { target: { value: "Command 1" } });
    expect(screen.getByRole("status")).toHaveTextContent("1 command");
  });

  it("announces 'No matching commands' when the filter has zero results (C188)", () => {
    render(<CommandPalette commands={makeCommands(3)} onClose={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: /command query/i });
    fireEvent.change(input, { target: { value: "zzz-no-match" } });
    expect(screen.getByRole("status")).toHaveTextContent("No matching commands");
  });

  it("keeps Escape reachable after a click on a non-focusable dialog area (C007)", () => {
    const onClose = vi.fn();
    render(<CommandPalette commands={makeCommands(3)} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    // tabIndex={-1} lets the container itself take focus on background clicks.
    expect(dialog).toHaveAttribute("tabindex", "-1");
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
