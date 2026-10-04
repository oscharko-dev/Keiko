import { useRef, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeftRail } from "./LeftRail";
import { useWorkspace } from "./hooks/useWorkspace";
import { WIN_TYPES } from "./windows/WindowsRegistry";
import { WIN_META } from "./windows/descriptor-meta";

function WorkspaceHarness(): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const ws = useWorkspace(ref);
  const diagnostics = ws.wins?.find((win) => win.type === "diagnostics");
  return (
    <main ref={ref} className="workspace">
      <LeftRail
        openTools={new Set(ws.wins?.map((win) => win.type))}
        onTool={() => ws.api.toggleTool("diagnostics")}
        onNewChat={vi.fn()}
        theme="dark"
        onToggleTheme={vi.fn()}
      />
      {diagnostics === undefined ? null : (
        <section aria-label="Diagnosis window" data-window-id={diagnostics.id}>
          <button onClick={() => ws.api.close(diagnostics.id)}>Close diagnosis window</button>
          <button onClick={() => ws.api.update(diagnostics.id, { x: 73, y: 81 })}>
            Move diagnosis window
          </button>
          <output>{`${String(diagnostics.x)},${String(diagnostics.y)}`}</output>
        </section>
      )}
    </main>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.localStorage.setItem("keiko.workspace.v4", "[]");
  Object.defineProperty(navigator, "webdriver", { configurable: true, value: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Diagnostics workspace window", () => {
  it("uses the registered singleton lifecycle and persists placement across a reload", async () => {
    expect(WIN_TYPES.diagnostics.singleton).toBe(true);
    expect(WIN_META.diagnostics.persistence).toBe("durable.ui");
    const view = render(<WorkspaceHarness />);
    await settle();
    act(() => screen.getByRole("button", { name: "Diagnostics" }).click());
    await settle();
    expect(screen.getByRole("button", { name: "Diagnostics" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    act(() => screen.getByRole("button", { name: "Move diagnosis window" }).click());
    act(() => window.dispatchEvent(new Event("pagehide")));
    view.unmount();
    render(<WorkspaceHarness />);
    await settle();
    expect(screen.getByText("73,81")).toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: "Diagnosis window" })).toHaveLength(1);
  });

  it("closes and reopens through the existing rail toggle and window close action", async () => {
    render(<WorkspaceHarness />);
    await settle();
    act(() => screen.getByRole("button", { name: "Diagnostics" }).click());
    await settle();
    act(() => screen.getByRole("button", { name: "Diagnostics" }).click());
    expect(screen.queryByRole("region", { name: "Diagnosis window" })).not.toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "Diagnostics" }).click());
    await settle();
    act(() => screen.getByRole("button", { name: "Close diagnosis window" }).click());
    expect(screen.getByRole("button", { name: "Diagnostics" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    act(() => screen.getByRole("button", { name: "Diagnostics" }).click());
    await settle();
    expect(screen.getAllByRole("region", { name: "Diagnosis window" })).toHaveLength(1);
  });
});
