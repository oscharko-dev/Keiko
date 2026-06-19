import type { ReactNode, RefObject } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GROUNDING_LIMITS } from "@/lib/types";
import type {
  Chat,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  GroundingLimits,
} from "@/lib/types";
import type { UseWorkspaceResult, WorkspaceApi } from "./hooks/useWorkspace.types";
import type { AppWindow, Connection } from "./windows/types";

interface WorkspaceHookOptions {
  readonly onScopeBind?: (
    chatWindowId: string,
    scope: ChatConnectedScope,
  ) => boolean | Promise<boolean>;
  readonly onScopeUnbind?: (chatWindowId: string, scope: ChatConnectedScope) => void;
  readonly onConnectorBind?: (
    chatWindowId: string,
    scope: ChatLocalKnowledgeScope,
  ) => boolean | Promise<boolean>;
  readonly onConnectorUnbind?: (chatWindowId: string, scope: ChatLocalKnowledgeScope) => void;
}

interface TestSession {
  readonly chats: Chat[];
  readonly activeChat: Chat | undefined;
  readonly activeProject: { readonly name: string; readonly available: boolean } | undefined;
  readonly models: readonly unknown[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly noEligibleModels: boolean;
  readonly selectedModel: string;
  readonly replaceChat: (chat: Chat) => void;
}

const mocks = vi.hoisted(() => ({
  state: {
    workspaceOptions: undefined as WorkspaceHookOptions | undefined,
    workspaceResult: undefined as UseWorkspaceResult | undefined,
    session: undefined as TestSession | undefined,
    groundingLimits: undefined as GroundingLimits | undefined,
    workspaceProps: undefined as
      | {
          readonly outlineOpen?: boolean;
          readonly onToggleOutline?: () => void;
          readonly renderOutlineToggle?: boolean;
        }
      | undefined,
    rightRailProps: undefined as
      | { readonly outlineOpen?: boolean; readonly onToggleOutline?: () => void }
      | undefined,
  },
  fetchConfig: vi.fn(),
  updateChatConnectedScopes: vi.fn(),
  updateChatLocalKnowledgeScopes: vi.fn(),
  recordReadsContextRelationship: vi.fn(),
  registerSw: vi.fn(),
  useKeyboardShortcuts: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchConfig: mocks.fetchConfig,
  updateChatConnectedScopes: mocks.updateChatConnectedScopes,
  updateChatLocalKnowledgeScopes: mocks.updateChatLocalKnowledgeScopes,
}));

vi.mock("../../relationships/connector-relationship", () => ({
  recordReadsContextRelationship: mocks.recordReadsContextRelationship,
}));

vi.mock("./install/registerSw", () => ({
  registerSw: mocks.registerSw,
}));

vi.mock("./context/ChatSessionContext", () => ({
  ChatSessionProvider: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

vi.mock("./context/TwinContext", () => ({
  TwinProvider: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  useTwin: () => ({ mode: "manual", setMode: vi.fn() }),
}));

vi.mock("./hooks/useTheme", () => ({
  useTheme: () => ({ theme: "dark", toggle: vi.fn() }),
}));

vi.mock("./hooks/useChatSession", () => ({
  useChatSession: () => {
    if (mocks.state.session === undefined) throw new Error("missing test session");
    return mocks.state.session;
  },
}));

vi.mock("./hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: mocks.useKeyboardShortcuts,
}));

vi.mock("./hooks/useUndoStack", () => ({
  useUndoStack: () => ({
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    push: vi.fn(),
    undo: mocks.undo,
    redo: mocks.redo,
    clear: vi.fn(),
  }),
}));

vi.mock("./hooks/useWorkspace", () => ({
  useWorkspace: (_ref: RefObject<HTMLDivElement | null>, options: WorkspaceHookOptions) => {
    mocks.state.workspaceOptions = options;
    if (mocks.state.workspaceResult === undefined) throw new Error("missing workspace result");
    return mocks.state.workspaceResult;
  },
}));

vi.mock("./Header", () => ({
  Header: ({
    projectName,
    statusLabel,
  }: {
    readonly projectName: string;
    readonly statusLabel: string;
  }) => (
    <header>
      <span>{projectName}</span>
      <span>{statusLabel}</span>
    </header>
  ),
}));

vi.mock("./Footer", () => ({
  Footer: ({
    winCount,
    statusRef,
  }: {
    readonly winCount: number;
    readonly statusRef?: (node: HTMLElement | null) => void;
  }) => (
    <footer ref={statusRef} data-testid="footer" tabIndex={-1}>
      {winCount}
    </footer>
  ),
}));

vi.mock("./LeftRail", () => ({
  LeftRail: ({ onNewChat }: { readonly onNewChat: () => void }) => (
    <button type="button" onClick={onNewChat}>
      New chat
    </button>
  ),
}));

vi.mock("./RightRail", () => ({
  RightRail: (props: { readonly outlineOpen?: boolean; readonly onToggleOutline?: () => void }) => {
    mocks.state.rightRailProps = props;
    return (
      <button type="button" data-testid="right-rail" onClick={props.onToggleOutline}>
        {props.outlineOpen === true ? "Outline open" : "Outline closed"}
      </button>
    );
  },
}));

vi.mock("./Workspace", () => ({
  Workspace: (props: {
    readonly outlineOpen?: boolean;
    readonly onToggleOutline?: () => void;
    readonly renderOutlineToggle?: boolean;
  }) => {
    mocks.state.workspaceProps = props;
    return <main data-testid="workspace" data-outline-open={props.outlineOpen === true} />;
  },
}));

vi.mock("./modals/CommandPalette", () => ({
  CommandPalette: () => <div data-testid="command-palette" />,
}));

vi.mock("./modals/GatewaySetupDialog", () => ({
  GatewaySetupDialog: () => <div role="dialog" aria-label="Gateway setup" />,
}));

vi.mock("./modals/NewWindowDialog", () => ({
  NewWindowDialog: () => <div role="dialog" aria-label="New window" />,
}));

vi.mock("./modals/Palette", () => ({
  Palette: () => <div role="dialog" aria-label="Palette" />,
}));

vi.mock("./install/InstallBanner", () => ({
  InstallBanner: () => <div data-testid="install-banner" />,
}));

vi.mock("./widgets", () => ({}));

import { AppShell } from "./AppShell";

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/repo",
    title: "Release chat",
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function win(type: AppWindow["type"], cfg: AppWindow["cfg"] = {}, id = `${type}-1`): AppWindow {
  return { id, type, x: 0, y: 0, w: 400, h: 300, z: 1, cfg, max: false, zoom: 1 };
}

function workspaceApi(patch: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    add: vi.fn(() => null),
    toggleTool: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    minimize: vi.fn(),
    restore: vi.fn(),
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
    updateConnBoundScope: vi.fn(),
    connect: vi.fn(),
    linkedFilesRoot: vi.fn(() => null),
    linkedFilesContext: vi.fn(() => null),
    linkedAllFilesRoots: vi.fn(() => []),
    linkedConnectorCapsuleIds: vi.fn(() => []),
    linkedConnectorCapsuleSetIds: vi.fn(() => []),
    linkedFigmaSnapshotRunIds: vi.fn(() => []),
    currentFilesContext: vi.fn(() => null),
    zoomTo: vi.fn(),
    fitView: vi.fn(),
    resetView: vi.fn(),
    panBy: vi.fn(),
    rect: vi.fn(() => null),
    ...patch,
  };
}

function workspaceResult(wins: AppWindow[], conns: Connection[] = []): UseWorkspaceResult {
  return {
    wins,
    snapPrev: null,
    palOpen: false,
    setPalOpen: vi.fn(),
    conns,
    connecting: null,
    view: { x: 0, y: 0, zoom: 1 },
    api: workspaceApi(),
  };
}

function fileScope(root: string, index = 0): ChatConnectedScope {
  return {
    kind: "workspace-root",
    relativePaths: [],
    root,
    connectedAtMs: index,
  };
}

function capsuleScope(id: string): ChatLocalKnowledgeScope {
  return { kind: "capsule", capsuleId: id as never, connectedAtMs: 1 };
}

async function renderMounted(): Promise<void> {
  render(<AppShell />);
  await screen.findByTestId("workspace");
  await waitFor(() => expect(mocks.state.workspaceOptions).toBeDefined());
}

describe("AppShell grounding connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.groundingLimits = DEFAULT_GROUNDING_LIMITS;
    mocks.fetchConfig.mockResolvedValue({
      config: null,
      configPresent: false,
      effectiveGroundingLimits: DEFAULT_GROUNDING_LIMITS,
    });
    const activeChat = chat();
    mocks.state.session = {
      chats: [activeChat],
      activeChat,
      activeProject: { name: "Keiko", available: true },
      models: [{ id: "example-chat-model" }],
      loading: false,
      error: undefined,
      noEligibleModels: false,
      selectedModel: "example-chat-model",
      replaceChat: vi.fn(),
    };
    mocks.state.workspaceResult = workspaceResult([
      win("chat", { chatId: "chat-1" }, "chat-window"),
    ]);
    mocks.state.workspaceOptions = undefined;
    mocks.state.workspaceProps = undefined;
    mocks.state.rightRailProps = undefined;
  });

  it("persists a new Files source and records the governed reads-context relationship", async () => {
    const updated = chat({ connectedScopes: [fileScope("/repo")] });
    mocks.updateChatConnectedScopes.mockResolvedValue({ chat: updated });
    await renderMounted();

    let accepted = false;
    await act(async () => {
      accepted =
        (await mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/repo"))) ===
        true;
    });

    expect(accepted).toBe(true);
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledWith(
      "chat-1",
      expect.arrayContaining([expect.objectContaining({ root: "/repo" })]),
    );
    expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(updated);
    expect(mocks.recordReadsContextRelationship).toHaveBeenCalledWith("chat-1", "/repo");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rejects the seventeenth mixed Files/Knowledge source with a visible notice", async () => {
    const connectedScopes = Array.from({ length: 8 }, (_unused, index) =>
      fileScope(`/repo-${String(index)}`, index),
    );
    const localKnowledgeScopes = Array.from({ length: 8 }, (_unused, index) =>
      capsuleScope(`cap-${String(index)}`),
    );
    const cappedChat = chat({ connectedScopes, localKnowledgeScopes });
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      chats: [cappedChat],
      activeChat: cappedChat,
    };
    await renderMounted();

    let accepted = true;
    await act(async () => {
      accepted =
        (await mocks.state.workspaceOptions?.onConnectorBind?.(
          "chat-window",
          capsuleScope("cap-17"),
        )) === true;
    });

    expect(accepted).toBe(false);
    expect(mocks.updateChatLocalKnowledgeScopes).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already has 16 of 16 connected sources",
    );
  });

  it("lets the user dismiss the inline source-limit notice", async () => {
    const connectedScopes = Array.from({ length: 8 }, (_unused, index) =>
      fileScope(`/repo-${String(index)}`, index),
    );
    const localKnowledgeScopes = Array.from({ length: 8 }, (_unused, index) =>
      capsuleScope(`cap-${String(index)}`),
    );
    const cappedChat = chat({ connectedScopes, localKnowledgeScopes });
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      chats: [cappedChat],
      activeChat: cappedChat,
    };
    await renderMounted();

    await act(async () => {
      await mocks.state.workspaceOptions?.onConnectorBind?.("chat-window", capsuleScope("cap-17"));
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("already has 16 of 16 connected sources");

    await act(async () => {
      screen.getByRole("button", { name: "Dismiss source connection notice" }).click();
    });

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("removes connector scopes through the plural local-knowledge patch", async () => {
    const scopeA = capsuleScope("cap-a");
    const scopeB = capsuleScope("cap-b");
    const currentChat = chat({ localKnowledgeScopes: [scopeA, scopeB] });
    const updated = chat({ localKnowledgeScopes: [scopeB] });
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      chats: [currentChat],
      activeChat: currentChat,
    };
    mocks.updateChatLocalKnowledgeScopes.mockResolvedValue({ chat: updated });
    await renderMounted();

    await act(async () => {
      mocks.state.workspaceOptions?.onConnectorUnbind?.("chat-window", scopeA);
      await Promise.resolve();
    });

    expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenCalledWith(
      "chat-1",
      expect.arrayContaining([expect.objectContaining({ capsuleId: "cap-b" })]),
    );
    expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(updated);
  });

  it("keeps the workspace outline closed by default", async () => {
    await renderMounted();

    expect(screen.getByTestId("workspace")).toHaveAttribute("data-outline-open", "false");
    expect(screen.getByTestId("right-rail")).toHaveTextContent("Outline closed");
    expect(mocks.state.workspaceProps?.outlineOpen).toBe(false);
    expect(mocks.state.rightRailProps?.outlineOpen).toBe(false);
  });

  it("opens the workspace outline when the right rail toggles it", async () => {
    await renderMounted();

    await act(async () => {
      screen.getByTestId("right-rail").click();
    });

    expect(screen.getByTestId("workspace")).toHaveAttribute("data-outline-open", "true");
    expect(screen.getByTestId("right-rail")).toHaveTextContent("Outline open");
    expect(mocks.state.workspaceProps?.outlineOpen).toBe(true);
    expect(mocks.state.workspaceProps?.renderOutlineToggle).toBe(false);
    expect(mocks.state.rightRailProps?.outlineOpen).toBe(true);
  });

  it("keeps the right rail as the only product outline toggle surface", async () => {
    await renderMounted();

    expect(mocks.state.workspaceProps?.renderOutlineToggle).toBe(false);
    expect(mocks.state.workspaceProps?.onToggleOutline).toBeTypeOf("function");

    await act(async () => {
      mocks.state.rightRailProps?.onToggleOutline?.();
    });
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-outline-open", "true");

    await act(async () => {
      mocks.state.rightRailProps?.onToggleOutline?.();
    });

    expect(screen.getByTestId("workspace")).toHaveAttribute("data-outline-open", "false");
    expect(screen.getByTestId("right-rail")).toHaveTextContent("Outline closed");
    expect(mocks.state.workspaceProps?.outlineOpen).toBe(false);
    expect(mocks.state.rightRailProps?.outlineOpen).toBe(false);
  });

  it("dispatches undo, redo, and focus-status shortcuts through the shared shell handler", async () => {
    await renderMounted();

    const keyboardProps = mocks.useKeyboardShortcuts.mock.calls[0]?.[0] as
      | { readonly dispatch?: (commandId: string) => void }
      | undefined;
    expect(keyboardProps?.dispatch).toBeTypeOf("function");

    const statusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    keyboardProps?.dispatch?.("undo");
    keyboardProps?.dispatch?.("redo");
    keyboardProps?.dispatch?.("focus-status");

    expect(mocks.undo).toHaveBeenCalledTimes(1);
    expect(mocks.redo).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalled();
    statusSpy.mockRestore();
  });

  it("toggles the command palette from the Cmd/Ctrl+K shell shortcut", async () => {
    await renderMounted();
    expect(screen.queryByTestId("command-palette")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "K", metaKey: true }));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("command-palette")).toBeNull();
    });
  });
});
