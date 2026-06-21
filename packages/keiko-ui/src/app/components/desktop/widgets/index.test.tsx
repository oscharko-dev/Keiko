import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import type { AppWindow } from "../windows/types";

type UpdateCfg = (patch: AppWindow["cfg"]) => void;

vi.mock("../ChatWindow", () => ({
  ChatWindow: ({
    mini,
    linkedRoot,
    onOpenRunResult,
  }: {
    readonly mini?: boolean;
    readonly linkedRoot?: string | null;
    readonly onOpenRunResult?: (message: {
      readonly runId: string;
      readonly workflowId: string;
      readonly taskType?: string | undefined;
    }) => void;
  }) => (
    <div data-testid="chat-window">
      {`${String(mini)}:${linkedRoot ?? ""}`}
      <button
        type="button"
        onClick={() =>
          onOpenRunResult?.({
            runId: "run-chat",
            workflowId: "unit-test-generation",
          })
        }
      >
        Open chat run
      </button>
    </div>
  ),
}));

vi.mock("../context/ChatSessionContext", () => ({
  ChatSessionProvider: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

vi.mock("../hooks/useChatSession", () => ({
  useChatSession: () => ({
    activeChat: { id: "chat-1", title: "Chat 1", status: "open" },
    activeProject: { path: "/repo" },
    chats: [{ id: "chat-1", title: "Chat 1", status: "open" }],
    loading: false,
    openChat: vi.fn(),
    openNewChat: vi.fn(async () => ({ id: "created-chat", title: "Created chat" })),
  }),
}));

vi.mock("./panels/ProjectPanel", () => ({ ProjectPanel: () => <div>ProjectPanel</div> }));
vi.mock("./panels/ChatHistoryPanel", () => ({
  ChatHistoryPanel: ({
    openChatWindow,
  }: {
    readonly openChatWindow: (chat: { readonly id: string; readonly title: string }) => void;
  }) => (
    <button type="button" onClick={() => openChatWindow({ id: "chat-2", title: "Chat 2" })}>
      Open history chat
    </button>
  ),
}));
vi.mock("./panels/SearchPanel", () => ({ SearchPanel: () => <div>SearchPanel</div> }));
vi.mock("./panels/PluginsPanel", () => ({ PluginsPanel: () => <div>PluginsPanel</div> }));
vi.mock("./panels/AutomationsPanel", () => ({
  AutomationsPanel: () => <div>AutomationsPanel</div>,
}));
vi.mock("./panels/MobilePanel", () => ({ MobilePanel: () => <div>MobilePanel</div> }));
vi.mock("./panels/InspectorPanel", () => ({ InspectorPanel: () => <div>InspectorPanel</div> }));
vi.mock("./panels/NotificationsPanel", () => ({
  NotificationsPanel: () => <div>NotificationsPanel</div>,
}));
vi.mock("./panels/ResourcesPanel", () => ({ ResourcesPanel: () => <div>ResourcesPanel</div> }));
vi.mock("./panels/TimelinePanel", () => ({ TimelinePanel: () => <div>TimelinePanel</div> }));
vi.mock("./panels/KeikoTwinPanel", () => ({ KeikoTwinPanel: () => <div>KeikoTwinPanel</div> }));
vi.mock("./panels/SettingsPanel", () => ({ SettingsPanel: () => <div>SettingsPanel</div> }));

vi.mock("./cards/FilesWidget", () => ({
  FilesWidget: ({
    root,
    onActiveFileChange,
    onRootChange,
    onOpenFile,
  }: {
    readonly root?: string;
    readonly onActiveFileChange: (
      path: string | null,
      root: string | null,
      activeDirectoryPath?: string | null,
    ) => void;
    readonly onRootChange: (root: string) => void;
    readonly onOpenFile: (root: string, path: string) => void;
  }) => (
    <div>
      <span data-testid="files-root">{root ?? "none"}</span>
      <button type="button" onClick={() => onActiveFileChange("src/app.ts", "/repo", "/repo/src")}>
        Active file
      </button>
      <button type="button" onClick={() => onRootChange("/next")}>
        Change root
      </button>
      <button type="button" onClick={() => onOpenFile("/repo", "src/app.ts")}>
        Open file
      </button>
    </div>
  ),
}));
vi.mock("./cards/EditorWidget", () => ({
  EditorWidget: ({
    root,
    file,
    linkedRoot,
    linkedFilePath,
    linkedCapsuleIds,
    linkedCapsuleSetIds,
    openFiles,
    layoutJson,
    onWorkspaceChange,
  }: {
    readonly root?: string;
    readonly file?: string;
    readonly openFiles?: readonly string[];
    readonly layoutJson?: string;
    readonly linkedRoot?: string | null;
    readonly linkedFilePath?: string;
    readonly linkedCapsuleIds?: readonly string[];
    readonly linkedCapsuleSetIds?: readonly string[];
    readonly onWorkspaceChange?: (patch: {
      root?: string;
      file?: string;
      openFiles?: readonly string[];
      layoutJson?: string;
    }) => void;
  }) => (
    <div data-testid="editor-widget">
      <span>{`${root ?? ""}:${file ?? ""}:${(openFiles ?? []).join("|")}:${layoutJson ?? ""}:${linkedRoot ?? ""}:${linkedFilePath ?? ""}:${(linkedCapsuleIds ?? []).join(",")}:${(linkedCapsuleSetIds ?? []).join(",")}`}</span>
      <button
        type="button"
        onClick={() =>
          onWorkspaceChange?.({
            root: "/next-root",
            file: "README.md",
            openFiles: ["README.md"],
            layoutJson: '{"version":1}',
          })
        }
      >
        Change editor workspace
      </button>
    </div>
  ),
}));
vi.mock("./cards/BrowserWidget", () => ({
  BrowserWidget: ({ url }: { readonly url?: string }) => (
    <div data-testid="browser-widget">{url ?? "blank"}</div>
  ),
}));
vi.mock("./cards/TerminalWidget", () => ({
  TerminalWidget: ({
    cwd,
    projectPath,
  }: {
    readonly cwd?: string;
    readonly projectPath?: string;
  }) => <div data-testid="terminal-widget">{`${cwd ?? ""}:${projectPath ?? ""}`}</div>,
}));
vi.mock("./cards/ReviewWidget", () => ({
  ReviewWidget: ({
    runId,
    onRunIdSubmit,
  }: {
    readonly runId?: string;
    readonly onRunIdSubmit: (runId: string) => void;
  }) => (
    <button type="button" data-testid="review-widget" onClick={() => onRunIdSubmit("run-entered")}>
      {runId ?? "no-run"}
    </button>
  ),
}));
vi.mock("./cards/AgentRunWidget", () => ({
  AgentRunWidget: ({
    cfg,
    linkedRoot,
    linkedFilePath,
  }: {
    readonly cfg: Record<string, unknown>;
    readonly linkedRoot: string | null;
    readonly linkedFilePath?: string;
  }) => (
    <div data-testid="agent-widget">{`${String(cfg.workflow)}:${linkedRoot ?? ""}:${linkedFilePath ?? ""}`}</div>
  ),
}));
vi.mock("./cards/IntegrationsWidget", () => ({
  IntegrationsWidget: () => <div>IntegrationsWidget</div>,
}));
vi.mock("./cards/ConnectorPickerWidget", () => ({
  ConnectorPickerWidget: ({
    presentation,
    selectedId,
    onSelect,
    onManageConnectors,
  }: {
    readonly presentation?: string;
    readonly selectedId?: string;
    readonly onSelect: (patch: Record<string, string>) => void;
    readonly onManageConnectors: () => void;
  }) => (
    <div>
      <span data-testid="connector-widget">{`${presentation ?? ""}:${selectedId ?? ""}`}</span>
      <button
        type="button"
        onClick={() => onSelect({ selectedKind: "capsule", selectedId: "cap-1" })}
      >
        Select connector
      </button>
      <button type="button" onClick={onManageConnectors}>
        Manage connectors
      </button>
    </div>
  ),
}));
vi.mock("./figma/FigmaSnapshotWindow", () => ({
  FigmaSnapshotWindow: ({
    snapshotRunId,
    selectedScreenIds,
    sourceWindowId,
    updateCfg,
    openScreenSource,
  }: {
    readonly snapshotRunId?: string;
    readonly selectedScreenIds?: readonly string[];
    readonly sourceWindowId?: string;
    readonly updateCfg: (patch: AppWindow["cfg"]) => void;
    readonly openScreenSource?: (input: {
      readonly snapshotRunId: string;
      readonly screenId: string;
      readonly name: string;
    }) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="figma-window"
        onClick={() => updateCfg({ snapshotRunId: "fs-2" })}
      >
        {`${sourceWindowId ?? ""}:${snapshotRunId ?? "new"}:${selectedScreenIds?.join(",") ?? ""}`}
      </button>
      <button
        type="button"
        onClick={() =>
          openScreenSource?.({
            snapshotRunId: snapshotRunId ?? "fs-1",
            screenId: "screen-1",
            name: "Screen 1",
          })
        }
      >
        Add screen source
      </button>
    </div>
  ),
}));
vi.mock("./figma/FigmaJsonSourceWindow", () => ({
  FigmaJsonSourceWindow: ({
    snapshotRunId,
    screenId,
    screenName,
  }: {
    readonly snapshotRunId?: string;
    readonly screenId?: string;
    readonly screenName?: string;
  }) => (
    <div data-testid="figma-json-window">
      {`${snapshotRunId ?? ""}:${screenId ?? ""}:${screenName ?? ""}`}
    </div>
  ),
}));
vi.mock("./figma/FigmaImageSourceWindow", () => ({
  FigmaImageSourceWindow: ({
    imageSrc,
    screenName,
  }: {
    readonly imageSrc?: string;
    readonly screenName?: string;
  }) => <div data-testid="figma-image-window">{`${imageSrc ?? ""}:${screenName ?? ""}`}</div>,
}));
vi.mock("./quality-intelligence/QiHubPanel", () => ({
  QiHubPanel: ({
    openRun,
    connectedRoot,
  }: {
    readonly openRun: (runId: string) => void;
    readonly connectedRoot: string | null;
  }) => (
    <button type="button" data-testid="qi-hub" onClick={() => openRun("qi-run-1")}>
      {connectedRoot ?? "no-root"}
    </button>
  ),
}));
vi.mock("./quality-intelligence/QiRunCard", () => ({
  QiRunCard: ({
    runId,
    onRegenerated,
  }: {
    readonly runId: string;
    readonly onRegenerated: (result: { readonly runId: string }) => void;
  }) => (
    <button
      type="button"
      data-testid="qi-run-card"
      onClick={() => onRegenerated({ runId: "qi-run-2" })}
    >
      {runId}
    </button>
  ),
}));
vi.mock("../../../relationships/RelationshipsView", () => ({
  RelationshipsView: () => <div>RelationshipsView</div>,
}));
vi.mock("../../../local-knowledge/connector-graph", () => ({
  ConnectorGraph: ({ showBackToWorkspace }: { readonly showBackToWorkspace: boolean }) => (
    <div data-testid="connector-graph">{String(showBackToWorkspace)}</div>
  ),
}));

import "./index";
import { WIN_TYPES } from "../windows/WindowsRegistry";

function makeCtx(): WindowRenderContext & {
  readonly updateCfg: ReturnType<typeof vi.fn<UpdateCfg>>;
  readonly openWindow: ReturnType<typeof vi.fn>;
} {
  return {
    windowId: "ctx-window",
    mini: true,
    linkedRoot: "/repo",
    linkedFilePath: "src/app.ts",
    linkedRoots: ["/repo", "/docs"],
    linkedCapsuleIds: ["cap-1"],
    linkedCapsuleSetIds: ["set-1"],
    linkedFigmaSnapshotRunIds: ["fs-1"],
    linkedImageSources: [
      {
        kind: "image",
        label: "Image · Screen 1",
        sourceKind: "figma-snapshot-screen",
        snapshotRunId: "fs-1",
        screenId: "screen-1",
      },
    ],
    updateCfg: vi.fn<UpdateCfg>(),
    openWindow: vi.fn(() => "win-1"),
  };
}

describe("workspace widget renderer registry", () => {
  it("syncs an open chat window title when the active chat is renamed", async () => {
    const ctx = makeCtx();
    render(<>{WIN_TYPES.chat.render({ chatId: "chat-1", title: "Old title" }, ctx)}</>);

    await waitFor(() => {
      expect(ctx.updateCfg).toHaveBeenCalledWith({ title: "Chat 1" });
    });
  });

  it("maps window cfg into widget props and follow-up workspace actions", () => {
    const ctx = makeCtx();
    const view = render(<>{WIN_TYPES.files.render({ root: "/repo" }, ctx)}</>);

    expect(screen.getByTestId("files-root")).toHaveTextContent("/repo");
    fireEvent.click(screen.getByRole("button", { name: "Active file" }));
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      activeFilePath: "src/app.ts",
      activeDirectoryPath: "/repo/src",
      resolvedRoot: "/repo",
    });
    fireEvent.click(screen.getByRole("button", { name: "Change root" }));
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      root: "/next",
      activeFilePath: undefined,
      activeDirectoryPath: undefined,
      resolvedRoot: undefined,
    });
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("editor", {
      root: "/repo",
      file: "src/app.ts",
      openFiles: ["src/app.ts"],
    });

    view.rerender(<>{WIN_TYPES.review.render({}, ctx)}</>);
    fireEvent.click(screen.getByTestId("review-widget"));
    expect(ctx.updateCfg).toHaveBeenCalledWith({ runId: "run-entered" });

    view.rerender(
      <>
        {WIN_TYPES.editor.render(
          { root: "/repo", file: "src/app.ts", openFiles: ["src/app.ts", "package.json"] },
          ctx,
        )}
        {WIN_TYPES.browser.render({ url: "https://example.test" }, ctx)}
        {WIN_TYPES.terminal.render({ cwd: "/repo", projectPath: "/repo" }, ctx)}
        {WIN_TYPES.agents.render({ workflow: "verify", access: "full", keikoMode: true }, ctx)}
      </>,
    );
    expect(screen.getByTestId("editor-widget")).toHaveTextContent(
      "/repo:src/app.ts:src/app.ts|package.json::/repo:src/app.ts:cap-1:set-1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Change editor workspace" }));
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      root: "/next-root",
      file: "README.md",
      openFiles: ["README.md"],
      layoutJson: '{"version":1}',
    });
    expect(screen.getByTestId("browser-widget")).toHaveTextContent("https://example.test");
    expect(screen.getByTestId("terminal-widget")).toHaveTextContent("/repo:/repo");
    expect(screen.getByTestId("agent-widget")).toHaveTextContent("verify:/repo:src/app.ts");
  });

  it("wires hub callbacks for quality, regenerated runs, connector management, figma, and chat history", () => {
    const ctx = makeCtx();
    const view = render(<>{WIN_TYPES.quality.render({}, ctx)}</>);

    fireEvent.click(screen.getByTestId("qi-hub"));
    expect(ctx.openWindow).toHaveBeenCalledWith(
      "qiRun",
      expect.objectContaining({ runId: "qi-run-1" }),
    );

    view.rerender(<>{WIN_TYPES.qiRun.render({ runId: "qi-run-1" }, ctx)}</>);
    fireEvent.click(screen.getByTestId("qi-run-card"));
    expect(ctx.openWindow).toHaveBeenCalledWith(
      "qiRun",
      expect.objectContaining({ runId: "qi-run-2" }),
    );

    view.rerender(
      <>
        {WIN_TYPES.connector.render(
          { presentation: "inline", selectedKind: "capsule", selectedId: "cap-1" },
          ctx,
        )}
      </>,
    );
    expect(screen.getByTestId("connector-widget")).toHaveTextContent("inline:cap-1");
    fireEvent.click(screen.getByRole("button", { name: "Select connector" }));
    expect(ctx.updateCfg).toHaveBeenCalledWith({ selectedKind: "capsule", selectedId: "cap-1" });
    fireEvent.click(screen.getByRole("button", { name: "Manage connectors" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("localKnowledge");

    view.rerender(<>{WIN_TYPES.figma.render({ snapshotRunId: "fs-1" }, ctx)}</>);
    fireEvent.click(screen.getByTestId("figma-window"));
    expect(ctx.updateCfg).toHaveBeenCalledWith({ snapshotRunId: "fs-2" });
    fireEvent.click(screen.getByRole("button", { name: "Add screen source" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("figmaView", {
      snapshotRunId: "fs-1",
      selectedScreenIdsJson: JSON.stringify(["screen-1"]),
      selectedScreenName: "Screen 1",
    });

    view.rerender(
      <>
        {WIN_TYPES.figma.render(
          {
            snapshotRunId: "fs-1",
            selectedScreenIdsJson: JSON.stringify(["screen-1"]),
            selectedScreenName: "Screen 1",
          },
          ctx,
        )}
      </>,
    );
    expect(screen.getByTestId("figma-window")).toHaveTextContent("ctx-window:fs-1:screen-1");

    view.rerender(
      <>
        {WIN_TYPES.figmaView.render(
          {
            snapshotRunId: "fs-1",
            selectedScreenIdsJson: JSON.stringify(["screen-1"]),
            selectedScreenName: "Screen 1",
          },
          ctx,
        )}
      </>,
    );
    expect(screen.getByTestId("figma-window")).toHaveTextContent("ctx-window:fs-1:screen-1");

    view.rerender(
      <>
        {WIN_TYPES.figmaJson.render(
          { snapshotRunId: "fs-1", screenId: "screen-1", selectedScreenName: "Screen 1" },
          ctx,
        )}
      </>,
    );
    expect(screen.getByTestId("figma-json-window")).toHaveTextContent("fs-1:screen-1:Screen 1");

    view.rerender(
      <>
        {WIN_TYPES.figmaImage.render(
          {
            imageSrc: "/api/figma/snapshots/fs-1/screens/0/image",
            selectedScreenName: "Screen 1",
          },
          ctx,
        )}
      </>,
    );
    expect(screen.getByTestId("figma-image-window")).toHaveTextContent(
      "/api/figma/snapshots/fs-1/screens/0/image:Screen 1",
    );

    view.rerender(<>{WIN_TYPES.chatHistory.render({}, ctx)}</>);
    fireEvent.click(screen.getByRole("button", { name: "Open history chat" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("chat", { chatId: "chat-2", title: "Chat 2" });

    view.rerender(
      <>
        {WIN_TYPES.chat.render({ chatId: "chat-1" }, ctx)}
        {WIN_TYPES.localKnowledge.render({}, ctx)}
        {WIN_TYPES.relationships.render({}, ctx)}
      </>,
    );
    expect(screen.getByTestId("chat-window")).toHaveTextContent("true:/repo");
    fireEvent.click(screen.getByRole("button", { name: "Open chat run" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("agents", {
      runId: "run-chat",
      workflow: "unit-test-generation",
      workspaceRoot: "/repo",
    });
    expect(screen.getByTestId("connector-graph")).toHaveTextContent("false");
    expect(screen.getByText("RelationshipsView")).toBeInTheDocument();
  });
});
