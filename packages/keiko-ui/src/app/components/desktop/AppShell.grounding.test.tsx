import type { ReactNode, RefObject } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    workspaceRendered: false,
    rightRailRendered: false,
  },
  fetchConfig: vi.fn(),
  fetchStartupUpdatePreflight: vi.fn(),
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
  fetchStartupUpdatePreflight: mocks.fetchStartupUpdatePreflight,
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
    <button type="button" data-testid="left-rail" onClick={onNewChat}>
      New chat
    </button>
  ),
}));

vi.mock("./RightRail", () => ({
  RightRail: () => {
    mocks.state.rightRailRendered = true;
    return <aside data-testid="right-rail" />;
  },
}));

vi.mock("./Workspace", () => ({
  Workspace: () => {
    mocks.state.workspaceRendered = true;
    return <main data-testid="workspace" />;
  },
}));

vi.mock("./modals/UnifiedQuickAccessPalette", () => ({
  UnifiedQuickAccessPalette: () => <div data-testid="quick-access-palette" />,
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

import { AppShell, openOrFocusSearchWindow } from "./AppShell";

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
    openEditorFile: vi.fn(() => ({ ok: false as const, message: "Unable to open editor." })),
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
    currentView: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    ...patch,
  };
}

function workspaceResult(
  wins: AppWindow[],
  conns: Connection[] = [],
  api: WorkspaceApi = workspaceApi(),
): UseWorkspaceResult {
  return {
    wins,
    winsById: new Map(wins.map((win) => [win.id, win])),
    snapPrev: null,
    palOpen: false,
    setPalOpen: vi.fn(),
    conns,
    connecting: null,
    view: { x: 0, y: 0, zoom: 1 },
    api,
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
    mocks.fetchStartupUpdatePreflight.mockResolvedValue({
      schemaVersion: 1,
      checkedAt: "2026-06-30T12:00:00.000Z",
      currentVersion: "0.2.11",
      targetVersion: "0.2.11",
      updateAvailable: false,
      status: "current",
      availabilityState: "current",
      severity: "none",
      registryStatus: "ok",
      releaseMetadataStatus: "not-needed",
      userActionRequired: false,
      affectedStateStores: [],
      blockers: [],
      manualUpdateRequired: false,
      oneClickEligible: false,
      warnings: [],
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
    mocks.state.workspaceRendered = false;
    mocks.state.rightRailRendered = false;
    document.documentElement.removeAttribute("data-input-modality");
  });

  it("tracks pointer and keyboard modality for focus ring policy", async () => {
    await renderMounted();

    expect(document.documentElement).toHaveAttribute("data-input-modality", "pointer");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    });
    expect(document.documentElement).toHaveAttribute("data-input-modality", "keyboard");

    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousedown"));
    });
    expect(document.documentElement).toHaveAttribute("data-input-modality", "pointer");
  });

  it("does not turn typed text into keyboard-focus modality after a mouse click", async () => {
    await renderMounted();

    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousedown"));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    });

    expect(document.documentElement).toHaveAttribute("data-input-modality", "pointer");
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
    // The app-level announcer mounts a permanent (empty) role="alert" region, so scope the
    // "no notice" assertion to the inline source-limit alert specifically.
    expect(document.querySelector(".source-limit-alert")).toBeNull();
  });

  // GEN-PERF-RENDER-001 — the four scope-bind callbacks passed to useWorkspace depend on the stable
  // `session.replaceChat` slice, not the whole `session` object. So when the session's identity
  // changes (as it does on every draft/streaming state change) but replaceChat stays stable, the
  // callbacks — and therefore the workspace `api` binding — must keep their identity. Pre-fix
  // (dep on the whole `session`) every session change re-created all four callbacks.
  it("keeps scope-bind callback identity stable across a session identity change (replaceChat stable)", async () => {
    await renderMounted();

    const before = mocks.state.workspaceOptions;
    const firstScopeBind = before?.onScopeBind;
    const firstScopeUnbind = before?.onScopeUnbind;
    const firstConnectorBind = before?.onConnectorBind;
    const firstConnectorUnbind = before?.onConnectorUnbind;
    expect(firstScopeBind).toBeDefined();

    // Simulate real session churn: a NEW session object (new identity) sharing the SAME replaceChat.
    const stableReplaceChat = mocks.state.session?.replaceChat;
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      // A field that changes on every keystroke in the real hook; only its identity matters here.
      error: "typing…",
      replaceChat: stableReplaceChat as (chat: Chat) => void,
    };

    // Force AppShell to re-render (and re-read useChatSession) via a modality state change.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    });

    const after = mocks.state.workspaceOptions;
    // Callback identities are unchanged despite the session object identity changing.
    expect(after?.onScopeBind).toBe(firstScopeBind);
    expect(after?.onScopeUnbind).toBe(firstScopeUnbind);
    expect(after?.onConnectorBind).toBe(firstConnectorBind);
    expect(after?.onConnectorUnbind).toBe(firstConnectorUnbind);
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
    // Scope to the inline source-limit alert (the always-mounted announcer also carries role="alert").
    const notice = await screen.findByText(/already has 16 of 16 connected sources/u);
    expect(notice.closest(".source-limit-alert")).toHaveAttribute("role", "alert");
  });

  it("lets the user dismiss the inline source-limit notice", async () => {
    const user = userEvent.setup();
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

    const notice = await screen.findByText(/already has 16 of 16 connected sources/u);
    expect(notice.closest(".source-limit-alert")).toHaveAttribute("role", "alert");

    await user.click(screen.getByRole("button", { name: "Dismiss source connection notice" }));

    await waitFor(() => {
      expect(document.querySelector(".source-limit-alert")).toBeNull();
    });
  });

  it("lets the user dismiss the missing-ready-chat source connection notice", async () => {
    const user = userEvent.setup();
    const closedChat = chat({ status: "closed" });
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      chats: [closedChat],
      activeChat: closedChat,
    };
    await renderMounted();

    let accepted = true;
    await act(async () => {
      accepted =
        (await mocks.state.workspaceOptions?.onConnectorBind?.(
          "chat-window",
          capsuleScope("cap-ready"),
        )) === true;
    });

    expect(accepted).toBe(false);
    const notice = await screen.findByText("Open a ready chat window before connecting a source.");
    expect(notice.closest(".source-limit-alert")).toHaveAttribute("role", "alert");

    await user.click(screen.getByRole("button", { name: "Dismiss source connection notice" }));

    await waitFor(() => {
      expect(document.querySelector(".source-limit-alert")).toBeNull();
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

  it("hides both side rails while the first-run gateway setup is open", async () => {
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      models: [],
      noEligibleModels: true,
      selectedModel: "",
    };

    await renderMounted();

    expect(screen.getByRole("dialog", { name: "Gateway setup" })).toBeInTheDocument();
    expect(screen.queryByTestId("left-rail")).toBeNull();
    expect(screen.queryByTestId("right-rail")).toBeNull();
  });

  it("dispatches undo, redo, focus-status, and search shortcuts through the shell handler", async () => {
    const api = workspaceApi();
    mocks.state.workspaceResult = workspaceResult([], [], api);
    await renderMounted();

    const keyboardProps = mocks.useKeyboardShortcuts.mock.calls[0]?.[0] as
      { readonly dispatch?: (commandId: string) => void } | undefined;
    expect(keyboardProps?.dispatch).toBeTypeOf("function");

    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    const statusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    keyboardProps?.dispatch?.("undo");
    keyboardProps?.dispatch?.("redo");
    keyboardProps?.dispatch?.("focus-status");
    keyboardProps?.dispatch?.("focus-workspace-search");

    expect(mocks.undo).toHaveBeenCalledTimes(1);
    expect(mocks.redo).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalled();
    expect(api.toggleTool).toHaveBeenCalledWith("search");
    statusSpy.mockRestore();
    rafSpy.mockRestore();
  });

  it("focuses or restores an existing Search window without toggling it closed", () => {
    const api = workspaceApi();
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });

    openOrFocusSearchWindow(api, [win("search", {}, "search")]);
    openOrFocusSearchWindow(api, [{ ...win("search", {}, "search-min"), minimized: true }]);

    expect(api.focus).toHaveBeenCalledWith("search");
    expect(api.restore).toHaveBeenCalledWith("search-min");
    expect(api.toggleTool).not.toHaveBeenCalled();
    rafSpy.mockRestore();
  });

  it("does not open the command palette from the Cmd/Ctrl+K shell shortcut in this release", async () => {
    await renderMounted();
    expect(screen.queryByTestId("quick-access-palette")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    expect(screen.queryByTestId("quick-access-palette")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "K", metaKey: true }));
    });
    expect(screen.queryByTestId("quick-access-palette")).toBeNull();
  });

  it("opens unified quick access from the Cmd/Ctrl+P shell shortcut", async () => {
    await renderMounted();
    expect(screen.queryByTestId("quick-access-palette")).toBeNull();

    const keyboardProps = mocks.useKeyboardShortcuts.mock.calls[0]?.[0] as
      { readonly dispatch?: (commandId: string) => void } | undefined;
    await act(async () => {
      keyboardProps?.dispatch?.("quick-access.files");
    });

    expect(screen.getByTestId("quick-access-palette")).toBeInTheDocument();
  });

  // GEN-UI-A11Y-004 — the shell always mounts one app-level status live-region pair (polite +
  // assertive) so any surface can post an outcome for AT, even after its originating surface unmounts.
  it("always mounts the app-level polite status and assertive alert live regions", async () => {
    await renderMounted();

    const polite = document.querySelector('[role="status"][aria-live="polite"]');
    expect(polite).not.toBeNull();
    expect(polite).toHaveAttribute("aria-atomic", "true");

    const assertive = document.querySelector('[role="alert"][aria-live="assertive"]');
    expect(assertive).not.toBeNull();
    expect(assertive).toHaveAttribute("aria-atomic", "true");
  });

  // GEN-UI-A11Y-003 — the background window layer (`#main` / `.stage`) is NOT inert while no modal is
  // open, and becomes inert + aria-hidden while a modal dialog (here: first-run gateway setup) is open.
  it("does not inert the window layer while no modal dialog is open", async () => {
    await renderMounted();

    const stage = document.getElementById("main");
    expect(stage).not.toBeNull();
    expect(stage?.hasAttribute("inert")).toBe(false);
    expect(stage?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("inerts and aria-hides the window layer while the gateway-setup modal is open", async () => {
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      models: [],
      noEligibleModels: true,
      selectedModel: "",
    };

    await renderMounted();

    expect(screen.getByRole("dialog", { name: "Gateway setup" })).toBeInTheDocument();
    const stage = document.getElementById("main");
    expect(stage).not.toBeNull();
    expect(stage?.hasAttribute("inert")).toBe(true);
    expect(stage).toHaveAttribute("aria-hidden", "true");
  });
});
