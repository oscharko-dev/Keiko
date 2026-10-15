import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowRenderContext } from "../../windows/WindowsRegistry";
import type { QiHubPanelProps } from "./QiHubPanel";
import type { QiRunCardProps } from "./QiRunCard";
import {
  buildConnectedRunSources,
  connectedRunSourcesCfgFromInlineSources,
  connectedRunSourcesCfgFromSources,
  connectedRunSourcesFromWindowCfg,
} from "./connectedSources";

const panels = vi.hoisted(() => ({
  hub: vi.fn<(props: QiHubPanelProps) => ReactNode>(() => null),
  run: vi.fn<(props: QiRunCardProps) => ReactNode>(() => null),
}));
vi.mock("./QiHubPanel", () => ({ QiHubPanel: panels.hub }));
vi.mock("./QiRunCard", () => ({ QiRunCard: panels.run }));

import { QiHubWindowHost } from "./QiHubWindowHost";
import { QiRunWindowHost } from "./QiRunWindowHost";

function context(): WindowRenderContext {
  return {
    windowId: "quality-window",
    mini: false,
    linkedRoot: "/source",
    linkedFilePath: "concept.md",
    linkedRoots: ["/source", "/other"],
    linkedCapsuleIds: ["capsule-1"],
    linkedCapsuleSetIds: ["set-1"],
    linkedFigmaSnapshotRunIds: ["snapshot-1"],
    activeRoot: null,
    activeBinding: null,
    updateCfg: vi.fn(),
    openWindow: vi.fn(() => "run-window"),
    focusWindow: vi.fn(),
    updateWindow: vi.fn(),
    openEditorFile: vi.fn(() => ({ ok: false as const, message: "Unavailable" })),
  };
}

beforeEach((): void => {
  panels.hub.mockClear();
  panels.run.mockClear();
});

describe("Quality Intelligence window hosts", () => {
  it("passes connected sources through and uses the existing source builder for new runs", () => {
    const ctx = context();
    render(<QiHubWindowHost ctx={ctx} />);
    const props = panels.hub.mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({
      connectedRoot: ctx.linkedRoot,
      connectedFilePath: ctx.linkedFilePath,
      connectedRoots: ctx.linkedRoots,
      connectedCapsuleIds: ctx.linkedCapsuleIds,
      connectedCapsuleSetIds: ctx.linkedCapsuleSetIds,
      connectedFigmaSnapshotRunIds: ctx.linkedFigmaSnapshotRunIds,
    });
    props?.openRun("new-run");
    expect(ctx.openWindow).toHaveBeenCalledWith("qiRun", {
      runId: "new-run",
      ...connectedRunSourcesCfgFromSources(buildConnectedRunSources(props ?? {})),
    });
  });

  it("preserves explicit empty historical sources instead of borrowing current connections", () => {
    const ctx = context();
    render(<QiHubWindowHost ctx={ctx} />);
    panels.hub.mock.calls.at(-1)?.[0].openRun("historical-run", []);
    expect(ctx.openWindow).toHaveBeenCalledWith("qiRun", {
      runId: "historical-run",
      ...connectedRunSourcesCfgFromInlineSources([]),
    });
  });

  it("normalizes an absent connected file to null", () => {
    const ctx = { ...context(), linkedFilePath: undefined };
    render(<QiHubWindowHost ctx={ctx} />);
    const props = panels.hub.mock.calls.at(-1)?.[0];
    expect(props?.connectedFilePath).toBeNull();
    props?.openRun("folder-run");
    expect(ctx.openWindow).toHaveBeenCalledWith("qiRun", {
      runId: "folder-run",
      ...connectedRunSourcesCfgFromSources(buildConnectedRunSources(props ?? {})),
    });
  });

  it.each([undefined, "", 12])("keeps the empty state for an invalid run ID %s", (runId) => {
    const view = render(<QiRunWindowHost cfg={{ runId }} ctx={context()} />);
    expect(view.getByText("Open a run from the Quality Intelligence hub.")).toBeVisible();
    expect(panels.run).not.toHaveBeenCalled();
  });

  it("retains original sources when opening a new immutable regenerated run", () => {
    const ctx = context();
    const cfg = {
      runId: "original-run",
      ...connectedRunSourcesCfgFromSources(
        buildConnectedRunSources({ connectedRoot: "/original", connectedFilePath: "rules.md" }),
      ),
    };
    const expectedSources = connectedRunSourcesFromWindowCfg(cfg);
    render(<QiRunWindowHost cfg={cfg} ctx={ctx} />);
    const props = panels.run.mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({ runId: "original-run", connectedSources: expectedSources });
    props?.onRegenerated?.({ runId: "regenerated-run", regeneratedCount: 1, preservedCount: 2 });
    expect(ctx.openWindow).toHaveBeenCalledWith("qiRun", {
      runId: "regenerated-run",
      ...connectedRunSourcesCfgFromSources(expectedSources),
    });
    expect(ctx.updateCfg).not.toHaveBeenCalled();
  });
});
