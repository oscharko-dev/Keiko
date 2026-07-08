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
});
