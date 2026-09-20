// #3563 review: `CodingWorkbenchWindowHost.tsx` (the thin adapter between the windows registry and
// `CodingWorkbenchWindow`) forwards a successful bind to `context.updateCfg({ repositoryPath })`
// so the next time this window opens it seeds from the bound repository, and emits one bounded
// diagnostic so the activity log records that the operator's binding moved the per-window cfg.
// This test pins both without loading the full runtime (the window itself is fully mocked here).

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { WindowCfgRecord, WindowRenderContext } from "../../windows/WindowsRegistry";
import { CodingWorkbenchWindowHost } from "./CodingWorkbenchWindowHost";
import type { CodingWorkbenchGitTarget } from "./CodingWorkbenchWindow";

interface WindowProps {
  readonly selectedRoot?: string | undefined;
  readonly historySelection?: string | undefined;
  readonly onHistorySelectionHandled?: () => void;
  readonly onOpenHistory?: () => void;
  readonly onOpenGit?: (target: CodingWorkbenchGitTarget) => void;
  readonly onSelectRepository?: (root: string) => void;
}

const windowRendered = vi.hoisted(() => vi.fn<(props: WindowProps) => void>());
const diagnostics = vi.hoisted(() => ({ writes: [] as string[] }));

vi.mock("./CodingWorkbenchWindow", () => ({
  CodingWorkbenchWindow: (props: WindowProps): null => {
    windowRendered(props);
    return null;
  },
}));

vi.mock("@/lib/client-diagnostics", () => ({
  reportClientDiagnostic: (note: string): void => {
    diagnostics.writes.push(note);
  },
}));

function contextFixture(overrides: Partial<WindowRenderContext> = {}): WindowRenderContext {
  return {
    windowId: "window-1",
    linkedRoot: null,
    linkedFilePath: undefined,
    linkedRoots: [],
    linkedCapsuleIds: [],
    linkedCapsuleSetIds: [],
    linkedFigmaSnapshotRunIds: [],
    selectedRoot: null,
    activeRoot: null,
    activeBinding: null,
    updateCfg: vi.fn(),
    openWindow: vi.fn(() => "opened-window-id"),
    focusWindow: vi.fn(),
    updateWindow: vi.fn(),
    openEditorFile: vi.fn(() => ({ kind: "opened", windowId: "editor-1" })),
    ...overrides,
  } as WindowRenderContext;
}

function renderHost(
  cfg: WindowCfgRecord,
  overrides: Partial<WindowRenderContext> = {},
): WindowRenderContext {
  const context = contextFixture(overrides);
  render(<CodingWorkbenchWindowHost cfg={cfg} context={context} />);
  return context;
}

describe("CodingWorkbenchWindowHost", () => {
  it("prefers the per-window cfg repository over the shared context selection", () => {
    windowRendered.mockClear();
    renderHost({ repositoryPath: "/repos/cfg" }, { selectedRoot: "/repos/shared" });
    const props = windowRendered.mock.calls.at(-1)?.[0];
    expect(props?.selectedRoot).toBe("/repos/cfg");
  });

  it("falls back to the shared selection when the cfg carries no repositoryPath", () => {
    windowRendered.mockClear();
    renderHost({}, { selectedRoot: "/repos/shared" });
    const props = windowRendered.mock.calls.at(-1)?.[0];
    expect(props?.selectedRoot).toBe("/repos/shared");
  });

  it("persists the bound repository through onSelectRepository and emits a bounded diagnostic", () => {
    windowRendered.mockClear();
    diagnostics.writes = [];
    const context = renderHost({});
    const props = windowRendered.mock.calls.at(-1)?.[0];

    props?.onSelectRepository?.("/repos/newly-bound");

    // The one job of the host's callback: write the newly bound root to per-window cfg so a later
    // reopen seeds from it, and record the fact through the redacted client diagnostic sink.
    expect(context.updateCfg).toHaveBeenCalledExactlyOnceWith({
      repositoryPath: "/repos/newly-bound",
    });
    expect(diagnostics.writes).toContain("[keiko] coding workbench repository selection requested");
  });

  it("routes onOpenGit through openWindow with the derived Git target", () => {
    windowRendered.mockClear();
    const context = renderHost({});
    const props = windowRendered.mock.calls.at(-1)?.[0];

    props?.onOpenGit?.({ root: "/repos/x", binding: "repository" });

    expect(context.openWindow).toHaveBeenCalledWith("governedGit", {
      projectPath: "/repos/x",
      rootBinding: "coding-repository",
    });
  });

  it("opens the governed pull request window when a description review is requested", () => {
    windowRendered.mockClear();
    const context = renderHost({});
    const props = windowRendered.mock.calls.at(-1)?.[0];

    props?.onOpenGit?.({
      root: "/repos/y",
      binding: "task-workspace",
      descriptionReview: {
        ownerAndRepo: "owner/repo",
        prNumber: 42,
        proposalId: "proposal-1",
        snapshotDigest: "d".repeat(64),
      },
    });

    expect(context.openWindow).toHaveBeenCalledWith("governedPullRequest", {
      projectPath: "/repos/y",
      descriptionOwnerAndRepo: "owner/repo",
      descriptionPrNumber: 42,
      descriptionProposalId: "proposal-1",
      descriptionSnapshotDigest: "d".repeat(64),
    });
  });
});
