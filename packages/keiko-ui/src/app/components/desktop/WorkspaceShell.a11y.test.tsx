import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { Footer } from "./Footer";
import { Header } from "./Header";
import { LeftRail } from "./LeftRail";
import { RightRail } from "./RightRail";
import { Workspace } from "./Workspace";
import { WsContext, type WsContextValue } from "./context/WsContext";
import type { UseWorkspaceResult, WorkspaceApi } from "./hooks/useWorkspace.types";
import { InspectorPanel } from "./widgets/panels/InspectorPanel";
import type { AppWindow } from "./windows/types";
import { workspaceApiFixture } from "../../../test-utils/workspace-api-fixture";

// Matches Workspace.test.tsx's own convention: the shader is a next/dynamic,
// SSR-disabled import, so leaving it unmocked resolves outside of React's act()
// tracking and produces "not wrapped in act(...)" noise the moment a test
// triggers any state update (e.g. the clipboard-status keydown test below).
vi.mock("./WorkspaceShader", () => ({
  WorkspaceShader: (): null => null,
}));

function appWindow(patch: Partial<AppWindow> & Pick<AppWindow, "id" | "type">): AppWindow {
  return {
    x: 40,
    y: 40,
    w: 320,
    h: 260,
    z: 1,
    cfg: {},
    max: false,
    zoom: 1,
    ...patch,
  };
}

const api = workspaceApiFixture;

function workspace(partial: Partial<UseWorkspaceResult>): UseWorkspaceResult {
  const wins = partial.wins ?? [];
  return {
    wins,
    winsById: new Map(wins.map((win) => [win.id, win])),
    snapPrev: null,
    palOpen: false,
    setPalOpen: vi.fn(),
    conns: [],
    connecting: null,
    selection: { focusedWindowId: null, selectedWindowIds: [] },
    view: { x: 0, y: 0, zoom: 1 },
    api: api(),
    ...partial,
  };
}

