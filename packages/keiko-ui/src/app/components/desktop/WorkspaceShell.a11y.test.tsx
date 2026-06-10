import { render } from "@testing-library/react";
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

function api(patch: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    add: vi.fn(() => null),
    toggleTool: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    maximize: vi.fn(),
    update: vi.fn(),
    setSnap: vi.fn(),
    commitSnap: vi.fn(),
    tileAll: vi.fn(),
    splitFront: vi.fn(),
    cascade: vi.fn(),
    startConnect: vi.fn(),
    confirmConnect: vi.fn(),
    cancelConnect: vi.fn(),
    removeConn: vi.fn(),
    connect: vi.fn(),
    linkedFilesRoot: vi.fn(() => null),
    linkedAllFilesRoots: vi.fn(() => []),
    linkedConnectorCapsuleIds: vi.fn(() => []),
    linkedConnectorCapsuleSetIds: vi.fn(() => []),
    linkedFigmaSnapshotRunIds: vi.fn(() => []),
    linkedFilesContext: vi.fn(() => null),
    currentFilesContext: vi.fn(() => null),
    zoomTo: vi.fn(),
    resetView: vi.fn(),
    panBy: vi.fn(),
    rect: vi.fn(() => null),
    ...patch,
  };
}

function workspace(partial: Partial<UseWorkspaceResult>): UseWorkspaceResult {
  return {
    wins: [],
    snapPrev: null,
    palOpen: false,
    setPalOpen: vi.fn(),
    conns: [],
    connecting: null,
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
      wins: [reviewWindow],
      active: reviewWindow,
      winCount: 1,
    };

    const { container } = render(
      <div className="app">
        <Header
          mode="manual"
          projectName="Keiko"
          onModeChange={vi.fn()}
          openPalette={vi.fn()}
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
          mode="manual"
          selectedModel="gpt-5.5"
          projectName="Keiko"
          branchLabel="codex/issue-530-audit"
          shellStatusLabel="Ready"
          evidenceStatusLabel="Evidence ready"
        />
        <WsContext.Provider value={wsContextValue}>
          <InspectorPanel />
        </WsContext.Provider>
      </div>,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Autonomous mode swaps the footer governance pill to the accent-bordered
  // "Keiko governing" variant (orca glyph + accent-dim fill). Render that path
  // so jest-axe exercises the autonomous footer structure. Note: axe-core
  // cannot resolve oklch()/color-mix() contrast under jsdom, so the pill's text
  // ratio is verified separately (the fix uses the theme-adaptive --fg-muted
  // label color, AA in both themes) and recorded in the PR.
  it("passes jest-axe for the autonomous-mode footer governance pill", async () => {
    const { container } = render(
      <Footer
        winCount={2}
        mode="autonomous"
        selectedModel="gpt-5.5"
        projectName="Keiko"
        branchLabel="dev"
        shellStatusLabel="Ready"
        evidenceStatusLabel="Evidence ready"
      />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
