// Epic #518 / Issue #528 — Inspector governance section integration test.
//
// Pins that the InspectorPanel reads the WIN_META sidecar table and surfaces
// the focused window's lifecycle / trust / authority / persistence metadata
// from packages/keiko-contracts. This is the UI integration that makes the
// descriptor metadata visible to the user.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WsContext, type WsContextValue } from "../../context/WsContext";
import type { AppWindow } from "../../windows/types";
import { InspectorPanel } from "./InspectorPanel";

function makeWindow(patch: Partial<AppWindow> & Pick<AppWindow, "id" | "type">): AppWindow {
  return {
    x: 0,
    y: 0,
    w: 320,
    h: 240,
    z: 1,
    cfg: {},
    max: false,
    ...patch,
  };
}

function renderWithFocus(active: AppWindow | null): void {
  const value: WsContextValue = {
    wins: active !== null ? [active] : [],
    active,
    winCount: active !== null ? 1 : 0,
  };
  render(
    <WsContext.Provider value={value}>
      <InspectorPanel />
    </WsContext.Provider>,
  );
}

describe("InspectorPanel — governance section (epic #518 #528 / ADR-0029)", () => {
  it("renders the governance section when a window is focused", () => {
    renderWithFocus(makeWindow({ id: "w-1", type: "review" }));
    expect(screen.getByTestId("insp-governance")).toBeInTheDocument();
    expect(screen.getByText("Authority")).toBeInTheDocument();
    expect(screen.getByText("Persistence")).toBeInTheDocument();
    expect(screen.getByText("Trust")).toBeInTheDocument();
    expect(screen.getByText("Lifecycle")).toBeInTheDocument();
  });

  it("surfaces the review descriptor's evidence-reference persistence + evidence trust", () => {
    renderWithFocus(makeWindow({ id: "w-1", type: "review" }));
    expect(screen.getByText("evidence-reference")).toBeInTheDocument();
    expect(screen.getByText("ui, evidence")).toBeInTheDocument();
    expect(screen.getByText("user-confirm")).toBeInTheDocument();
  });

  it("surfaces the chat descriptor's model trust + user-confirm authority", () => {
    renderWithFocus(makeWindow({ id: "w-2", type: "chat" }));
    expect(screen.getByText("user-confirm")).toBeInTheDocument();
    expect(screen.getByText("ui, model, evidence")).toBeInTheDocument();
    expect(screen.getByText("durable.ui")).toBeInTheDocument();
  });

  it("surfaces the terminal descriptor's tool trust + user-confirm authority", () => {
    renderWithFocus(makeWindow({ id: "w-3", type: "terminal" }));
    expect(screen.getByText("user-confirm")).toBeInTheDocument();
    expect(screen.getByText("ui, tool")).toBeInTheDocument();
  });

  it("surfaces the inspector descriptor's ui-only authority", () => {
    renderWithFocus(makeWindow({ id: "w-4", type: "inspector" }));
    expect(screen.getByText("ui-only")).toBeInTheDocument();
  });

  it("does NOT render the governance section when no window is focused", () => {
    renderWithFocus(null);
    expect(screen.queryByTestId("insp-governance")).toBeNull();
    expect(screen.getByText("No window focused")).toBeInTheDocument();
  });

  it("renders lifecycle states joined with arrow separators (deterministic ordering)", () => {
    renderWithFocus(makeWindow({ id: "w-5", type: "review" }));
    const lifecycleRow = screen.getByText(/proposed → needs-review → applied/);
    expect(lifecycleRow).toBeInTheDocument();
  });
});
