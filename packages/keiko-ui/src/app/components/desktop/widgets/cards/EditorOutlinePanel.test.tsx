import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditorDocumentSymbol } from "@oscharko-dev/keiko-editor";

import { EditorOutlinePanel } from "./EditorOutlinePanel";
import type { EditorOutlineSnapshot } from "./editorOutlineModel";

function range(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): EditorDocumentSymbol["range"] {
  return {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
  };
}

const SYMBOLS: readonly EditorDocumentSymbol[] = [
  { name: "Greeter", kind: "class", range: range(0, 0, 5, 1) },
  { name: "run", kind: "method", range: range(2, 2, 4, 3) },
];

const NESTED_SYMBOLS: readonly EditorDocumentSymbol[] = [
  { name: "Greeter", kind: "class", range: range(0, 0, 5, 1) },
  { name: "run", kind: "method", range: range(2, 2, 4, 3) },
  { name: "standalone", kind: "function", range: range(6, 0, 8, 1) },
];

function snapshot(overrides: Partial<EditorOutlineSnapshot> = {}): EditorOutlineSnapshot {
  return {
    filePath: "src/app.ts",
    symbols: SYMBOLS,
    cursor: { line: 3, column: 4 },
    enabled: true,
    loading: false,
    ...overrides,
  };
}

describe("EditorOutlinePanel", () => {
  it("renders a hierarchical tree and reveals clicked symbols", () => {
    const onReveal = vi.fn();
    render(
      <EditorOutlinePanel
        snapshot={snapshot()}
        visible
        onToggleVisible={vi.fn()}
        onReveal={onReveal}
      />,
    );

    const greeter = screen.getByRole("treeitem", { name: /greeter class/i });
    const run = screen.getByRole("treeitem", { name: /run method/i });
    expect(greeter).toHaveAttribute("aria-level", "1");
    expect(greeter).toHaveAttribute("aria-expanded", "true");
    expect(run).toHaveAttribute("aria-level", "2");
    expect(run).toHaveAttribute("aria-selected", "true");

    fireEvent.click(run);
    expect(onReveal).toHaveBeenCalledWith(SYMBOLS[1]);
  });

  it("supports roving tree keyboard navigation", () => {
    render(
      <EditorOutlinePanel
        snapshot={snapshot()}
        visible
        onToggleVisible={vi.fn()}
        onReveal={vi.fn()}
      />,
    );

    const greeter = screen.getByRole("treeitem", { name: /greeter class/i });
    greeter.focus();
    fireEvent.keyDown(greeter, { key: "ArrowDown" });
    expect(screen.getByRole("treeitem", { name: /run method/i })).toHaveFocus();

    fireEvent.keyDown(greeter, { key: "ArrowLeft" });
    expect(greeter).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /run method/i })).toBeNull();
  });

  it("renders explicit empty states", () => {
    render(
      <EditorOutlinePanel
        snapshot={snapshot({ symbols: [] })}
        visible
        onToggleVisible={vi.fn()}
        onReveal={vi.fn()}
      />,
    );
    expect(screen.getByText("No symbols found in this file.")).toBeInTheDocument();
  });

  it("renders the loading empty state", () => {
    render(
      <EditorOutlinePanel
        snapshot={snapshot({ symbols: [], loading: true })}
        visible
        onToggleVisible={vi.fn()}
        onReveal={vi.fn()}
      />,
    );
    expect(screen.getByText("Loading symbols.")).toBeInTheDocument();
  });

  it("renders the disabled empty state", () => {
    render(
      <EditorOutlinePanel
        snapshot={snapshot({ symbols: [], enabled: false })}
        visible
        onToggleVisible={vi.fn()}
        onReveal={vi.fn()}
      />,
    );
    expect(screen.getByText("Outline is unavailable for this file.")).toBeInTheDocument();
  });

  it("navigates with ArrowUp, Home, and End", () => {
    render(
      <EditorOutlinePanel
        snapshot={snapshot({ symbols: NESTED_SYMBOLS })}
        visible
        onToggleVisible={vi.fn()}
        onReveal={vi.fn()}
      />,
    );

    const greeter = screen.getByRole("treeitem", { name: /greeter class/i });
    const run = screen.getByRole("treeitem", { name: /run method/i });
    const standalone = screen.getByRole("treeitem", { name: /standalone function/i });

    run.focus();
    fireEvent.keyDown(run, { key: "Home" });
    expect(greeter).toHaveFocus();

    fireEvent.keyDown(greeter, { key: "End" });
    expect(standalone).toHaveFocus();

    fireEvent.keyDown(standalone, { key: "ArrowUp" });
    expect(run).toHaveFocus();
  });

  it("expands a collapsed node and then moves into it with ArrowRight", () => {
    render(
      <EditorOutlinePanel
        snapshot={snapshot({ symbols: NESTED_SYMBOLS })}
        visible
        onToggleVisible={vi.fn()}
        onReveal={vi.fn()}
      />,
    );

    const greeter = screen.getByRole("treeitem", { name: /greeter class/i });
    greeter.focus();
    fireEvent.keyDown(greeter, { key: "ArrowLeft" });
    expect(greeter).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(greeter, { key: "ArrowRight" });
    expect(greeter).toHaveAttribute("aria-expanded", "true");
    expect(greeter).toHaveFocus();

    fireEvent.keyDown(greeter, { key: "ArrowRight" });
    expect(screen.getByRole("treeitem", { name: /run method/i })).toHaveFocus();
  });

  it("keeps a manually collapsed node collapsed when the cursor selects an unrelated symbol", () => {
    const { rerender } = render(
      <EditorOutlinePanel
        snapshot={snapshot({ symbols: NESTED_SYMBOLS })}
        visible
        onToggleVisible={vi.fn()}
        onReveal={vi.fn()}
      />,
    );

    const greeter = screen.getByRole("treeitem", { name: /greeter class/i });
    greeter.focus();
    fireEvent.keyDown(greeter, { key: "ArrowLeft" });
    expect(greeter).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /run method/i })).toBeNull();

    rerender(
      <EditorOutlinePanel
        snapshot={snapshot({ symbols: NESTED_SYMBOLS, cursor: { line: 7, column: 0 } })}
        visible
        onToggleVisible={vi.fn()}
        onReveal={vi.fn()}
      />,
    );

    expect(screen.getByRole("treeitem", { name: /greeter class/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("treeitem", { name: /run method/i })).toBeNull();
  });
});
