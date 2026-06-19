import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TYPE_ORDER, WIN_TYPES, type WindowType } from "../windows/WindowsRegistry";
import { Palette } from "./Palette";

// 10 cards in the 3-column .palette-grid — mirrors the live picker size the
// C363 audit observed (rows: [0,1,2] [3,4,5] [6,7,8] [9]).
const ORDER = TYPE_ORDER.slice(0, 10);
const PICKER_ORDER: readonly WindowType[] = ["chat", "connector", "files"];

function renderPalette(order: readonly WindowType[] = ORDER): {
  onAdd: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  render(<Palette types={WIN_TYPES} order={order} onAdd={onAdd} onClose={onClose} />);
  return { onAdd, onClose };
}

function cards(): HTMLElement[] {
  return screen
    .getAllByRole("button")
    .filter((b) => b.classList.contains("pal-card")) as HTMLElement[];
}

function cardNames(): string[] {
  return cards().map((card) => card.querySelector(".pal-name")?.textContent ?? "");
}

describe("Palette", () => {
  it("does not expose the hidden Plugins surface in the default window order", () => {
    expect(TYPE_ORDER).not.toContain("plugins");
  });

  it("does not expose the hidden Search surface in the default window order", () => {
    expect(TYPE_ORDER).not.toContain("search");
  });

  it("does not expose the hidden Project surface in the default window order", () => {
    expect(TYPE_ORDER).not.toContain("project");
  });

  it("does not expose the hidden Keiko Digital Twin surface in the default window order", () => {
    expect(TYPE_ORDER).not.toContain("keiko");
  });

  it("does not expose the hidden Agents surface in the default window order", () => {
    expect(TYPE_ORDER).not.toContain("agents");
  });

  it("does not expose the hidden Integrations surface in the default window order", () => {
    expect(TYPE_ORDER).not.toContain("integ");
  });

  it("does not expose the hidden Editor surface in the default window order", () => {
    expect(TYPE_ORDER).not.toContain("editor");
  });

  it("does not expose the hidden Browser surface in the default window order", () => {
    expect(TYPE_ORDER).not.toContain("browser");
  });

  it("does not expose the hidden Terminal surface in the default window order", () => {
    expect(TYPE_ORDER).not.toContain("terminal");
  });

  it("does not expose the hidden Review surface in the default window order", () => {
    expect(TYPE_ORDER).not.toContain("review");
  });

  it("does not render the Terminal card in the default picker", () => {
    renderPalette(PICKER_ORDER);

    expect(screen.queryByRole("button", { name: /terminal/iu })).toBeNull();
  });

  it("does not render the Review card in the default picker", () => {
    renderPalette(PICKER_ORDER);

    expect(cardNames()).not.toContain("Review");
  });

  it("does not render the Figma Snapshot manager in the new-window picker", () => {
    renderPalette(PICKER_ORDER);

    expect(cardNames()).not.toContain("Figma Snapshot");
  });

  it("lays out the three visible picker cards as a two-column grid", () => {
    renderPalette(PICKER_ORDER);
    const dialog = screen.getByRole("dialog");

    expect(dialog).toHaveAttribute("data-columns", "2");
    expect(cardNames()).toEqual(["Chat", "Knowledge Connector", "Files"]);
  });

  it("uses the compact two-column arrangement for a two-card picker", () => {
    renderPalette(["chat", "files"]);

    expect(screen.getByRole("dialog")).toHaveAttribute("data-columns", "2");
    expect(cardNames()).toEqual(["Chat", "Files"]);
  });

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

  it("renders uniform palette cards in a fixed grid", () => {
    renderPalette();
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".palette-grid")).not.toBeNull();
    for (const card of cards()) {
      expect(card).toHaveClass("pal-card");
      expect(card.querySelector(".pal-ico")).not.toBeNull();
      expect(card.querySelector(".pal-name")).not.toBeNull();
      expect(card.querySelector(".pal-desc")).not.toBeNull();
    }
  });

  it("moves focus with arrow keys in the 3-column grid (C363)", () => {
    renderPalette();
    const list = cards();
    const first = list[0] as HTMLElement;

    // Right: 0 -> 1
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(list[1]).toHaveFocus();
    expect(list[1]).toHaveAttribute("tabindex", "0");
    expect(list[0]).toHaveAttribute("tabindex", "-1");

    // Down: 1 -> 4 (one row = three cards)
    fireEvent.keyDown(list[1] as HTMLElement, { key: "ArrowDown" });
    expect(list[4]).toHaveFocus();

    // Left: 4 -> 3
    fireEvent.keyDown(list[4] as HTMLElement, { key: "ArrowLeft" });
    expect(list[3]).toHaveFocus();

    // Up: 3 -> 0
    fireEvent.keyDown(list[3] as HTMLElement, { key: "ArrowUp" });
    expect(list[0]).toHaveFocus();
  });

  it("moves focus with arrow keys in the two-column picker grid", () => {
    renderPalette(PICKER_ORDER);
    const list = cards();
    const first = list[0] as HTMLElement;

    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(list[1]).toHaveFocus();

    fireEvent.keyDown(list[1] as HTMLElement, { key: "ArrowDown" });
    expect(list[2]).toHaveFocus();

    fireEvent.keyDown(list[2] as HTMLElement, { key: "ArrowLeft" });
    expect(list[1]).toHaveFocus();

    fireEvent.keyDown(list[1] as HTMLElement, { key: "ArrowUp" });
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
