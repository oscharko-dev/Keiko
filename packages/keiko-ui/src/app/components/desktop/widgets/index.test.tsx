import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Chat } from "@/lib/types";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import type { AppWindow } from "../windows/types";
import {
  discardEditorSelectionHandoff,
  inspectEditorSelectionHandoff,
  registerEditorSelectionHandoff,
  type EditorSelectionHandoff,
} from "./cards/editorSelectionHandoff";
import { registerChatWindowRuntime } from "../windows/chatWindowActivity";

type UpdateCfg = (patch: AppWindow["cfg"]) => void;

const chatSessionMock = vi.hoisted(() => ({
  activeChat: {
    id: "chat-1",
    title: "Chat 1",
    status: "open",
    projectPath: "/repo",
  } as
    | {
        readonly id: string;
        readonly title: string;
        readonly status: string;
        readonly projectPath: string;
      }
    | undefined,
  activeProject: { path: "/repo", available: true } as
    { readonly path: string; readonly available: boolean } | undefined,
  chats: [{ id: "chat-1", title: "Chat 1", status: "open", projectPath: "/repo" }] as {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly projectPath: string;
  }[],
  projects: [{ path: "/repo", available: true }] as {
    readonly path: string;
    readonly available: boolean;
  }[],
  loading: false,
  error: undefined as string | undefined,
  memoryEnabled: true,
  noEligibleModels: false,
  openChat: vi.fn<(chat: { readonly id: string }) => Promise<void>>(() => Promise.resolve()),
  openNewChat: vi.fn<
    (
      project?: { readonly path: string; readonly available: boolean },
      title?: string,
    ) => Promise<
      | {
          readonly id: string;
          readonly title: string;
          readonly status: string;
          readonly projectPath: string;
        }
      | undefined
    >
  >(() => Promise.resolve(undefined)),
  openProject: vi.fn<
    (project: { readonly path: string; readonly available: boolean }) => Promise<void>
  >(() => Promise.resolve()),
  selectedModel: "model-1" as string | undefined,
  sendMessage: vi.fn<(options?: { readonly text?: string }) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  replaceChat: vi.fn<(chat: Chat) => void>(),
  setMemoryEnabled: vi.fn<(enabled: boolean) => void>(),
  sending: false,
}));

type UpdateChat = (
  id: string,
  patch: { readonly title?: string },
) => Promise<{ readonly chat: Chat }>;

interface ApiMock {
  readonly updateChat: Mock<UpdateChat>;
}

const apiMock = vi.hoisted((): ApiMock => ({
  updateChat: vi.fn<UpdateChat>(),
}));

vi.mock("@/lib/api", async (importOriginal): Promise<object> => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, updateChat: apiMock.updateChat };
});

vi.mock("../ChatWindow", () => ({
  ChatWindow: ({
    mini,
    linkedRoot,
    linkedRoots,
    openEditorFile,
    onOpenRunResult,
  }: {
    readonly mini?: boolean;
    readonly linkedRoot?: string | null;
    readonly linkedRoots?: readonly string[];
    readonly openEditorFile?: (request: { readonly root: string; readonly path: string }) => {
      readonly ok: boolean;
    };
    readonly onOpenRunResult?: (message: {
      readonly runId: string;
      readonly workflowId: string;
      readonly taskType?: string | undefined;
    }) => void;
  }): ReactNode => (
    <div data-testid="chat-window">
      {`${String(mini)}:${linkedRoot ?? ""}:${(linkedRoots ?? []).join("|")}:${String(openEditorFile?.({ root: "/repo", path: "src/app.ts" }).ok ?? false)}`}
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
  useChatSessionContext: () => ({
    activeChat: chatSessionMock.activeChat,
    activeProject: chatSessionMock.activeProject,
    chats: chatSessionMock.chats,
    projects: chatSessionMock.projects,
    loading: chatSessionMock.loading,
    error: chatSessionMock.error,
    memoryEnabled: chatSessionMock.memoryEnabled,
    models: [{ id: "model-1" }],
    noEligibleModels: chatSessionMock.noEligibleModels,
    openChat: chatSessionMock.openChat,
    openNewChat: chatSessionMock.openNewChat,
    openProject: chatSessionMock.openProject,
    selectedModel: chatSessionMock.selectedModel,
    sendMessage: chatSessionMock.sendMessage,
    replaceChat: chatSessionMock.replaceChat,
    setMemoryEnabled: chatSessionMock.setMemoryEnabled,
    sending: chatSessionMock.sending,
  }),
}));

vi.mock("../hooks/useChatSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useChatSession")>();
  return {
    ...actual,
    useChatSession: (): typeof chatSessionMock => chatSessionMock,
  };
});

// These cases assert widget prop mapping, not workspace membership, but every execution surface
// resolves its root through useWorkspaceManifest. Without a stub the real hook fetches, fails in
// jsdom, and the window is denied for want of a provable root — correct product behaviour, and not
// what these cases are about. A settled "this workspace has no V2 manifest" is the legacy state they
// have always meant, stated explicitly instead of arriving via a failed request.
vi.mock("../hooks/useWorkspaceManifest", () => ({
  useWorkspaceManifest: () => ({
    manifest: null,
    loading: false,
    mutating: false,
    issue: null,
    refresh: vi.fn(),
    addRoot: vi.fn(),
    removeRoot: vi.fn(),
    reorderRoots: vi.fn(),
    focusRoot: vi.fn(),
  }),
}));

vi.mock("./panels/ProjectPanel", () => ({ ProjectPanel: () => <div>ProjectPanel</div> }));
vi.mock("./panels/ChatHistoryPanel", () => ({
  ChatHistoryPanel: ({
    openChatWindow,
  }: {
    readonly openChatWindow: (chat: {
      readonly id: string;
      readonly projectPath: string;
      readonly title: string;
    }) => void;
  }) => (
    <button
      type="button"
      onClick={() => openChatWindow({ id: "chat-2", projectPath: "/repo", title: "Chat 2" })}
    >
      Open history chat
    </button>
  ),
}));
vi.mock("./panels/SearchPanel", () => ({
  SearchPanel: ({ root }: { readonly root?: string }) => (
    <div data-testid="search-panel">{root ?? "none"}</div>
  ),
}));
vi.mock("./panels/PromptEnhancerPanel", () => ({
  PromptEnhancerPanel: ({
    connectedRoot,
    connectedFilePath,
    connectedRoots,
  }: {
    readonly connectedRoot?: string | null;
    readonly connectedFilePath?: string | null;
    readonly connectedRoots?: readonly string[];
  }) => (
    <div data-testid="prompt-enhancer-panel">
      {`${connectedRoot ?? ""}:${connectedFilePath ?? ""}:${(connectedRoots ?? []).join("|")}`}
    </div>
  ),
}));
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
vi.mock("./panels/SettingsPanel", () => ({
  SettingsPanel: ({
    openUpdatesWindow,
    root,
  }: {
    readonly openUpdatesWindow?: () => void;
    readonly root?: string;
  }) => (
    <button type="button" data-testid="settings-panel" onClick={openUpdatesWindow}>
      SettingsPanel:{root ?? "unbound"}
    </button>
  ),
}));
vi.mock("../update/UpdateWindow", () => ({
  UpdateWindow: () => <div data-testid="update-window">UpdateWindow</div>,
}));

