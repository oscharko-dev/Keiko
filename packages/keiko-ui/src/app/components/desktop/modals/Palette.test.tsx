import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TYPE_ORDER, WIN_TYPES } from "../windows/WindowsRegistry";
import { Palette } from "./Palette";

// 10 cards in the 2-column .palette-grid — mirrors the live picker size the
// C363 audit observed (rows: [0,1] [2,3] [4,5] [6,7] [8,9]).
const ORDER = TYPE_ORDER.slice(0, 10);

function renderPalette(): { onAdd: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  render(<Palette types={WIN_TYPES} order={ORDER} onAdd={onAdd} onClose={onClose} />);
  return { onAdd, onClose };
}

function cards(): HTMLElement[] {
  return screen
    .getAllByRole("button")
    .filter((b) => b.classList.contains("pal-card")) as HTMLElement[];
}

describe("Palette", () => {
  it("focuses the first card on mount and closes on Escape", () => {
    const { onClose } = renderPalette();
    const list = cards();
    expect(list[0]).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("uses a roving tabindex: exactly the active card is a Tab stop (C363)", () => {
    renderPalette();
    const list = cards();
    expect(list[0]).toHaveAttribute("tabindex", "0");
    for (const card of list.slice(1)) expect(card).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus with arrow keys in the 2-column grid (C363)", () => {
    renderPalette();
    const list = cards();
    const first = list[0] as HTMLElement;

    // Right: 0 -> 1
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(list[1]).toHaveFocus();
    expect(list[1]).toHaveAttribute("tabindex", "0");
    expect(list[0]).toHaveAttribute("tabindex", "-1");

    // Down: 1 -> 3 (one row = two cards)
    fireEvent.keyDown(list[1] as HTMLElement, { key: "ArrowDown" });
    expect(list[3]).toHaveFocus();

    // Left: 3 -> 2
    fireEvent.keyDown(list[3] as HTMLElement, { key: "ArrowLeft" });
    expect(list[2]).toHaveFocus();

    // Up: 2 -> 0
    fireEvent.keyDown(list[2] as HTMLElement, { key: "ArrowUp" });
    expect(list[0]).toHaveFocus();
  });

  it("clamps at the grid edges and supports Home/End (C363)", () => {
    renderPalette();
    const list = cards();
    const first = list[0] as HTMLElement;
    const last = list[list.length - 1] as HTMLElement;

    // ArrowUp/ArrowLeft on the first card stay on the first card (no wrap).
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: "End" });
    expect(last).toHaveFocus();

    // ArrowDown/ArrowRight on the last card stay on the last card.
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "ArrowRight" });
    expect(last).toHaveFocus();

    fireEvent.keyDown(last, { key: "Home" });
    expect(first).toHaveFocus();
  });

  it("keeps plain Tab behaviour on the close button (arrows do not steal focus)", () => {
    renderPalette();
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "ArrowDown" });
    expect(close).toHaveFocus();
  });

  it("adds the picked window type on click", () => {
    const { onAdd } = renderPalette();
    fireEvent.click(cards()[2] as HTMLElement);
    expect(onAdd).toHaveBeenCalledWith(ORDER[2]);
  });
});
