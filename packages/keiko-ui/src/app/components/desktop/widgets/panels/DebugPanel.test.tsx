import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchEvaluationResult } from "@oscharko-dev/keiko-contracts";
import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";
import { fetchCommandCatalog } from "../../../../../lib/commands-api";
import type { DebugSessionSnapshot } from "../cards/debugSessionStore";
import { useDebugSession } from "../cards/useDebugSession";
import { DebugPanel, draftWatchId } from "./DebugPanel";

vi.mock("../../../../../lib/commands-api", () => ({
  fetchCommandCatalog: vi.fn(),
}));

const actions = {
  refreshInstrumentation: vi.fn(async () => {}),
  refreshSession: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  control: vi.fn(async () => {}),
  saveBreakpoints: vi.fn(async () => {}),
  loadStack: vi.fn(async () => {}),
  loadScopes: vi.fn(async () => {}),
  loadVariables: vi.fn(async () => {}),
  saveWatches: vi.fn(async () => {}),
  saveExceptionFilters: vi.fn(async () => {}),
  evaluateWatch: vi.fn(async (): Promise<WatchEvaluationResult | null> => null),
  setVariable: vi.fn(async () => {}),
};

const snapshot: DebugSessionSnapshot = {
  instrumentation: {
    schemaVersion: "1",
    workspaceId: "canonical-workspace-id",
    revision: 1,
    etag: "etag",
    breakpoints: [],
    exceptionFilters: [
      { filterId: "caught", enabled: false },
      { filterId: "uncaught", enabled: true },
    ],
    watches: [{ watchId: "watch-1", expression: "total", enabled: true }],
  },
  session: {
    schemaVersion: "1",
    sessionId: "session-1",
    workspaceId: "canonical-workspace-id",
    status: "paused",
    targetKind: "file",
    activationRevision: 1,
    pauseGeneration: 2,
    startedAtMs: 1,
    wallDeadlineMs: 2,
    inactivityDeadlineMs: 3,
    output: { acceptedBytes: 0, truncated: false },
  },
  stack: {
    frames: [
      {
        frameRef: "frame-1",
        name: {
          value: "first",
          truncated: false,
          originalBytes: 5,
          retainedBytes: 5,
          omittedBytes: 0,
        },
        sourceFileId: "src/first.ts",
        line: 2,
        column: 1,
      },
      {
        frameRef: "frame-2",
        name: {
          value: "second",
          truncated: false,
          originalBytes: 6,
          retainedBytes: 6,
          omittedBytes: 0,
        },
        sourceFileId: "src/second.ts",
        line: 4,
        column: 1,
      },
    ],
    truncated: false,
    omittedCount: 0,
  },
  scopesByFrame: new Map([
    [
      "frame-1",
      {
        frameRef: "frame-1",
        scopes: [
          {
            scopeRef: "scope-1",
            name: {
              value: "Local",
              truncated: false,
              originalBytes: 5,
              retainedBytes: 5,
              omittedBytes: 0,
            },
            expensive: false,
          },
        ],
        truncated: false,
        omittedCount: 0,
      },
    ],
    [
      "frame-2",
      {
        frameRef: "frame-2",
        scopes: [
          {
            scopeRef: "scope-2",
            name: {
              value: "Arguments",
              truncated: false,
              originalBytes: 9,
              retainedBytes: 9,
              omittedBytes: 0,
            },
            expensive: false,
          },
        ],
        truncated: false,
        omittedCount: 0,
      },
    ],
  ]),
  variablesByParent: new Map([
    [
      "scope-1",
      {
        parentRef: "scope-1",
        nodes: [
          {
            kind: "variable",
            variableRef: "variable-1",
            name: {
              value: "item",
              truncated: false,
              originalBytes: 4,
              retainedBytes: 4,
              omittedBytes: 0,
            },
            value: {
              value: "1",
              truncated: false,
              originalBytes: 1,
              retainedBytes: 1,
              omittedBytes: 0,
            },
            presentation: "data",
            children: [],
            retainedCount: 0,
            omittedCount: 0,
            truncated: false,
          },
        ],
        truncated: false,
        omittedCount: 0,
      },
    ],
  ]),
  watchResults: new Map(),
  console: {
    entries: [{ id: 1, category: "stdout", text: "started", truncated: false }],
    retainedBytes: 7,
    evictedEntries: 0,
    evictedBytes: 0,
  },
  stopDescription: null,
  sequence: 1,
  streamReady: true,
};