vi.mock("./cards/FilesWidget", () => ({
  FilesWidget: ({
    root,
    onActiveFileChange,
    onRootChange,
    onOpenFile,
    onOpenGitDelivery,
  }: {
    readonly root?: string;
    readonly onActiveFileChange: (
      path: string | null,
      root: string | null,
      activeDirectoryPath?: string | null,
    ) => void;
    readonly onRootChange?: (root: string) => void;
    readonly onOpenFile: (root: string, path: string) => void;
    readonly onOpenGitDelivery: (root: string) => void;
  }) => (
    <div>
      <span data-testid="files-root">{root ?? "none"}</span>
      <button type="button" onClick={() => onActiveFileChange("src/app.ts", "/repo", "/repo/src")}>
        Active file
      </button>
      {onRootChange === undefined ? null : (
        <button type="button" onClick={() => onRootChange("/next")}>
          Change root
        </button>
      )}
      <button type="button" onClick={() => onOpenFile("/repo", "src/app.ts")}>
        Open file
      </button>
      <button type="button" onClick={() => onOpenGitDelivery("/repo")}>
        Open Git
      </button>
    </div>
  ),
}));
const editorWidgetMounts = vi.hoisted(() => [] as string[]);
const editorWidgetUnmounts = vi.hoisted(() => [] as string[]);

