// GEN-STAB-WINDOW-001 — per-window error boundary. Before the boundary, a render throw
// inside any widget body propagated out of WindowFrame with no enclosing boundary and
// unmounted the entire canvas (white screen); the integration test below fails on the
// pre-fix tree exactly that way (the render() call throws). With the boundary, the crash
// degrades to a fallback inside the one window's body while the frame chrome — and every
// other window — keeps working.

import { createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WindowBodyBoundary } from "./WindowBodyBoundary";
import { WindowFrame } from "./WindowFrame";
import { registerWindowRender } from "./WindowsRegistry";
import type { AppWindow } from "./types";
import type { WorkspaceApi } from "../hooks/useWorkspace.types";
import { workspaceApiFixture } from "../../../../test-utils/workspace-api-fixture";

function appWindow(patch: Partial<AppWindow> = {}): AppWindow {
  return {
    id: "agents-1",
    type: "agents",
    x: 40,
    y: 40,
    w: 420,
    h: 320,
    z: 1,
    cfg: {},
    max: false,
    zoom: 1,
    ...patch,
  };
}

const api = workspaceApiFixture;

// Silences React's expected error-boundary console noise for a render that throws.
function withBoundaryNoise<T>(message: string, run: () => T): T {
  const onError = (event: ErrorEvent): void => {
    const text = event.error instanceof Error ? event.error.message : event.message;
    if (text.includes(message)) event.preventDefault();
  };
  window.addEventListener("error", onError);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return run();
  } finally {
    errorSpy.mockRestore();
    window.removeEventListener("error", onError);
  }
}

function Bomb({ armed }: { readonly armed: boolean }): React.JSX.Element {
  if (armed) throw new Error("forced widget defect");
  return <div>widget recovered</div>;
}

describe("WindowBodyBoundary", () => {
  it("degrades a throwing child to the fallback and logs the window type, not the title", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      withBoundaryNoise("forced widget defect", () =>
        render(
          <WindowBodyBoundary windowType="agents">
            <Bomb armed />
          </WindowBodyBoundary>,
        ),
      );
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText("This window hit an error")).toBeTruthy();
      // 0.3.0 audit (Qodo review on #2869): the boundary reports the window type and the error's
      // CLASS through the one client diagnostic sink. Strengthened, not adapted — the window type
      // that made this attributable is still asserted, and the raw Error is now pinned as absent.
      expect(warnSpy).toHaveBeenCalledWith("[keiko] window body crashed: agents: Error");
      for (const call of warnSpy.mock.calls) {
        for (const argument of call) {
          expect(argument).not.toBeInstanceOf(Error);
        }
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("re-renders the children when the user retries after the defect is gone", async () => {
    function Harness(): React.JSX.Element {
      const [armed, setArmed] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setArmed(false)}>
            disarm
          </button>
          <WindowBodyBoundary windowType="agents">
            <Bomb armed={armed} />
          </WindowBodyBoundary>
        </div>
      );
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      withBoundaryNoise("forced widget defect", () => render(<Harness />));
      expect(screen.getByRole("alert")).toBeTruthy();
      fireEvent.click(screen.getByText("disarm"));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("widget recovered")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("renders healthy children untouched", () => {
    render(
      <WindowBodyBoundary windowType="agents">
        <div>healthy body</div>
      </WindowBodyBoundary>,
    );
    expect(screen.getByText("healthy body")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // Integration: the pre-boundary tree makes this render() call THROW (the defect
  // propagates out of WindowFrame), so this test is red without the fix. With the
  // boundary, the frame chrome stays interactive: the close button still works.
  // The registered render returns a COMPONENT that throws — the realistic vector
  // (registry factories are defensive data mappers; widget render logic is not).
  it("keeps the window chrome alive when the registered widget render throws", () => {
    registerWindowRender("agents", () => <Bomb armed />);
    const close = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      withBoundaryNoise("forced widget defect", () =>
        render(
          <WindowFrame
            win={appWindow()}
            top
            connState={null}
            linkRevision={0}
            api={api({ close })}
            wsRef={createRef<HTMLElement>()}
          />,
        ),
      );
      expect(screen.getByRole("alert")).toBeTruthy();
      const closeButton = screen.getByRole("button", { name: /Close Agents window/i });
      fireEvent.click(closeButton);
      expect(close).toHaveBeenCalledWith("agents-1");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
