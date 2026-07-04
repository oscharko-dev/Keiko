/**
 * Keyboard-navigation a11y tests for the editor tablist (GEN-UI-KEYBOARD-001).
 *
 * The tablist uses a roving tabindex (EditorRuntimeWidget renders role="tab" with tabIndex active?0:-1).
 * EditorWidget owns the missing navigation handler wired through `renderTabHandle().onKeyDown`
 * (`handleTabKeyDown`): plain ArrowLeft/ArrowRight move the roving tab-stop and activate the target;
 * Home/End jump to the first/last tab; DOM focus follows the active tab.
 *
 * This renders the full EditorWidget with a lightweight runtime probe that reproduces the REAL tab
 * markup — role="tab", data-pane-id, data-tab-file, roving tabIndex, and the spread `renderTabHandle`
 * handle (which carries the onKeyDown) — so the actual EditorWidget handler + focus-follow code path is
 * exercised against real DOM (the `focusTabButton` selector matches [role="tab"][data-pane-id][data-tab-file]).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";
import { EditorWidget } from "./EditorWidget";

vi.mock("next/dynamic", () => ({
  default: () => {
    function RuntimeProbe(props: EditorRuntimeWidgetProps): ReactNode {
      const openFiles = props.openFiles ?? [];
      return (
        <div data-testid="runtime-probe" data-pane={props.paneId ?? "root"}>
          <div role="tablist" aria-label="Open documents">
            {openFiles.map((path) => {
              const active = path === props.file;
              const handle = props.renderTabHandle?.(
                path,
                active,
                props.dirtyFiles?.includes(path) ?? false,
              );
              return (
                <button
                  key={`${props.paneId ?? "pane"}-${path}`}
                  type="button"
                  role="tab"
                  aria-selected={active ? "true" : "false"}
                  aria-label={`Tab ${path}`}
                  tabIndex={active ? 0 : -1}
                  data-pane-id={props.paneId}
                  data-tab-file={path}
                  onClick={() => props.onSelectOpenFile?.(path)}
                  {...handle}
                >
                  {path}
                </button>
              );
            })}
          </div>
          {props.toolbarExtras}
        </div>
      );
    }
    return RuntimeProbe;
  },
}));

vi.mock("./FilesWidget", () => ({
  FilesWidget: ({ root }: { readonly root?: string }) => (
    <div data-testid="files-probe">{root ?? ""}</div>
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function tab(path: string): HTMLElement {
  return screen.getByRole("tab", { name: `Tab ${path}` });
}

describe("Editor tablist keyboard navigation (GEN-UI-KEYBOARD-001)", () => {
  it("ArrowRight/ArrowLeft move focus to the adjacent tab and activate it", () => {
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
      />,
    );

    const first = tab("src/a.ts");
    first.focus();
    expect(document.activeElement).toBe(first);

    // ArrowRight → next tab (src/b.ts) becomes focused + active.
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("src/b.ts"));
    expect(tab("src/b.ts")).toHaveAttribute("aria-selected", "true");

    // ArrowLeft → previous tab (src/a.ts) becomes focused + active again.
    fireEvent.keyDown(tab("src/b.ts"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("src/a.ts"));
    expect(tab("src/a.ts")).toHaveAttribute("aria-selected", "true");
  });

  it("ArrowLeft from the first tab wraps to the last tab", () => {
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
      />,
    );

    const first = tab("src/a.ts");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("src/c.ts"));
  });

  it("Home and End jump focus to the first and last tab", () => {
    render(
      <EditorWidget
        root="/repo"
        file="src/b.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
      />,
    );

    const middle = tab("src/b.ts");
    middle.focus();

    fireEvent.keyDown(middle, { key: "End" });
    expect(document.activeElement).toBe(tab("src/c.ts"));

    fireEvent.keyDown(tab("src/c.ts"), { key: "Home" });
    expect(document.activeElement).toBe(tab("src/a.ts"));
  });

  it("keeps the existing Alt+ArrowRight tab reorder behavior intact (no activation change)", () => {
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts", "src/c.ts"]}
      />,
    );

    const first = tab("src/a.ts");
    first.focus();
    // Alt+ArrowRight reorders the active tab one slot to the right; the active file stays src/a.ts.
    fireEvent.keyDown(first, { key: "ArrowRight", altKey: true });
    expect(tab("src/a.ts")).toHaveAttribute("aria-selected", "true");
  });
});