describe("Workspace shell accessibility", () => {
  it("passes jest-axe across the shell regions and focused governance panel", async () => {
    const reviewWindow = appWindow({
      id: "review-1",
      type: "review",
      cfg: { runId: "run-123" },
    });
    const wsContextValue: WsContextValue = {
      active: reviewWindow,
      winCount: 1,
    };

    const { container } = render(
      <div className="app">
        <Header
          openCommandPalette={vi.fn()}
          onTileAll={vi.fn()}
          onSplitFront={vi.fn()}
          onCascade={vi.fn()}
        />
        <div className="mid">
          <LeftRail
            openTools={new Set(["project", "inspector"])}
            onTool={vi.fn()}
            onNewChat={vi.fn()}
            theme="dark"
            onToggleTheme={vi.fn()}
          />
          <div className="stage">
            <Workspace
              ws={workspace({ wins: [reviewWindow] })}
              wsRef={{ current: null }}
              openPalette={vi.fn()}
            />
          </div>
          <RightRail openTools={new Set(["inspector"])} onTool={vi.fn()} />
        </div>
        <Footer
          winCount={1}
          windows={[reviewWindow]}
          windowPaletteOpen={false}
          onToggleWindowPalette={vi.fn()}
          onSelectWindow={vi.fn()}
          onCloseWindowPalette={vi.fn()}
        />
        <WsContext.Provider value={wsContextValue}>
          <InspectorPanel />
        </WsContext.Provider>
      </div>,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("keeps the shell axe-clean (name/role/value, landmarks) under Light theme after the #1293 migration", async () => {
    // #1293 migrated the shell/chrome CSS to semantic/component tokens — a visual-only,
    // value-preserving change that touches no JSX/ARIA. This re-runs the full-shell axe
    // gate with the Light theme active (data-theme="light") so the structural a11y
    // contract (name/role/value, roles, landmarks) is held on the first-class Light
    // acceptance surface as well as Dark. (Focus-ring visibility and colour-token
    // preservation are covered by the globals.css.test.ts string contract + the
    // computed-value evidence in docs/design-system/evidence/1293/, since jsdom axe does
    // not compute outline rendering or colour contrast.)
    document.documentElement.setAttribute("data-theme", "light");
    try {
      const reviewWindow = appWindow({ id: "review-1", type: "review", cfg: { runId: "run-123" } });
      const { container } = render(
        <div className="app" data-theme="light">
          <Header
            openCommandPalette={vi.fn()}
            onTileAll={vi.fn()}
            onSplitFront={vi.fn()}
            onCascade={vi.fn()}
          />
          <div className="mid">
            <LeftRail
              openTools={new Set(["project", "inspector"])}
              onTool={vi.fn()}
              onNewChat={vi.fn()}
              theme="light"
              onToggleTheme={vi.fn()}
            />
            <div className="stage">
              <Workspace
                ws={workspace({ wins: [reviewWindow] })}
                wsRef={{ current: null }}
                openPalette={vi.fn()}
              />
            </div>
            <RightRail openTools={new Set(["inspector"])} onTool={vi.fn()} />
          </div>
          <Footer
            winCount={1}
            windows={[reviewWindow]}
            windowPaletteOpen={false}
            onToggleWindowPalette={vi.fn()}
            onSelectWindow={vi.fn()}
            onCloseWindowPalette={vi.fn()}
          />
        </div>,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    } finally {
      document.documentElement.removeAttribute("data-theme");
    }
  });

  it("passes jest-axe for the autonomous-mode footer window trigger", async () => {
    const { container } = render(
      <Footer
        winCount={2}
        windows={[]}
        windowPaletteOpen={false}
        onToggleWindowPalette={vi.fn()}
        onSelectWindow={vi.fn()}
        onCloseWindowPalette={vi.fn()}
      />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Issue #2150 follow-up — the copy/cut/paste outcome pill (Workspace.tsx
  // WorkspaceClipboardStatusView) is a role="status" aria-live region that only
  // carries text once a clipboard command runs; the whole-shell axe pass above
  // only ever exercises its empty, data-visible="false" resting state. Trigger
  // the announcement so axe evaluates the region in the state assistive tech
  // actually reads it in.
  it("passes jest-axe while the clipboard status pill is announcing an outcome", async () => {
    // A non-empty `wins` keeps the workspace out of its empty-state layout,
    // which lazily loads EmptyWorkspaceBlob (a next/dynamic component, same
    // family as the mocked WorkspaceShader) — irrelevant to this assertion.
    const reviewWindow = appWindow({ id: "review-1", type: "review", cfg: { runId: "run-123" } });
    const copySelectedWindows = vi.fn(() => ({ captured: 1, skipped: 0, overflow: 0 }));
    const { container } = render(
      <Workspace
        ws={workspace({ wins: [reviewWindow], api: api({ copySelectedWindows }) })}
        wsRef={{ current: null }}
        openPalette={vi.fn()}
      />,
    );
    const surface = screen.getByRole("main", { name: "Workspace surface" });

    fireEvent.keyDown(surface, { key: "c", ctrlKey: true });

    const status = screen.getByTestId("workspace-clipboard-status");
    expect(status).toHaveAttribute("data-visible", "true");
    expect(status).toHaveTextContent("1 window copied");

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("preserves #1293 shell focus order and keyboard activation across chrome regions", async () => {
    const user = userEvent.setup();
    const onTileAll = vi.fn();
    const onSplitFront = vi.fn();
    const onCascade = vi.fn();
    const onNewChat = vi.fn();
    const onTool = vi.fn();
    const onToggleTheme = vi.fn();
    const openPalette = vi.fn();
    const openCommandPalette = vi.fn();
    const wsApi = api();

    render(
      <div className="app">
        <Header
          openCommandPalette={openCommandPalette}
          onTileAll={onTileAll}
          onSplitFront={onSplitFront}
          onCascade={onCascade}
        />
        <div className="mid">
          <LeftRail
            openTools={new Set(["chatHistory"])}
            onTool={onTool}
            onNewChat={onNewChat}
            theme="dark"
            onToggleTheme={onToggleTheme}
          />
          <div className="stage">
            <Workspace
              ws={workspace({ wins: [], api: wsApi })}
              wsRef={{ current: null }}
              openPalette={openPalette}
            />
          </div>
        </div>
      </div>,
    );

    const tabTo = async (element: HTMLElement): Promise<void> => {
      await user.tab();
      expect(element).toHaveFocus();
    };

    await tabTo(screen.getByRole("button", { name: "Open quick access" }));
    await user.keyboard("{Enter}");
    expect(openCommandPalette).toHaveBeenCalledTimes(1);

    await tabTo(screen.getByRole("button", { name: "Tile all windows" }));
    await user.keyboard("{Enter}");
    expect(onTileAll).toHaveBeenCalledTimes(1);

    await tabTo(screen.getByRole("button", { name: "Split front windows" }));
    await tabTo(screen.getByRole("button", { name: "Cascade windows" }));
    await user.keyboard("{Enter}");
    expect(onCascade).toHaveBeenCalledTimes(1);

    await tabTo(screen.getByRole("button", { name: "New chat" }));
    await user.keyboard(" ");
    expect(onNewChat).toHaveBeenCalledTimes(1);

    await tabTo(screen.getByRole("button", { name: "Chat History" }));
    await user.keyboard("{Enter}");
    expect(onTool).toHaveBeenCalledWith("chatHistory");

    await tabTo(screen.getByRole("button", { name: "MemoriaViva" }));
    await tabTo(screen.getByRole("button", { name: "Quality Intelligence" }));
    await tabTo(screen.getByRole("button", { name: "Prompt Enhancer" }));
    await tabTo(screen.getByRole("button", { name: "Coding Workbench" }));
    await tabTo(screen.getByRole("button", { name: "Git" }));
    await tabTo(screen.getByRole("button", { name: "Editor" }));
    await tabTo(screen.getByRole("button", { name: "Local Knowledge" }));
    await tabTo(screen.getByRole("button", { name: "Figma Snapshot" }));

    await tabTo(screen.getByRole("button", { name: "Light mode" }));
    await user.keyboard("{Enter}");
    expect(onToggleTheme).toHaveBeenCalledTimes(1);

    await tabTo(screen.getByRole("button", { name: "Settings" }));
    await tabTo(screen.getByRole("main", { name: "Workspace surface" }));
    await tabTo(screen.getByRole("button", { name: "Open a new window" }));
    await user.keyboard("{Enter}");
    expect(openPalette).toHaveBeenCalledTimes(1);

    await tabTo(screen.getByRole("button", { name: "Zoom out" }));
    await user.keyboard("{Enter}");
    expect(wsApi.zoomTo).toHaveBeenNthCalledWith(1, 0.8);

    await tabTo(screen.getByRole("button", { name: /100%.*reset/u }));
    await user.keyboard("{Enter}");
    expect(wsApi.resetView).toHaveBeenCalledTimes(1);

    await tabTo(screen.getByRole("button", { name: "Zoom in" }));
    await user.keyboard("{Enter}");
    expect(wsApi.zoomTo).toHaveBeenNthCalledWith(2, 1.2);

    await tabTo(screen.getByRole("button", { name: "New window" }));
    await user.keyboard("{Enter}");
    expect(openPalette).toHaveBeenCalledTimes(2);

    expect(onSplitFront).not.toHaveBeenCalled();
  });
});
