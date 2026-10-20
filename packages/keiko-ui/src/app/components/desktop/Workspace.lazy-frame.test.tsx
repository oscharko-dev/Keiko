import { createRef, type ReactElement } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import type { UseWorkspaceResult } from "./hooks/useWorkspace.types";
import type { AppWindow } from "./windows/types";
import { workspaceApiFixture } from "../../../test-utils/workspace-api-fixture";

const gate = vi.hoisted(() => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
});
vi.mock("./WorkspaceShader", () => ({ WorkspaceShader: (): null => null }));
vi.mock("./windows/WindowFrame", async (original) => {
  await gate.pending;
  return original();
});

function appWindow(id: string, minimized: boolean, x = 40): AppWindow {
  return {
    id,
    type: "agents",
    x,
    y: 40,
    w: 320,
    h: 260,
    z: 1,
    cfg: {},
    max: false,
    zoom: 1,
    minimized,
  };
}

function view(wins: AppWindow[]): ReactElement {
  const ws: UseWorkspaceResult = {
    wins,
    winsById: new Map(wins.map((win) => [win.id, win])),
    snapPrev: null,
    layoutLocked: false,
    palOpen: false,
    setPalOpen: vi.fn(),
    conns: [],
    connecting: null,
    selection: { focusedWindowId: null, selectedWindowIds: [] },
    view: { x: 0, y: 0, zoom: 1 },
    api: workspaceApiFixture(),
  };
  return <Workspace ws={ws} wsRef={createRef<HTMLDivElement>()} openPalette={() => undefined} />;
}

async function settleFrame(): Promise<void> {
  await act(async () => {
    gate.release();
    await vi.dynamicImportSettled();
  });
}

it("keeps pending minimized frames hidden and applies current props without resurrecting removed windows", async () => {
  const { container, rerender, unmount } = render(
    view([appWindow("retained", true), appWindow("removed", false)]),
  );
  try {
    const hiddenFallback = container.querySelector('[hidden] [data-window-chunk="loading"]');
    expect(hiddenFallback).not.toBeNull();
    expect(hiddenFallback).not.toBeVisible();
    expect(container.querySelectorAll('[data-window-chunk="loading"]')).toHaveLength(2);
    rerender(view([appWindow("retained", false, 88)]));
    expect(container.querySelectorAll('[data-window-chunk="loading"]')).toHaveLength(1);
    expect(container.querySelector('[data-window-chunk="loading"]')).toBeVisible();
    await settleFrame();
    await waitFor(() =>
      expect(container.querySelector('[data-window-id="retained"]')).not.toBeNull(),
    );
    const retained = container.querySelector('[data-window-id="retained"]');
    expect(retained).toHaveStyle({ transform: "translate3d(88px, 40px, 0)" });
    expect(container.querySelector('[data-window-id="removed"]')).toBeNull();
    expect(container.querySelector("[data-window-chunk]")).toBeNull();
    rerender(view([appWindow("retained", true, 88)]));
    expect(container.querySelector('[data-window-id="retained"]')).toBe(retained);
    expect(retained).not.toBeVisible();
    rerender(view([appWindow("retained", false, 88)]));
    expect(container.querySelector('[data-window-id="retained"]')).toBe(retained);
    expect(retained).toBeVisible();
  } finally {
    unmount();
    await settleFrame();
  }
});
