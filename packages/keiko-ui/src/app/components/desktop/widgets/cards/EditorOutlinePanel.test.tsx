import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorDocumentSymbol } from "@oscharko-dev/keiko-editor";

import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";

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

afterEach(() => {
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

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

  it("localizes the outline chrome and unavailable state in German", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    const view = render(
      <I18nProvider>
        <EditorOutlinePanel
          snapshot={snapshot({ symbols: [], enabled: false })}
          visible
          onToggleVisible={vi.fn()}
          onReveal={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(
      await screen.findByRole("region", { name: "Arbeitsbereichsgliederung" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Gliederung")).toBeInTheDocument();
    expect(screen.getByText("Für diese Datei ist keine Gliederung verfügbar.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Gliederungsbereich ausblenden" }),
    ).toBeInTheDocument();

    view.rerender(
      <I18nProvider>
        <EditorOutlinePanel
          snapshot={snapshot({ symbols: [], enabled: false })}
          visible={false}
          onToggleVisible={vi.fn()}
          onReveal={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Gliederungsbereich einblenden" }),
    ).toBeInTheDocument();
  });

  it("localizes the remaining outline empty states in German", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    const view = render(
      <I18nProvider>
        <EditorOutlinePanel
          snapshot={snapshot({ symbols: [], loading: true })}
          visible
          onToggleVisible={vi.fn()}
          onReveal={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText("Symbole werden geladen.")).toBeInTheDocument();

    view.rerender(
      <I18nProvider>
        <EditorOutlinePanel
          snapshot={snapshot({ symbols: [] })}
          visible
          onToggleVisible={vi.fn()}
          onReveal={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("In dieser Datei wurden keine Symbole gefunden.")).toBeInTheDocument();
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
