// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CallHierarchyPanel, type CallHierarchyPanelLabels } from "./CallHierarchyPanel.js";

const labels: CallHierarchyPanelLabels = {
  title: "Call hierarchy",
  incoming: "Incoming calls",
  outgoing: "Outgoing calls",
  callSite: "Call site",
  empty: "No calls found.",
  close: "Close hierarchy",
  command: "Show Call Hierarchy",
};

const range = { start: { line: 0, column: 0 }, end: { line: 0, column: 6 } };
const item = {
  name: "target",
  kind: "function" as const,
  path: "src/a.ts",
  range,
  selectionRange: range,
};

describe("CallHierarchyPanel", () => {
  it("renders every incoming call site and supports roving keyboard focus", () => {
    const onReveal = vi.fn();
    render(
      <CallHierarchyPanel
        labels={labels}
        response={{
          request: { requestId: "r", streamId: "s", sequence: 1 },
          roots: [
            {
              item,
              incomingCalls: [{ item: { ...item, name: "caller" }, fromRanges: [range, range] }],
              outgoingCalls: [],
            },
          ],
        }}
        onClose={vi.fn()}
        onReveal={onReveal}
      />,
    );

    const root = screen.getByRole("treeitem", { name: "target" });
    const caller = screen.getByRole("treeitem", { name: "Incoming calls: caller" });
    expect(screen.getAllByRole("treeitem", { name: /Call site/u })).toHaveLength(2);
    // WCAG 4.1.2 (S6807): a "treeitem" role must expose its selection state via aria-selected.
    expect(root).toHaveAttribute("aria-selected", "true");
    expect(caller).toHaveAttribute("aria-selected", "false");
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(document.activeElement).toBe(caller);
    expect(root).toHaveAttribute("aria-selected", "false");
    expect(caller).toHaveAttribute("aria-selected", "true");
    fireEvent.click(caller);
    expect(onReveal).toHaveBeenCalledWith({ path: "src/a.ts", range });
  });
});