// Issue #446 (ADR-0090 D4) — the remount pin below reads these ledgers. The root a mounted editor
// was built for is fixed for the lifetime of that instance, so a switch shows up as unmount + mount
// and never as an in-place update. Kept out of the mock body so the mock's own complexity, which is
// already above the repository ceiling for its assertion string, does not grow further.
function useEditorMountLedger(root: string | undefined): void {
  const identity = useRef(root ?? "unbound");
  useEffect(() => {
    const mounted = identity.current;
    editorWidgetMounts.push(mounted);
    return () => {
      editorWidgetUnmounts.push(mounted);
    };
  }, []);
}

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
    revealLineStart,
    revealLineEnd,
    revealRequestId,
    onWorkspaceChange,
    onAskSelection,
    onOpenGitCommit,
    onOpenGitDiff,
  }: {
    readonly root?: string;
    readonly file?: string;
    readonly openFiles?: readonly string[];
    readonly layoutJson?: string;
    readonly revealLineStart?: number;
    readonly revealLineEnd?: number;
    readonly revealRequestId?: string;
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
    readonly onAskSelection?: ((handoff: EditorSelectionHandoff) => boolean) | undefined;
    readonly onOpenGitCommit?: ((root: string, commit: string) => void) | undefined;
    readonly onOpenGitDiff?: ((root: string, path: string) => void) | undefined;
  }) => {
    useEditorMountLedger(root);
    return (
      <div data-testid="editor-widget">
        <span>{`${root ?? ""}:${file ?? ""}:${(openFiles ?? []).join("|")}:${layoutJson ?? ""}:${linkedRoot ?? ""}:${linkedFilePath ?? ""}:${(linkedCapsuleIds ?? []).join(",")}:${(linkedCapsuleSetIds ?? []).join(",")}:${String(revealLineStart ?? "")}:${String(revealLineEnd ?? "")}:${revealRequestId ?? ""}`}</span>
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
        <button
          type="button"
          onClick={() =>
            onAskSelection?.({
              file: "src/app.ts",
              range: { start: { line: 1, column: 2 }, end: { line: 2, column: 4 } },
              text: "const selected = true;\r\n",
              truncated: false,
            })
          }
        >
          Ask editor selection
        </button>
        <button type="button" onClick={() => onOpenGitCommit?.("/repo", "a".repeat(40))}>
          Open blame commit
        </button>
        <button type="button" onClick={() => onOpenGitDiff?.("/repo", "src/app.ts")}>
          Open file diff
        </button>
      </div>
    );
  },
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
vi.mock("./cards/RuntimeHubWidget", () => ({
  RuntimeHubWidget: ({
    projectPath,
    onProjectPathChange,
    onOpenFiles,
    onOpenCommands,
    onOpenContainers,
    onOpenGovernedGit,
    onOpenPullRequest,
    onOpenMerge,
  }: {
    readonly projectPath?: string;
    readonly onProjectPathChange: (projectPath: string) => void;
    readonly onOpenFiles: (projectPath?: string) => void;
    readonly onOpenCommands: (projectPath: string) => void;
    readonly onOpenContainers: (projectPath?: string) => void;
    readonly onOpenGovernedGit: (projectPath: string) => void;
    readonly onOpenPullRequest: (projectPath: string) => void;
    readonly onOpenMerge: (projectPath: string) => void;
  }) => (
    <div data-testid="runtime-hub-widget">
      <span>{projectPath ?? ""}</span>
      <button type="button" onClick={() => onProjectPathChange("/next-runtime")}>
        Change runtime project
      </button>
      <button type="button" onClick={() => onOpenFiles("/repo")}>
        Runtime files
      </button>
      <button type="button" onClick={() => onOpenCommands("/repo")}>
        Runtime tasks
      </button>
      <button type="button" onClick={() => onOpenContainers("/repo")}>
        Runtime containers
      </button>
      <button type="button" onClick={() => onOpenGovernedGit("/repo")}>
        Runtime git
      </button>
      <button type="button" onClick={() => onOpenPullRequest("/repo")}>
        Runtime pr
      </button>
      <button type="button" onClick={() => onOpenMerge("/repo")}>
        Runtime merge
      </button>
    </div>
  ),
}));
vi.mock("./coding-workbench/CodingWorkbenchWindow", () => ({
  CodingWorkbenchWindow: ({
    selectedRoot,
    onOpenGit,
  }: {
    readonly selectedRoot?: string;
    readonly onOpenGit?: (target: {
      readonly root: string | null;
      readonly binding: "repository" | "task-workspace";
      readonly repositoryDialog?: "clone";
    }) => void;
  }) => (
    <div data-testid="coding-workbench-window">
      Coding Workbench
      <button
        type="button"
        onClick={() =>
          onOpenGit?.({ root: null, binding: "repository", repositoryDialog: "clone" })
        }
      >
        Clone for issue
      </button>
      <button
        type="button"
        onClick={() => onOpenGit?.({ root: selectedRoot ?? null, binding: "repository" })}
      >
        Open coding repository Git
      </button>
      <button
        type="button"
        onClick={() => onOpenGit?.({ root: "/worktrees/active-task", binding: "task-workspace" })}
      >
        Open coding task Git
      </button>
    </div>
  ),
}));
vi.mock("./cards/git-client/GitClientWindow", () => ({
  GitClientWindow: ({
    projectId,
    onOpenEditorFile,
    initialRepositoryDialog,
    onRepositoryConnected,
  }: {
    readonly projectId?: string;
    readonly initialRepositoryDialog?: string;
    readonly onRepositoryConnected?: (root: string) => void;
    readonly onOpenEditorFile?:
      | ((request: {
          readonly root: string;
          readonly path: string;
          readonly lineStart: number;
        }) => void)
      | undefined;
  }): ReactNode => (
    <div data-testid="git-client-window">
      {projectId ?? "unbound"}
      {initialRepositoryDialog === "clone" ? (
        <button type="button" onClick={() => onRepositoryConnected?.("/repos/cloned")}>
          Complete issue clone
        </button>
      ) : null}
      <button
        type="button"
        onClick={() =>
          onOpenEditorFile?.({ root: projectId ?? "", path: "src/app.ts", lineStart: 7 })
        }
      >
        Reveal Git file
      </button>
    </div>
  ),
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
vi.mock("./connectors/AtlassianConnectorsPanel", () => ({
  AtlassianConnectorsPanel: (): ReactElement => <div>AtlassianConnectorsPanel</div>,
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
        Select Knowledge Pod
      </button>
      <button type="button" onClick={onManageConnectors}>
        Manage Knowledge Pods
      </button>
    </div>
  ),
}));
vi.mock("./cards/PdfCitationPreviewWindow", () => ({
  PdfCitationPreviewWindow: () => <div>PdfCitationPreviewWindow</div>,
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
import {
  assertWindowRenderRegistryComplete,
  missingWindowRenderTypes,
  WIN_TYPES,
} from "../windows/WindowsRegistry";

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
    // Issue #446 — unbound by default so these legacy renderer tests keep their cfg/linkedRoot
    // behavior; the dedicated retarget tests set activeRoot to assert the override.
    activeRoot: null,
    activeBinding: null,
    updateCfg: vi.fn<UpdateCfg>(),
    openWindow: vi.fn(() => "win-1"),
    focusWindow: vi.fn(),
    updateWindow: vi.fn(),
    openEditorFile: vi.fn(() => ({ ok: false as const, message: "Unable to open editor." })),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve): void => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

beforeEach((): void => {
  chatSessionMock.activeChat = {
    id: "chat-1",
    title: "Chat 1",
    status: "open",
    projectPath: "/repo",
  };
  chatSessionMock.activeProject = { path: "/repo", available: true };
  chatSessionMock.chats = [chatSessionMock.activeChat];
  chatSessionMock.projects = [chatSessionMock.activeProject];
  chatSessionMock.loading = false;
  chatSessionMock.error = undefined;
  chatSessionMock.memoryEnabled = true;
  chatSessionMock.noEligibleModels = false;
  chatSessionMock.selectedModel = "model-1";
  chatSessionMock.sending = false;
  chatSessionMock.openChat.mockReset().mockResolvedValue(undefined);
  chatSessionMock.openNewChat.mockReset().mockResolvedValue(undefined);
  chatSessionMock.openProject.mockReset().mockResolvedValue(undefined);
  chatSessionMock.sendMessage.mockReset().mockResolvedValue(undefined);
  chatSessionMock.replaceChat.mockReset();
  chatSessionMock.setMemoryEnabled.mockReset();
  apiMock.updateChat.mockReset();
});

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe("workspace widget renderer registry", () => {
  it("registers a renderer for every declared window type", () => {
    expect(missingWindowRenderTypes()).toEqual([]);
    expect(() => {
      assertWindowRenderRegistryComplete();
    }).not.toThrow();
  });

  it("syncs an open chat window title when the active chat is renamed", async () => {
    const ctx = makeCtx();
    render(<>{WIN_TYPES.chat.render({ chatId: "chat-1", title: "Old title" }, ctx)}</>);

    // 0.3.0 release audit — strengthened: a rename also clears the structural "still untitled"
    // marker, so the workspace surfaces the new name instead of asking display copy whether the
    // chat was ever named (which missed under `de`).
    await waitFor(
      () => {
        expect(ctx.updateCfg).toHaveBeenCalledWith({ title: "Chat 1", titleIsDefault: false });
      },
      { timeout: 5_000 },
    );
    expect(screen.getByTestId("chat-window")).toHaveTextContent("true:/repo:/repo|/docs:false");
  });

  it("renders one actionable error when initial chat creation and target lookup fail together", async () => {
    const ctx = makeCtx();
    chatSessionMock.activeChat = undefined;
    chatSessionMock.chats = [];
    const view = render(<>{WIN_TYPES.chat.render({ newChatRequestId: "initial-chat" }, ctx)}</>);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Could not open chat."),
    );
    chatSessionMock.error =
      "The selected model failed its live readiness check. Open Settings > Models for details.";
    view.rerender(<>{WIN_TYPES.chat.render({ newChatRequestId: "initial-chat" }, ctx)}</>);

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("failed its live readiness check");
    expect(alerts[0]).toHaveTextContent("Settings > Models");
  });

  it("renders exactly one fallback alert for a creation-only failure", async () => {
    const ctx = makeCtx();
    chatSessionMock.activeChat = undefined;
    chatSessionMock.chats = [];
    render(<>{WIN_TYPES.chat.render({ newChatRequestId: "creation-only" }, ctx)}</>);

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not open chat.");
  });

  it("renders exactly one fallback alert for a lookup-only failure", async () => {
    const ctx = makeCtx();
    chatSessionMock.activeChat = undefined;
    chatSessionMock.chats = [];
    render(
      <>
        {WIN_TYPES.chat.render({ chatId: "missing-chat", projectPath: "/missing-project" }, ctx)}
      </>,
    );

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not open chat.");
  });

  it.each([
    ["empty", "", "Could not open chat."],
    ["malformed", "{", "{"],
    [
      "hostile",
      "<script>window.__unsafe = true</script>",
      "<script>window.__unsafe = true</script>",
    ],
  ])("renders one safe alert for a %s combined failure", async (_case, error, expected) => {
    const ctx = makeCtx();
    chatSessionMock.activeChat = undefined;
    chatSessionMock.chats = [];
    const view = render(
      <>{WIN_TYPES.chat.render({ newChatRequestId: `combined-${_case}` }, ctx)}</>,
    );
    await screen.findByRole("alert");

    chatSessionMock.error = error;
    view.rerender(<>{WIN_TYPES.chat.render({ newChatRequestId: `combined-${_case}` }, ctx)}</>);

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(expected);
    expect(alerts[0]?.querySelector("script")).toBeNull();
    expect(window).not.toHaveProperty("__unsafe");
  });

  it("routes an editor selection into an existing project chat without opening a duplicate", async () => {
    const ctx = makeCtx();
    const acceptSelectionHandoff = vi.fn<(selectionHandoffId: string) => void>();
    const unregister = registerChatWindowRuntime("existing-chat-window", {
      conversationId: "chat-origin",
      projectPath: "/workspace/origin",
      acceptSelectionHandoff,
    });

    render(<>{WIN_TYPES.editor.render({ root: "/workspace/origin", file: "src/app.ts" }, ctx)}</>);
    fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));

    expect(ctx.openWindow).not.toHaveBeenCalled();
    expect(acceptSelectionHandoff).toHaveBeenCalledOnce();
    const handoffId = acceptSelectionHandoff.mock.calls[0]?.[0];
    expect(typeof handoffId).toBe("string");
    if (handoffId !== undefined) {
      expect(inspectEditorSelectionHandoff(handoffId)?.workspaceRoot).toBe("/workspace/origin");
      discardEditorSelectionHandoff(handoffId);
    }
    unregister();
  });

  it("preserves ordinary project ownership when an existing chat consumes a selection", async () => {
    const ctx = makeCtx();
    const selectionHandoffId = registerEditorSelectionHandoff("/repo", {
      file: "src/app.ts",
      range: {
        start: { line: 1, column: 2 },
        end: { line: 2, column: 4 },
      },
      text: "const selected = true;\r\n",
      truncated: false,
    });
    if (selectionHandoffId === null) throw new Error("selection handoff registration failed");

    render(
      <>{WIN_TYPES.chat.render({ chatId: "chat-1", title: "Chat 1", selectionHandoffId }, ctx)}</>,
    );

    await waitFor((): void => expect(chatSessionMock.sendMessage).toHaveBeenCalledOnce());
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: "chat-1",
      title: "Chat 1",
      selectionHandoffId: undefined,
      newChatRequestId: undefined,
    });
  });

  it("routes a selection to its exact originating project before one-use send", async () => {
    const ctx = makeCtx();
    const originRoot = "/workspace/origin";
    const wrongRoot = "/workspace/wrong";
    const originProject = { path: originRoot, available: true };
    const originChat = {
      id: "chat-origin",
      title: "Origin chat",
      status: "open",
      projectPath: originRoot,
    };
    const sentRoots: string[] = [];
    chatSessionMock.activeProject = { path: wrongRoot, available: true };
    chatSessionMock.activeChat = {
      id: "chat-wrong",
      title: "Wrong chat",
      status: "open",
      projectPath: wrongRoot,
    };
    chatSessionMock.chats = [chatSessionMock.activeChat];
    chatSessionMock.projects = [chatSessionMock.activeProject, originProject];
    chatSessionMock.openProject.mockImplementation(async (project) => {
      chatSessionMock.activeProject = project;
      chatSessionMock.activeChat = originChat;
      chatSessionMock.chats = [originChat];
    });
    chatSessionMock.sendMessage.mockImplementation(async () => {
      sentRoots.push(
        `${chatSessionMock.activeProject?.path ?? "missing"}:${chatSessionMock.activeChat?.projectPath ?? "missing"}`,
      );
    });
    const view = render(
      <>{WIN_TYPES.editor.render({ root: originRoot, file: "src/app.ts" }, ctx)}</>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));
    const openCfg = ctx.openWindow.mock.calls.at(-1)?.[1] as AppWindow["cfg"] | undefined;
    const selectionHandoffId = openCfg?.["selectionHandoffId"];
    expect(ctx.openWindow).toHaveBeenCalledWith("chat", {
      projectPathPrivacy: "omit",
      selectionHandoffId: expect.any(String),
    });
    expect(typeof selectionHandoffId).toBe("string");
    expect(JSON.stringify(openCfg)).not.toContain("const selected = true");
    expect(JSON.stringify(openCfg)).not.toContain(originRoot);
    if (typeof selectionHandoffId !== "string") return;

    const chatCfg = {
      chatId: "chat-wrong",
      projectPathPrivacy: "omit" as const,
      selectionHandoffId,
    };
    view.rerender(<>{WIN_TYPES.chat.render(chatCfg, ctx)}</>);
    await waitFor(() => expect(chatSessionMock.openProject).toHaveBeenCalledWith(originProject));
    await waitFor(() => expect(chatSessionMock.sendMessage).toHaveBeenCalledOnce());
    expect(sentRoots).toEqual([`${originRoot}:${originRoot}`]);
    const prompt = chatSessionMock.sendMessage.mock.calls[0]?.[0]?.text;
    expect(prompt).toContain('Root-relative file (JSON): "src/app.ts"');
    expect(prompt).toContain("Range: L2:C3-L3:C5");
    expect(prompt).toContain('"const selected = true;\\r\\n"');
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: "chat-origin",
      title: "Origin chat",
      selectionHandoffId: undefined,
      newChatRequestId: undefined,
    });
    expect(ctx.focusWindow).toHaveBeenCalledWith("ctx-window");
    expect(JSON.stringify(ctx.updateCfg.mock.calls)).not.toContain("const selected = true");
    expect(JSON.stringify(ctx.updateCfg.mock.calls)).not.toContain(originRoot);

    view.rerender(<>{WIN_TYPES.chat.render(chatCfg, ctx)}</>);
    await waitFor(() => expect(chatSessionMock.sendMessage).toHaveBeenCalledOnce());
  });

  it("creates a chat after routing a selection into an empty originating project", async () => {
    const ctx = makeCtx();
    const originRoot = "/workspace/empty-origin";
    const wrongProject = { path: "/workspace/wrong", available: true };
    const originProject = { path: originRoot, available: true };
    const createdChat = {
      id: "chat-created-after-routing",
      title: "Created chat",
      status: "open" as const,
      projectPath: originRoot,
    };
    chatSessionMock.activeProject = wrongProject;
    chatSessionMock.activeChat = undefined;
    chatSessionMock.projects = [wrongProject, originProject];
    chatSessionMock.chats = [];
    chatSessionMock.openProject.mockImplementation(async (project) => {
      chatSessionMock.activeProject = project;
      chatSessionMock.activeChat = undefined;
      chatSessionMock.chats = [];
    });
    chatSessionMock.openNewChat.mockImplementation(async () => {
      chatSessionMock.activeChat = createdChat;
      chatSessionMock.chats = [createdChat];
      return createdChat;
    });
    const view = render(
      <>{WIN_TYPES.editor.render({ root: originRoot, file: "src/app.ts" }, ctx)}</>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));
    const openCfg = ctx.openWindow.mock.calls.at(-1)?.[1] as AppWindow["cfg"] | undefined;
    const selectionHandoffId = openCfg?.["selectionHandoffId"];
    if (typeof selectionHandoffId !== "string") throw new Error("selection handoff id missing");
    view.rerender(<>{WIN_TYPES.chat.render({ selectionHandoffId }, ctx)}</>);

    await waitFor((): void =>
      expect(chatSessionMock.openProject).toHaveBeenCalledWith(originProject),
    );
    await waitFor((): void =>
      expect(chatSessionMock.openNewChat).toHaveBeenCalledWith(originProject, undefined),
    );
    await waitFor((): void => expect(chatSessionMock.sendMessage).toHaveBeenCalledOnce());
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: createdChat.id,
      title: createdChat.title,
      selectionHandoffId: undefined,
      newChatRequestId: undefined,
    });
  });

  it("keeps an asynchronous selection handoff through a StrictMode effect remount", async (): Promise<void> => {
    const ctx = makeCtx();
    const originRoot = "/workspace/origin";
    const originProject = { path: originRoot, available: true };
    const originChat = {
      id: "chat-origin",
      title: "Origin chat",
      status: "open",
      projectPath: originRoot,
    };
    const projectOpen = deferred<void>();
    chatSessionMock.activeProject = { path: "/workspace/wrong", available: true };
    chatSessionMock.activeChat = undefined;
    chatSessionMock.projects = [chatSessionMock.activeProject, originProject];
    chatSessionMock.chats = [originChat];
    chatSessionMock.openProject.mockImplementation(async (): Promise<void> => {
      await projectOpen.promise;
      chatSessionMock.activeProject = originProject;
      chatSessionMock.activeChat = originChat;
    });
    const view = render(
      <>{WIN_TYPES.editor.render({ root: originRoot, file: "src/app.ts" }, ctx)}</>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));
    const openCfg = ctx.openWindow.mock.calls.at(-1)?.[1] as AppWindow["cfg"] | undefined;
    const selectionHandoffId = openCfg?.["selectionHandoffId"];
    if (typeof selectionHandoffId !== "string") throw new Error("selection handoff id missing");
    view.rerender(<StrictMode>{WIN_TYPES.chat.render({ selectionHandoffId }, ctx)}</StrictMode>);
    await waitFor((): void => expect(chatSessionMock.openProject).toHaveBeenCalledOnce());
    expect(inspectEditorSelectionHandoff(selectionHandoffId)).not.toBeNull();

    await act(async (): Promise<void> => {
      projectOpen.resolve();
      await projectOpen.promise;
    });
    await waitFor((): void => expect(chatSessionMock.sendMessage).toHaveBeenCalledOnce());
    expect(inspectEditorSelectionHandoff(selectionHandoffId)).toBeNull();
  });

  it("discards an unconsumed selection handoff after a genuine chat unmount", async (): Promise<void> => {
    const ctx = makeCtx();
    const originRoot = "/workspace/origin";
    chatSessionMock.projects = [{ path: originRoot, available: true }];
    chatSessionMock.loading = true;
    const view = render(
      <>{WIN_TYPES.editor.render({ root: originRoot, file: "src/app.ts" }, ctx)}</>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));
    const openCfg = ctx.openWindow.mock.calls.at(-1)?.[1] as AppWindow["cfg"] | undefined;
    const selectionHandoffId = openCfg?.["selectionHandoffId"];
    if (typeof selectionHandoffId !== "string") throw new Error("selection handoff id missing");
    view.rerender(<>{WIN_TYPES.chat.render({ selectionHandoffId }, ctx)}</>);
    expect(inspectEditorSelectionHandoff(selectionHandoffId)).not.toBeNull();

    view.unmount();
    await waitFor((): void => expect(inspectEditorSelectionHandoff(selectionHandoffId)).toBeNull());
  });

  it.each([
    ["missing", []],
    ["unavailable", [{ path: "/workspace/unavailable", available: false }]],
  ])(
    "discards and announces a handoff whose originating project is %s",
    async (_case, projects) => {
      const ctx = makeCtx();
      const unavailableRoot = "/workspace/unavailable";
      chatSessionMock.projects = projects;
      const view = render(
        <>{WIN_TYPES.editor.render({ root: unavailableRoot, file: "src/app.ts" }, ctx)}</>,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));
      const openCfg = ctx.openWindow.mock.calls.at(-1)?.[1] as AppWindow["cfg"] | undefined;
      const selectionHandoffId = openCfg?.["selectionHandoffId"];
      if (typeof selectionHandoffId !== "string") throw new Error("selection handoff id missing");
      view.rerender(<>{WIN_TYPES.chat.render({ selectionHandoffId }, ctx)}</>);

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Chat is unavailable for this workspace.",
      );
      expect(chatSessionMock.openProject).not.toHaveBeenCalled();
      expect(chatSessionMock.openNewChat).not.toHaveBeenCalled();
      expect(chatSessionMock.sendMessage).not.toHaveBeenCalled();
      expect(ctx.updateCfg).toHaveBeenCalledWith({ selectionHandoffId: undefined });
    },
  );

  it("discards and announces when exact-project routing does not establish an exact chat", async () => {
    const ctx = makeCtx();
    const originRoot = "/workspace/origin";
    chatSessionMock.activeProject = { path: "/workspace/wrong", available: true };
    chatSessionMock.activeChat = {
      id: "chat-wrong",
      title: "Wrong chat",
      status: "open",
      projectPath: "/workspace/wrong",
    };
    chatSessionMock.projects = [
      chatSessionMock.activeProject,
      { path: originRoot, available: true },
    ];
    const view = render(
      <>{WIN_TYPES.editor.render({ root: originRoot, file: "src/app.ts" }, ctx)}</>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));
    const openCfg = ctx.openWindow.mock.calls.at(-1)?.[1] as AppWindow["cfg"] | undefined;
    const selectionHandoffId = openCfg?.["selectionHandoffId"];
    if (typeof selectionHandoffId !== "string") throw new Error("selection handoff id missing");
    view.rerender(<>{WIN_TYPES.chat.render({ selectionHandoffId }, ctx)}</>);

    await waitFor(() => expect(chatSessionMock.openProject).toHaveBeenCalledOnce());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not open chat for this selection.",
    );
    expect(chatSessionMock.sendMessage).not.toHaveBeenCalled();
    expect(ctx.updateCfg).toHaveBeenCalledWith({ selectionHandoffId: undefined });
  });

  it("opens an existing exact-root chat before consuming an active-chat mismatch", async () => {
    const ctx = makeCtx();
    const originRoot = "/workspace/origin";
    const originProject = { path: originRoot, available: true };
    const originChat = {
      id: "chat-origin",
      title: "Origin chat",
      status: "open",
      projectPath: originRoot,
    };
    chatSessionMock.activeProject = originProject;
    chatSessionMock.activeChat = {
      id: "chat-wrong",
      title: "Wrong chat",
      status: "open",
      projectPath: "/workspace/wrong",
    };
    chatSessionMock.projects = [originProject];
    chatSessionMock.chats = [chatSessionMock.activeChat, originChat];
    chatSessionMock.openChat.mockImplementation(async () => {
      chatSessionMock.activeChat = originChat;
    });
    const view = render(
      <>{WIN_TYPES.editor.render({ root: originRoot, file: "src/app.ts" }, ctx)}</>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));
    const openCfg = ctx.openWindow.mock.calls.at(-1)?.[1] as AppWindow["cfg"] | undefined;
    const selectionHandoffId = openCfg?.["selectionHandoffId"];
    if (typeof selectionHandoffId !== "string") throw new Error("selection handoff id missing");
    view.rerender(<>{WIN_TYPES.chat.render({ selectionHandoffId }, ctx)}</>);

    await waitFor(() => expect(chatSessionMock.openChat).toHaveBeenCalledWith(originChat));
    await waitFor(() => expect(chatSessionMock.sendMessage).toHaveBeenCalledOnce());
    expect(chatSessionMock.openProject).not.toHaveBeenCalled();
    const openOrder = chatSessionMock.openChat.mock.invocationCallOrder[0];
    const sendOrder = chatSessionMock.sendMessage.mock.invocationCallOrder[0];
    expect(openOrder).toBeDefined();
    expect(sendOrder).toBeDefined();
    if (openOrder === undefined || sendOrder === undefined) return;
    expect(sendOrder).toBeGreaterThan(openOrder);
  });

  it("creates one exact-root chat when the originating project has no open chat", async () => {
    const ctx = makeCtx();
    const originRoot = "/workspace/origin";
    const originProject = { path: originRoot, available: true };
    const createdChat = {
      id: "chat-created",
      title: "Created chat",
      status: "open",
      projectPath: originRoot,
    };
    chatSessionMock.activeProject = originProject;
    chatSessionMock.activeChat = undefined;
    chatSessionMock.projects = [originProject];
    chatSessionMock.chats = [];
    chatSessionMock.openNewChat.mockImplementation(async () => {
      chatSessionMock.activeChat = createdChat;
      chatSessionMock.chats = [createdChat];
      return createdChat;
    });
    const view = render(
      <>{WIN_TYPES.editor.render({ root: originRoot, file: "src/app.ts" }, ctx)}</>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));
    const openCfg = ctx.openWindow.mock.calls.at(-1)?.[1] as AppWindow["cfg"] | undefined;
    const selectionHandoffId = openCfg?.["selectionHandoffId"];
    if (typeof selectionHandoffId !== "string") throw new Error("selection handoff id missing");
    view.rerender(<>{WIN_TYPES.chat.render({ selectionHandoffId }, ctx)}</>);

    await waitFor((): void => {
      expect(chatSessionMock.openNewChat).toHaveBeenCalledWith(originProject, undefined);
    });
    await waitFor(() => expect(chatSessionMock.sendMessage).toHaveBeenCalledOnce());
    expect(chatSessionMock.openNewChat).toHaveBeenCalledOnce();
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: "chat-created",
      title: "Created chat",
      selectionHandoffId: undefined,
      newChatRequestId: undefined,
    });
  });

  it("keeps a fresh window request independent from an in-flight selection chat", async (): Promise<void> => {
    const ctx = makeCtx();
    const originRoot = "/workspace/origin";
    const originProject = { path: originRoot, available: true };
    const createdChat = {
      id: "chat-created",
      title: "Created chat",
      status: "open",
      projectPath: originRoot,
    };
    const renamedChat = {
      ...createdChat,
      id: "chat-replacement",
      title: "Replacement chat",
    };
    const creation = deferred<typeof createdChat | undefined>();
    const replacement = deferred<typeof renamedChat | undefined>();
    chatSessionMock.activeProject = originProject;
    chatSessionMock.activeChat = undefined;
    chatSessionMock.projects = [originProject];
    chatSessionMock.chats = [];
    chatSessionMock.openNewChat
      .mockReturnValueOnce(creation.promise)
      .mockReturnValueOnce(replacement.promise);
    const view = render(
      <>{WIN_TYPES.editor.render({ root: originRoot, file: "src/app.ts" }, ctx)}</>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));
    const openCfg = ctx.openWindow.mock.calls.at(-1)?.[1] as AppWindow["cfg"] | undefined;
    const selectionHandoffId = openCfg?.["selectionHandoffId"];
    if (typeof selectionHandoffId !== "string") throw new Error("selection handoff id missing");
    view.rerender(<>{WIN_TYPES.chat.render({ selectionHandoffId }, ctx)}</>);
    await waitFor((): void => expect(chatSessionMock.openNewChat).toHaveBeenCalledOnce());

    view.rerender(
      <>
        {WIN_TYPES.chat.render(
          { title: "Replacement chat", newChatRequestId: "replacement-1" },
          ctx,
        )}
      </>,
    );
    expect(chatSessionMock.openNewChat).toHaveBeenCalledTimes(2);

    await act(async (): Promise<void> => {
      creation.resolve(createdChat);
      await creation.promise;
    });

    expect(chatSessionMock.openNewChat).toHaveBeenCalledTimes(2);
    expect(chatSessionMock.sendMessage).not.toHaveBeenCalled();
    expect(ctx.updateCfg).not.toHaveBeenCalled();

    await act(async (): Promise<void> => {
      replacement.resolve(renamedChat);
      await replacement.promise;
    });

    await waitFor((): void =>
      expect(ctx.updateCfg).toHaveBeenCalledWith({
        chatId: "chat-replacement",
        projectPath: originRoot,
        title: "Replacement chat",
        newChatRequestId: undefined,
      }),
    );
    expect(apiMock.updateChat).not.toHaveBeenCalled();
    expect(chatSessionMock.replaceChat).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps an editor handoff independent from an in-flight window chat", async (): Promise<void> => {
    const ctx = makeCtx();
    const originRoot = "/workspace/origin";
    const originProject = { path: originRoot, available: true };
    const windowChat = {
      id: "window-chat",
      title: "Window chat",
      status: "open" as const,
      projectPath: originRoot,
    };
    const handoffChat = {
      id: "handoff-chat",
      title: "Selection chat",
      status: "open" as const,
      projectPath: originRoot,
    };
    const windowCreation = deferred<typeof windowChat>();
    const handoffCreation = deferred<typeof handoffChat>();
    chatSessionMock.activeProject = originProject;
    chatSessionMock.activeChat = undefined;
    chatSessionMock.projects = [originProject];
    chatSessionMock.chats = [];
    chatSessionMock.openNewChat
      .mockReturnValueOnce(windowCreation.promise)
      .mockImplementationOnce((): Promise<typeof handoffChat> =>
        handoffCreation.promise.then((created): typeof handoffChat => {
          chatSessionMock.activeChat = created;
          chatSessionMock.chats = [created];
          return created;
        }),
      );
    const view = render(
      <>{WIN_TYPES.editor.render({ root: originRoot, file: "src/app.ts" }, ctx)}</>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));
    const openCfg = ctx.openWindow.mock.calls.at(-1)?.[1] as AppWindow["cfg"] | undefined;
    const selectionHandoffId = openCfg?.["selectionHandoffId"];
    if (typeof selectionHandoffId !== "string") throw new Error("selection handoff id missing");
    view.rerender(
      <>
        {WIN_TYPES.chat.render({ title: "Window chat", newChatRequestId: "window-request" }, ctx)}
      </>,
    );
    await waitFor((): void => expect(chatSessionMock.openNewChat).toHaveBeenCalledOnce());

    view.rerender(
      <>
        {WIN_TYPES.chat.render(
          { title: "Window chat", newChatRequestId: "window-request", selectionHandoffId },
          ctx,
        )}
      </>,
    );
    expect(chatSessionMock.openNewChat).toHaveBeenCalledTimes(2);

    await act(async (): Promise<void> => {
      windowCreation.resolve(windowChat);
      await windowCreation.promise;
    });
    expect(ctx.updateCfg).not.toHaveBeenCalled();
    expect(chatSessionMock.sendMessage).not.toHaveBeenCalled();

    await act(async (): Promise<void> => {
      handoffCreation.resolve(handoffChat);
      await handoffCreation.promise;
    });

    await waitFor((): void => expect(chatSessionMock.sendMessage).toHaveBeenCalledOnce());
    expect(chatSessionMock.openNewChat).toHaveBeenCalledTimes(2);
    expect(apiMock.updateChat).not.toHaveBeenCalled();
    expect(chatSessionMock.replaceChat).not.toHaveBeenCalled();
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: "handoff-chat",
      title: "Selection chat",
      selectionHandoffId: undefined,
      newChatRequestId: undefined,
    });
  });

  it("keeps the handoff chat bound when a pending window creation settles late", async (): Promise<void> => {
    const ctx = makeCtx();
    const existingChat = chatSessionMock.activeChat;
    if (existingChat === undefined) throw new Error("existing chat fixture missing");
    const creation = deferred<{
      readonly id: string;
      readonly title: string;
      readonly status: string;
      readonly projectPath: string;
    }>();
    chatSessionMock.openNewChat.mockReturnValue(creation.promise);
    const view = render(<>{WIN_TYPES.editor.render({ root: "/repo", file: "src/app.ts" }, ctx)}</>);

    fireEvent.click(await screen.findByRole("button", { name: "Ask editor selection" }));
    const openCfg = ctx.openWindow.mock.calls.at(-1)?.[1] as AppWindow["cfg"] | undefined;
    const selectionHandoffId = openCfg?.["selectionHandoffId"];
    if (typeof selectionHandoffId !== "string") throw new Error("selection handoff id missing");
    view.rerender(
      <>
        {WIN_TYPES.chat.render({ title: "Window chat", newChatRequestId: "window-request" }, ctx)}
      </>,
    );
    await waitFor((): void => expect(chatSessionMock.openNewChat).toHaveBeenCalledOnce());

    view.rerender(
      <>{WIN_TYPES.chat.render({ newChatRequestId: "window-request", selectionHandoffId }, ctx)}</>,
    );
    await waitFor((): void => expect(chatSessionMock.sendMessage).toHaveBeenCalledOnce());
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: existingChat.id,
      title: existingChat.title,
      selectionHandoffId: undefined,
      newChatRequestId: undefined,
    });

    await act(async (): Promise<void> => {
      creation.resolve({
        id: "chat-created-late",
        title: "Window chat",
        status: "open",
        projectPath: "/repo",
      });
      await creation.promise;
    });

    expect(ctx.updateCfg).not.toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-created-late" }),
    );
  });

  it("binds the persisted chat and reports when an adopted title cannot be saved", async (): Promise<void> => {
    const ctx = makeCtx();
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const createdChat = {
      id: "chat-created",
      title: "Created chat",
      status: "open",
      projectPath: "/repo",
    };
    chatSessionMock.activeChat = undefined;
    chatSessionMock.chats = [];
    chatSessionMock.openNewChat.mockResolvedValue(createdChat);
    apiMock.updateChat.mockRejectedValue(new Error("customer-chat-title-detail"));
    const view = render(
      <>
        {WIN_TYPES.chat.render(
          { title: "Replacement chat", newChatRequestId: "replacement-1" },
          ctx,
        )}
      </>,
    );

    await waitFor((): void => {
      expect(ctx.updateCfg).toHaveBeenCalledWith({
        chatId: "chat-created",
        projectPath: "/repo",
        title: "Created chat",
        newChatRequestId: undefined,
      });
    });
    chatSessionMock.activeChat = createdChat;
    chatSessionMock.chats = [createdChat];
    view.rerender(
      <>{WIN_TYPES.chat.render({ chatId: "chat-created", title: "Created chat" }, ctx)}</>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The chat opened, but its title could not be saved.",
    );
    expect(chatSessionMock.openNewChat).toHaveBeenCalledOnce();
    expect(chatSessionMock.replaceChat).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledOnce();
    const reported = reportError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toMatch(
      /^Chat title update failed\. Correlation ID: [A-Za-z0-9._-]{8,128}$/,
    );
    expect((reported as Error).message).not.toContain("customer-chat-title-detail");
    expect((reported as Error).message).not.toContain("Replacement chat");
  });

  it("maps window cfg into widget props and follow-up workspace actions", async () => {
    const ctx = makeCtx();
    const view = render(<>{WIN_TYPES.files.render({ root: "/repo" }, ctx)}</>);

    expect(await screen.findByTestId("files-root")).toHaveTextContent("/repo");
    fireEvent.click(screen.getByRole("button", { name: "Active file" }));
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      activeFilePath: "src/app.ts",
      activeDirectoryPath: "/repo/src",
      resolvedRoot: "/repo",
    });
    expect(screen.queryByRole("button", { name: "Change root" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("editor", {
      root: "/repo",
      file: "src/app.ts",
      openFiles: ["src/app.ts"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Git" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("governedGit", { projectPath: "/repo" });

    const unboundCtx = { ...makeCtx(), linkedRoot: null, linkedRoots: [] };
    view.rerender(<>{WIN_TYPES.files.render({}, unboundCtx)}</>);
    fireEvent.click(await screen.findByRole("button", { name: "Change root" }));
    expect(unboundCtx.updateCfg).toHaveBeenCalledWith({
      root: "/next",
      activeFilePath: undefined,
      activeDirectoryPath: undefined,
      resolvedRoot: undefined,
    });

    view.rerender(<>{WIN_TYPES.review.render({}, ctx)}</>);
    fireEvent.click(await screen.findByTestId("review-widget"));
    expect(ctx.updateCfg).toHaveBeenCalledWith({ runId: "run-entered" });

    view.rerender(
      <>
        {WIN_TYPES.editor.render(
          {
            root: "/repo",
            file: "src/app.ts",
            openFiles: ["src/app.ts", "package.json"],
            revealLineStart: 7,
            revealLineEnd: 10,
            revealRequestId: "reveal-1",
          },
          ctx,
        )}
        {WIN_TYPES.browser.render({ url: "https://example.test" }, ctx)}
        {WIN_TYPES.terminal.render({ cwd: "/repo", projectPath: "/repo" }, ctx)}
        {WIN_TYPES.agents.render({ workflow: "verify", access: "full", keikoMode: true }, ctx)}
      </>,
    );
    expect(await screen.findByTestId("editor-widget")).toHaveTextContent(
      "/repo:src/app.ts:src/app.ts|package.json::/repo:src/app.ts:cap-1:set-1:7:10:reveal-1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open blame commit" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("governedGit", {
      projectPath: "/repo",
      commit: "a".repeat(40),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open file diff" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("governedGit", {
      projectPath: "/repo",
      path: "src/app.ts",
    });
    fireEvent.click(screen.getByRole("button", { name: "Change editor workspace" }));
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      root: "/next-root",
      file: "README.md",
      openFiles: ["README.md"],
      layoutJson: '{"version":1}',
    });
    expect(await screen.findByTestId("browser-widget")).toHaveTextContent("https://example.test");
    expect(await screen.findByTestId("terminal-widget")).toHaveTextContent("/repo:/repo");
    expect(await screen.findByTestId("agent-widget")).toHaveTextContent("verify:/repo:src/app.ts");

    view.rerender(<>{WIN_TYPES.promptEnhancer.render({}, ctx)}</>);
    expect(await screen.findByTestId("prompt-enhancer-panel")).toHaveTextContent(
      "/repo:src/app.ts:/repo|/docs",
    );

    view.rerender(<>{WIN_TYPES.settings.render({}, ctx)}</>);
    expect(await screen.findByTestId("settings-panel")).toHaveTextContent("SettingsPanel:/repo");
    fireEvent.click(await screen.findByTestId("settings-panel"));
    expect(ctx.openWindow).toHaveBeenCalledWith("updates", { entrypoint: "settings" });

    view.rerender(<>{WIN_TYPES.updates.render({}, ctx)}</>);
    expect(await screen.findByTestId("update-window")).toHaveTextContent("UpdateWindow");
  });

  it("maps the runtime hub into existing runtime and governed delivery windows", async () => {
    const ctx = makeCtx();
    render(<>{WIN_TYPES.runtime.render({ projectPath: "/repo" }, ctx)}</>);

    expect(await screen.findByTestId("runtime-hub-widget")).toHaveTextContent("/repo");
    fireEvent.click(screen.getByRole("button", { name: "Change runtime project" }));
    expect(ctx.updateCfg).toHaveBeenCalledWith({ projectPath: "/next-runtime" });
    fireEvent.click(screen.getByRole("button", { name: "Runtime files" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("files", { root: "/repo" });
    fireEvent.click(screen.getByRole("button", { name: "Runtime tasks" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("commands", { projectPath: "/repo" });
    fireEvent.click(screen.getByRole("button", { name: "Runtime containers" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("containerStatus", { projectPath: "/repo" });
    fireEvent.click(screen.getByRole("button", { name: "Runtime git" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("governedGit", { projectPath: "/repo" });
    fireEvent.click(screen.getByRole("button", { name: "Runtime pr" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("governedPullRequest", { projectPath: "/repo" });
    fireEvent.click(screen.getByRole("button", { name: "Runtime merge" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("governedMerge", { projectPath: "/repo" });
  });

  it("renders the Coding Workbench singleton through the workspace registry", async () => {
    const ctx = makeCtx();
    expect(WIN_TYPES.coding.icon).toBe("codingWorkbench");
    expect(WIN_TYPES.terminal.icon).toBe("terminal");
    render(<>{WIN_TYPES.coding.render({}, ctx)}</>);

    expect(await screen.findByTestId("coding-workbench-window")).toHaveTextContent(
      "Coding Workbench",
    );
  });

  it("wires hub callbacks for quality, regenerated runs, connector management, figma, and chat history", async () => {
    const ctx = makeCtx();
    const view = render(<>{WIN_TYPES.quality.render({}, ctx)}</>);

    fireEvent.click(await screen.findByTestId("qi-hub"));
    expect(ctx.openWindow).toHaveBeenCalledWith(
      "qiRun",
      expect.objectContaining({ runId: "qi-run-1" }),
    );

    view.rerender(<>{WIN_TYPES.qiRun.render({ runId: "qi-run-1" }, ctx)}</>);
    fireEvent.click(await screen.findByTestId("qi-run-card"));
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
    expect(await screen.findByTestId("connector-widget")).toHaveTextContent("inline:cap-1");
    fireEvent.click(screen.getByRole("button", { name: "Select Knowledge Pod" }));
    expect(ctx.updateCfg).toHaveBeenCalledWith({ selectedKind: "capsule", selectedId: "cap-1" });
    fireEvent.click(screen.getByRole("button", { name: "Manage Knowledge Pods" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("localKnowledge");

    view.rerender(<>{WIN_TYPES.figma.render({ snapshotRunId: "fs-1" }, ctx)}</>);
    fireEvent.click(await screen.findByTestId("figma-window"));
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
    expect(await screen.findByTestId("figma-window")).toHaveTextContent("ctx-window:fs-1:screen-1");

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
    expect(await screen.findByTestId("figma-window")).toHaveTextContent("ctx-window:fs-1:screen-1");

    view.rerender(
      <>
        {WIN_TYPES.figmaJson.render(
          { snapshotRunId: "fs-1", screenId: "screen-1", selectedScreenName: "Screen 1" },
          ctx,
        )}
      </>,
    );
    expect(await screen.findByTestId("figma-json-window")).toHaveTextContent(
      "fs-1:screen-1:Screen 1",
    );

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
    expect(await screen.findByTestId("figma-image-window")).toHaveTextContent(
      "/api/figma/snapshots/fs-1/screens/0/image:Screen 1",
    );

    view.rerender(<>{WIN_TYPES.chatHistory.render({}, ctx)}</>);
    fireEvent.click(await screen.findByRole("button", { name: "Open history chat" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("chat", {
      chatId: "chat-2",
      projectPath: "/repo",
      title: "Chat 2",
    });

    view.rerender(
      <>
        {WIN_TYPES.chat.render({ chatId: "chat-1" }, ctx)}
        {WIN_TYPES.localKnowledge.render({}, ctx)}
        {WIN_TYPES.relationships.render({}, ctx)}
      </>,
    );
    expect(await screen.findByTestId("chat-window")).toHaveTextContent("true:/repo");
    fireEvent.click(screen.getByRole("button", { name: "Open chat run" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("agents", {
      runId: "run-chat",
      workflow: "unit-test-generation",
      workspaceRoot: "/repo",
    });
    expect(await screen.findByTestId("connector-graph")).toHaveTextContent("false");
    expect(await screen.findByText("RelationshipsView")).toBeInTheDocument();
  });
});

// Issue #446 (ADR-0090) — prove the active-workspace root is actually WIRED into each bound-surface
// renderer (not just the resolveBoundRoot helper): a mutation removing the override from a renderer
// must fail here. Covers AC1/AC2 + the SC "no surface remains pointed at the previous workspace".
describe("active workspace binding override (Issue #446)", () => {
  function boundCtx(
    activeRoot: string | null,
    selectedRoot: string | null = null,
  ): WindowRenderContext {
    return { ...makeCtx(), activeRoot, selectedRoot, linkedRoot: null };
  }

  it("roots an unbound editor in the folder selected by the global workspace context", async () => {
    const selectedRoot = "/Users/oscharko-dev/Projects/Keiko";

    render(<>{WIN_TYPES.editor.render({}, boundCtx(null, selectedRoot))}</>);

    expect(await screen.findByTestId("editor-widget")).toHaveTextContent(`${selectedRoot}:`);
  });

  it("hands issue cloning to Git and selects the registered checkout in its originating Coding window", async () => {
    const ctx = makeCtx();
    const view = render(<>{WIN_TYPES.coding.render({}, ctx)}</>);
    fireEvent.click(await screen.findByRole("button", { name: "Clone for issue" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("governedGit", {
      rootBinding: "coding-repository",
      repositoryDialog: "clone",
      repositoryReturnWindow: ctx.windowId,
    });
    view.rerender(
      <>
        {WIN_TYPES.governedGit.render(
          { repositoryDialog: "clone", repositoryReturnWindow: "coding-source" },
          ctx,
        )}
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Complete issue clone" }));
    expect(ctx.updateWindow).toHaveBeenCalledWith("coding-source", {
      cfg: { repositoryPath: "/repos/cloned" },
    });
    expect(ctx.focusWindow).toHaveBeenCalledWith("coding-source");
    expect(ctx.updateCfg).toHaveBeenCalledWith({ repositoryReturnWindow: "" });
  });

  it("preserves an explicit dormant Coding Workbench repository selection for Git", async () => {
    const ctx = boundCtx(null, "/repos/keiko");
    const view = render(<>{WIN_TYPES.coding.render({}, ctx)}</>);

    fireEvent.click(await screen.findByRole("button", { name: "Open coding repository Git" }));
    expect(ctx.openWindow).toHaveBeenCalledWith("governedGit", {
      projectPath: "/repos/keiko",
      rootBinding: "coding-repository",
    });

    view.rerender(
      <>
        {WIN_TYPES.governedGit.render(
          { projectPath: "/repos/keiko", rootBinding: "coding-repository" },
          ctx,
        )}
      </>,
    );
    expect(await screen.findByTestId("git-client-window")).toHaveTextContent("/repos/keiko");
    fireEvent.click(screen.getByRole("button", { name: "Reveal Git file" }));
    expect(ctx.openEditorFile).toHaveBeenCalledWith({
      root: "/repos/keiko",
      path: "src/app.ts",
      lineStart: 7,
    });
  });

  it("retargets a dormant Git window to the active task worktree", async () => {
    const activeRoot = "/worktrees/active-task";
    const ctx: WindowRenderContext = {
      ...boundCtx(activeRoot, "/repos/keiko"),
      activeBinding: {
        schemaVersion: "1",
        workspaceId: "workspace-1",
        taskId: "task-1",
        activeRoot,
        boundSurfaces: ["git-delivery"],
        gitDeliveryRoot: activeRoot,
        editorProjectRoot: activeRoot,
      },
    };

    render(
      <>
        {WIN_TYPES.governedGit.render(
          { projectPath: "/repos/keiko", rootBinding: "coding-repository" },
          ctx,
        )}
      </>,
    );

    expect(await screen.findByTestId("git-client-window")).toHaveTextContent(
      "/worktrees/active-task",
    );
  });

  it("files renderer uses the active root, overriding the per-window cfg root", async () => {
    render(<>{WIN_TYPES.files.render({ root: "/cfg/old" }, boundCtx("/wt/active"))}</>);
    expect(await screen.findByTestId("files-root")).toHaveTextContent("/wt/active");
  });

  it("files renderer falls back to the cfg root in unbound mode", async () => {
    render(<>{WIN_TYPES.files.render({ root: "/cfg/old" }, boundCtx(null))}</>);
    expect(await screen.findByTestId("files-root")).toHaveTextContent("/cfg/old");
  });

  it("files renderer preserves an explicitly selected folder in unbound mode", async () => {
    render(
      <>
        {WIN_TYPES.files.render({ root: "/picked/folder" }, boundCtx(null, "/workbench/default"))}
      </>,
    );

    expect(await screen.findByTestId("files-root")).toHaveTextContent("/picked/folder");
  });

  it("terminal renderer scopes projectPath + cwd to the active root", async () => {
    render(
      <>
        {WIN_TYPES.terminal.render(
          { projectPath: "/cfg/old", cwd: "/cfg/old" },
          boundCtx("/wt/active"),
        )}
      </>,
    );
    expect(await screen.findByTestId("terminal-widget")).toHaveTextContent("/wt/active:/wt/active");
  });

  // RELOCATED REGRESSION PIN (Issue #446, ADR-0090 D4) — do not delete, move it if the layer moves.
  // It was originally `it("editor renderer targets the active root and remounts (key changes) on a
  // switch")` and asserted the React `key` of the element this renderer returns. Epic #2285 moved
  // the remount key one layer down — `EditorWindowSessionHost` now keys its V1 editor — and the pin
  // was replaced by a `key === null` assertion, which proves the host is stable but says nothing
  // about the remount the ADR relies on. Issue #2621 restores it where the invariant now lives, and
  // states it as the behaviour rather than the mechanism: a switch must tear the editor down, which
  // is how the stale Monaco model is dropped (ADR-0090 D4, SC "no stale editor model").
  it("editor renderer targets the active root and remounts the editor on a switch", async () => {
    editorWidgetMounts.length = 0;
    editorWidgetUnmounts.length = 0;
    const view = render(
      <>{WIN_TYPES.editor.render({ root: "/cfg/old" }, boundCtx("/wt/active"))}</>,
    );
    expect(await screen.findByTestId("editor-widget")).toHaveTextContent("/wt/active:");

    view.rerender(<>{WIN_TYPES.editor.render({ root: "/cfg/old" }, boundCtx("/wt/a"))}</>);
    expect(await screen.findByTestId("editor-widget")).toHaveTextContent("/wt/a:");
    view.rerender(<>{WIN_TYPES.editor.render({ root: "/cfg/old" }, boundCtx("/wt/b"))}</>);
    expect(await screen.findByTestId("editor-widget")).toHaveTextContent("/wt/b:");

    // Each switch built a new editor and destroyed the previous one. An in-place update would leave
    // one mount and no unmount here — that is the shape this pin exists to reject.
    expect(editorWidgetMounts).toEqual(["/wt/active", "/wt/a", "/wt/b"]);
    expect(editorWidgetUnmounts).toEqual(["/wt/active", "/wt/a"]);

    // Unbound mode keeps the window's own cfg root, and re-rendering an unchanged root must NOT
    // remount: the identity is derived from the root, never from the render count.
    view.rerender(<>{WIN_TYPES.editor.render({ root: "/cfg/old" }, boundCtx(null))}</>);
    expect(await screen.findByTestId("editor-widget")).toHaveTextContent("/cfg/old:");
    view.rerender(<>{WIN_TYPES.editor.render({ root: "/cfg/old" }, boundCtx(null))}</>);
    expect(editorWidgetMounts).toEqual(["/wt/active", "/wt/a", "/wt/b", "/cfg/old"]);

    // The outer session host itself carries no key, deliberately: it must survive a switch so a
    // multi-root workspace can retain its sibling roots' state containers.
    const host = WIN_TYPES.editor.render({ root: "/cfg/old" }, boundCtx("/wt/a")) as {
      key: string | null;
    };
    expect(host.key).toBeNull();
  });

  it("search renderer uses the active root before linked or active-project fallbacks", async () => {
    render(
      <>{WIN_TYPES.search.render({}, { ...boundCtx("/wt/active"), linkedRoot: "/linked" })}</>,
    );
    expect(await screen.findByTestId("search-panel")).toHaveTextContent("/wt/active");
  });

  it("search renderer stays unbound instead of borrowing the active Chat project", async (): Promise<void> => {
    render(<>{WIN_TYPES.search.render({}, boundCtx(null))}</>);
    expect(await screen.findByTestId("search-panel")).toHaveTextContent("none");
  });
});
