/**
 * Accessibility smoke tests for the EditorWidget layout chrome (Issue #1375, ADR-0064).
 *
 * Covers the keyboard-focus and tab/split controls the issue calls out:
 *   - jest-axe reports no WCAG violations for a split workspace.
 *   - Split resizers expose the WAI-ARIA window-splitter pattern (role=separator,
 *     aria-orientation, aria-valuemin/max/now) and remain keyboard operable.
 *   - Pane split controls, the sidebar toggle, and the sidebar resizer all carry
 *     accessible names.
 *   - Drag-only drop zones stay hidden from assistive technology.
 *
 * Uses the lightweight runtime probe from EditorWidget.workspace.test.tsx so the
 * test exercises the widget chrome without mounting the Monaco runtime.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";
import { EditorWidget } from "./EditorWidget";

vi.mock("next/dynamic", () => ({
  default: () => {
    function RuntimeProbe(props: EditorRuntimeWidgetProps): ReactNode {
      return (
        <div data-testid="runtime-probe">
          <div className="ed-probe-tabs">
            {(props.openFiles ?? []).map((path) => {
              const handle = props.renderTabHandle?.(
                path,
                path === props.file,
                props.dirtyFiles?.includes(path) ?? false,
              );
              return (
                <button
                  key={`${props.paneId ?? "pane"}-${path}`}
                  type="button"
                  aria-label={`Tab handle ${props.paneId ?? "pane"} ${path}`}
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

describe("EditorWidget — accessibility (Issue #1375)", () => {
  it("has no axe violations and accessible names for every layout control in a split workspace", async () => {
    const { container } = render(
      <EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts down" }));

    expect(await axe(container)).toHaveNoViolations();

    expect(screen.getByRole("button", { name: "Hide project tree" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resize project tree" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Split src/a.ts right" }).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByRole("button", { name: "Close split src/a.ts" }).length).toBeGreaterThan(
      0,
    );
  });

  it("exposes the WAI-ARIA window-splitter pattern on the split resizer", () => {
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Split src/a.ts down" }));

    const separator = screen.getByRole("separator", { name: "Resize editor split" });
    // A column split divides the area top/bottom, so the separator is horizontal.
    expect(separator).toHaveAttribute("aria-orientation", "horizontal");
    expect(separator).toHaveAttribute("aria-valuemin", "15");
    expect(separator).toHaveAttribute("aria-valuemax", "85");
    expect(separator).toHaveAttribute("aria-valuenow", "50");
    expect(separator.tabIndex).toBe(0);
  });

  it("keeps drag-only drop zones hidden from assistive technology", () => {
    const { container } = render(
      <EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />,
    );
    const dropZoneHost = container.querySelector(".ed-pane-drop-zones");
    expect(dropZoneHost).toHaveAttribute("aria-hidden", "true");
    for (const zone of within(dropZoneHost as HTMLElement).queryAllByRole("button", {
      hidden: true,
    })) {
      expect(zone).toHaveAttribute("tabindex", "-1");
    }
  });
});