vi.mock("../cards/useDebugSession", () => ({
  useDebugSession: vi.fn(() => ({ snapshot, actions })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
  vi.mocked(useDebugSession).mockReturnValue({ snapshot, actions });
});

describe("DebugPanel", () => {
  it("requires an explicit canonical workspace identity and never treats root as one", () => {
    render(<DebugPanel root="/repo" debugEnabled />);

    expect(screen.getByText(/canonical workspace identity/i)).toBeInTheDocument();
  });

  it("selects the clicked stack frame and reuses the standard open-editor request", async () => {
    const user = userEvent.setup();
    const openEditorFile = vi.fn();
    render(
      <DebugPanel
        root="/repo"
        workspaceId="canonical-workspace-id"
        debugEnabled
        openEditorFile={openEditorFile}
      />,
    );

    await user.click(screen.getByRole("button", { name: /second/i }));

    expect(screen.getByRole("button", { name: /second/i })).toHaveAttribute("aria-pressed", "true");
    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/second.ts",
      lineStart: 4,
      lineEnd: 4,
    });
    expect(actions.loadScopes).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
      "frame-2",
    );
  });

  it("reveals a same-file frame through onRevealFrame and never re-runs the window-mutation open-editor path", async () => {
    const user = userEvent.setup();
    const openEditorFile = vi.fn();
    const onRevealFrame = vi.fn();
    render(
      <DebugPanel
        root="/repo"
        workspaceId="canonical-workspace-id"
        activeFile="src/second.ts"
        debugEnabled
        openEditorFile={openEditorFile}
        onRevealFrame={onRevealFrame}
      />,
    );

    await user.click(screen.getByRole("button", { name: /second/i }));

    expect(onRevealFrame).toHaveBeenCalledWith(
      expect.objectContaining({ frameRef: "frame-2", sourceFileId: "src/second.ts" }),
    );
    expect(openEditorFile).not.toHaveBeenCalled();
  });

  it("still routes a cross-file frame through openEditorFile even when onRevealFrame is wired", async () => {
    const user = userEvent.setup();
    const openEditorFile = vi.fn();
    const onRevealFrame = vi.fn();
    render(
      <DebugPanel
        root="/repo"
        workspaceId="canonical-workspace-id"
        activeFile="src/first.ts"
        debugEnabled
        openEditorFile={openEditorFile}
        onRevealFrame={onRevealFrame}
      />,
    );

    await user.click(screen.getByRole("button", { name: /second/i }));

    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/second.ts",
      lineStart: 4,
      lineEnd: 4,
    });
    expect(onRevealFrame).not.toHaveBeenCalled();
  });

  it("starts only a closed-catalog file target with the server-projected activation revision", async () => {
    const user = userEvent.setup();
    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: { ...snapshot, session: null },
      actions,
    });
    render(
      <DebugPanel
        root="/repo"
        activeFile="src/program.ts"
        workspaceId="canonical-workspace-id"
        activationRevision={7}
        debugEnabled
      />,
    );

    await user.click(screen.getByRole("button", { name: /start debugging current file/i }));

    // The launch target now resolves asynchronously (`resolveDebugLaunchTarget`) before `start` is
    // invoked, even for a non-test file that never reaches the catalog-discovery branch.
    await waitFor(() =>
      expect(actions.start).toHaveBeenCalledWith({ kind: "file", fileId: "src/program.ts" }, 7),
    );
  });

  it("starts a recognized test file through the discovered, trusted catalog test task (Epic #2096, ADR-0136 D4)", async () => {
    const user = userEvent.setup();
    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: { ...snapshot, session: null },
      actions,
    });
    vi.mocked(fetchCommandCatalog).mockResolvedValueOnce({
      schemaVersion: "1",
      projectId: "/repo",
      tasks: [
        {
          id: "npm-script:test",
          kind: "test",
          label: "npm run test",
          executable: "npm",
          args: ["run", "test"],
          source: "package-json-script",
          trustState: "trusted",
          trustReason: "repository-authored-script",
        },
      ],
    });
    render(
      <DebugPanel
        root="/repo"
        activeFile="src/program.test.ts"
        workspaceId="canonical-workspace-id"
        activationRevision={7}
        debugEnabled
      />,
    );

    await user.click(screen.getByRole("button", { name: /start debugging current file/i }));

    expect(fetchCommandCatalog).toHaveBeenCalledWith("/repo");
    await waitFor(() =>
      expect(actions.start).toHaveBeenCalledWith(
        { kind: "catalog", targetId: "npm-script:test" },
        7,
      ),
    );
  });

  it("controls the current paused session through explicit debug controls", async () => {
    const user = userEvent.setup();
    render(<DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Step over" }));
    await user.click(screen.getByRole("button", { name: "Step into" }));
    await user.click(screen.getByRole("button", { name: "Step out" }));
    await user.click(screen.getByRole("button", { name: "Stop debugging" }));

    expect(actions.control).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: "session-1" }),
      "continue",
    );
    expect(actions.control).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: "session-1" }),
      "next",
    );
    expect(actions.control).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ sessionId: "session-1" }),
      "stepIn",
    );
    expect(actions.control).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ sessionId: "session-1" }),
      "stepOut",
    );
    expect(actions.control).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ sessionId: "session-1" }),
      "stop",
    );
  });

  it("offers pause only while running and never sends an invalid paused-only action", async () => {
    const user = userEvent.setup();
    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: { ...snapshot, session: { ...snapshot.session!, status: "running" } },
      actions,
    });
    render(<DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />);

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Step over" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(actions.control).toHaveBeenCalledOnce();
    expect(actions.control).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" }),
      "pause",
    );
  });

  it("surfaces a bounded exception description for the current paused session", () => {
    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: {
        ...snapshot,
        stopDescription: {
          value: "Fixture uncaught exception",
          truncated: false,
          originalBytes: 26,
          retainedBytes: 26,
          omittedBytes: 0,
        },
      },
      actions,
    });
    render(<DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />);

    expect(screen.getByText("Exception: Fixture uncaught exception")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("lists source breakpoints accessibly and lets a keyboard/screen-reader user inspect and manage them", async () => {
    // Epic #2096 a11y-sweep finding 1: the gutter glyphs are pure CSS on non-focusable Monaco
    // decorations, never exposed to the accessibility tree. This is the only accessible inventory.
    const user = userEvent.setup();
    const openEditorFile = vi.fn();
    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: {
        ...snapshot,
        instrumentation: {
          ...snapshot.instrumentation!,
          breakpoints: [
            {
              id: "bp-1",
              fileId: "src/second.ts",
              line: 4,
              enabled: true,
              kind: "line",
              verification: "verified",
            },
            {
              id: "bp-2",
              fileId: "src/first.ts",
              line: 2,
              enabled: false,
              kind: "conditional",
              condition: "count > 1",
              verification: "verified",
            },
          ],
        },
      },
      actions,
    });
    render(
      <DebugPanel
        root="/repo"
        workspaceId="canonical-workspace-id"
        debugEnabled
        openEditorFile={openEditorFile}
      />,
    );

    const list = screen.getByRole("list", { name: "Breakpoints" });
    expect(within(list).getByText("Conditional breakpoint")).toBeInTheDocument();
    expect(within(list).getByText("count > 1")).toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: "src/first.ts, line 2" }));
    expect(openEditorFile).toHaveBeenCalledWith({
      root: "/repo",
      path: "src/first.ts",
      lineStart: 2,
      lineEnd: 2,
    });

    await user.click(within(list).getByRole("checkbox", { name: "Enable breakpoint" }));
    expect(actions.saveBreakpoints).toHaveBeenCalledWith("src/first.ts", [
      expect.objectContaining({ id: "bp-2", enabled: true }),
    ]);

    await user.click(
      within(list).getAllByRole("button", { name: "Remove breakpoint" })[0] as HTMLElement,
    );
    expect(actions.saveBreakpoints).toHaveBeenCalledWith("src/first.ts", []);
  });

  it("keeps the start action disabled without both an active file and a server activation revision", () => {
    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: { ...snapshot, session: null },
      actions,
    });
    render(<DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />);

    expect(screen.getByRole("button", { name: /start debugging current file/i })).toBeDisabled();
  });

  it("evaluates an explicitly registered watch only in the selected paused frame", async () => {
    const user = userEvent.setup();
    vi.mocked(actions.evaluateWatch).mockResolvedValueOnce({
      watchId: "watch-1",
      pauseGeneration: 2,
      state: "value",
      value: { value: "2", truncated: false, originalBytes: 1, retainedBytes: 1, omittedBytes: 0 },
    });
    render(<DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />);

    await user.click(screen.getByRole("button", { name: /second/i }));
    await user.click(screen.getByRole("button", { name: "Evaluate total" }));

    expect(actions.evaluateWatch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", status: "paused" }),
      "watch-1",
      "frame-2",
    );
    expect(screen.getByRole("list", { name: "Registered watch results" })).toHaveTextContent(
      "total: 2",
    );
  });

  it("supports tree expand, child focus, and parent focus without pointer-only interaction", async () => {
    const user = userEvent.setup();
    render(<DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />);
    const scope = screen.getByRole("treeitem", { name: /local/i });
    scope.focus();

    await user.keyboard("{ArrowRight}");
    const child = screen.getByRole("treeitem", { name: /item: 1/i });
    await user.keyboard("{ArrowRight}");
    expect(child).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(scope).toHaveFocus();
  });

  it("never moves DOM focus into the call stack or variable tree when a session pauses on its own", async () => {
    const outsideButton = document.createElement("button");
    outsideButton.textContent = "outside the debug panel";
    document.body.append(outsideButton);
    outsideButton.focus();

    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: { ...snapshot, session: null, stack: null },
      actions,
    });
    const { rerender } = render(
      <DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />,
    );
    expect(outsideButton).toHaveFocus();

    // The session pausing here is purely a snapshot/prop change -- no click, no keydown, no user
    // interaction with this panel at all -- so it must never steal focus away from wherever the
    // local human already was (e.g. the editor surface). Only an explicit row interaction may move
    // focus (covered by the tree/call-stack keyboard-navigation tests above and below).
    vi.mocked(useDebugSession).mockReturnValue({ snapshot, actions });
    rerender(<DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />);
    await waitFor(() => expect(actions.loadStack).toHaveBeenCalled());

    expect(outsideButton).toHaveFocus();
    outsideButton.remove();
  });

  it("discloses that saving a paused variable mutates the live debuggee", async () => {
    const user = userEvent.setup();
    render(<DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />);
    const scope = screen.getByRole("treeitem", { name: /local/i });
    scope.focus();

    await user.keyboard("{ArrowRight}");
    const child = screen.getByRole("treeitem", { name: /item: 1/i });
    await user.keyboard("{ArrowRight}");
    expect(child).toHaveFocus();
    await user.keyboard("{Enter}");

    const editor = screen.getByRole("group", { name: /paused variable editor/i });
    expect(within(editor).getByText(/mutates the live paused debuggee/i)).toBeInTheDocument();
  });

  it("supports pointer-free call-stack focus and selection", async () => {
    const user = userEvent.setup();
    render(<DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />);
    const first = screen.getByRole("button", { name: /first/i });
    const second = screen.getByRole("button", { name: /second/i });
    first.focus();

    await user.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(second).toHaveAttribute("aria-pressed", "true");
  });

  it("renders visible controls and accessibility labels from the German catalog", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />
      </I18nProvider>,
    );

    expect(await screen.findByRole("group", { name: "Debugging-Steuerung" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fortsetzen" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Aufrufliste" })).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Variablen" })).toBeInTheDocument();
  });

  it("retains existing console row nodes when bounded output is appended", () => {
    const firstEntry = snapshot.console.entries[0]!;
    const { rerender } = render(
      <DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />,
    );
    const firstRow = screen.getByText("[stdout] started");

    vi.mocked(useDebugSession).mockReturnValue({
      snapshot: {
        ...snapshot,
        console: {
          ...snapshot.console,
          entries: [firstEntry, { id: 2, category: "stderr", text: "continued", truncated: false }],
          retainedBytes: 16,
        },
      },
      actions,
    });
    rerender(<DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />);

    expect(screen.getByText("[stdout] started")).toBe(firstRow);
    expect(screen.getByLabelText("Debug output").textContent).toBe(
      "[stdout] started\n[stderr] continued",
    );
  });

  it("is axe-clean and keeps the bounded console free of arbitrary evaluation input", async () => {
    const { container } = render(
      <DebugPanel root="/repo" workspaceId="canonical-workspace-id" debugEnabled />,
    );
    const consoleSection = screen.getByRole("heading", {
      name: /debug console output/i,
    }).parentElement;
    expect(consoleSection).not.toBeNull();
    expect(within(consoleSection as HTMLElement).queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("creates deterministic opaque draft watch identifiers", () => {
    expect(draftWatchId(1)).toBe("draft-watch-1");
    expect(draftWatchId(2)).toBe("draft-watch-2");
  });
});
