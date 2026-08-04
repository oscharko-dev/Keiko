import type { ReactElement, ReactNode, RefObject } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GROUNDING_LIMITS } from "@/lib/types";
import type {
  Chat,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  GroundingLimits,
} from "@/lib/types";
import type { UseWorkspaceResult, WorkspaceApi } from "./hooks/useWorkspace.types";
import type { AppWindow, Connection } from "./windows/types";
import appShellStyles from "./AppShell.module.css";

interface WorkspaceHookOptions {
  readonly onScopeBind?: (
    chatWindowId: string,
    scope: ChatConnectedScope,
    target?: ChatBindingTarget,
  ) => boolean | Promise<boolean>;
  readonly onScopeUnbind?: (chatWindowId: string, scope: ChatConnectedScope) => void;
  readonly onConnectorBind?: (
    chatWindowId: string,
    scope: ChatLocalKnowledgeScope,
    target?: ChatBindingTarget,
  ) => boolean | Promise<boolean>;
  readonly onConnectorUnbind?: (chatWindowId: string, scope: ChatLocalKnowledgeScope) => void;
}

interface ChatBindingTarget {
  readonly conversationId: string | undefined;
  readonly isCurrent: () => boolean;
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
    rightRailOnTool: undefined as ((id: string) => void) | undefined,
  },
  fetchConfig: vi.fn(),
  fetchStartupUpdatePreflight: vi.fn(),
  updateChatConnectedScopes: vi.fn(),
  updateChatLocalKnowledgeScopes: vi.fn(),
  recordReadsContextRelationship: vi.fn(),
  registerSw: vi.fn(),
  gatewaySetupDialogModuleLoaded: vi.fn(),
  newWindowDialogModuleLoaded: vi.fn(),
  paletteModuleLoaded: vi.fn(),
  updateStartupNoticeModuleLoaded: vi.fn(),
  useKeyboardShortcuts: vi.fn(),
  pushUndo: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  dialogShowModal: vi.fn(function dialogShowModal(this: HTMLDialogElement): void {
    if (this.open) throw new DOMException("The dialog is already open.", "InvalidStateError");
    this.setAttribute("open", "");
  }),
  dialogClose: vi.fn(function dialogClose(this: HTMLDialogElement): void {
    this.removeAttribute("open");
  }),
}));

let originalDialogShowModal: PropertyDescriptor | undefined;
let originalDialogClose: PropertyDescriptor | undefined;

function appShellCssClass(name: keyof typeof appShellStyles): string {
  const value = appShellStyles[name];
  if (value === undefined) throw new Error(`missing AppShell CSS module class ${name}`);
  return value;
}

function installDialogMethod(
  name: "showModal" | "close",
  method: () => void,
): PropertyDescriptor | undefined {
  const previous = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name);
  Object.defineProperty(HTMLDialogElement.prototype, name, {
    configurable: true,
    writable: true,
    value: method,
  });
  return previous;
}

function restoreDialogMethod(
  name: "showModal" | "close",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    return;
  }
  Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
}

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
    push: mocks.pushUndo,
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
  RightRail: ({ onTool }: { readonly onTool: (id: string) => void }): ReactElement => {
    mocks.state.rightRailRendered = true;
    mocks.state.rightRailOnTool = onTool;
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

vi.mock("./modals/GatewaySetupDialog", () => {
  mocks.gatewaySetupDialogModuleLoaded();
  return { GatewaySetupDialog: () => <div role="dialog" aria-label="Gateway setup" /> };
});

vi.mock("./modals/NewWindowDialog", () => {
  mocks.newWindowDialogModuleLoaded();
  return {
    NewWindowDialog: ({
      onConfirm,
    }: {
      readonly onConfirm: (cfg: Record<string, string>) => void;
    }): ReactNode => (
      <div role="dialog" aria-label="New window">
        <button
          type="button"
          onClick={(): void => onConfirm({ title: "Release grounding review" })}
        >
          Confirm new chat
        </button>
      </div>
    ),
  };
});

vi.mock("./modals/Palette", () => {
  mocks.paletteModuleLoaded();
  return { Palette: () => <div role="dialog" aria-label="Palette" /> };
});

vi.mock("./update/UpdateStartupNotice", () => {
  mocks.updateStartupNoticeModuleLoaded();
  return { UpdateStartupNotice: () => <div data-testid="update-startup-notice" /> };
});

vi.mock("./widgets", () => ({}));

import {
  AppShell,
  CHAT_MUTATION_TIMEOUT_MS,
  frontmostSearchRootOwner,
  GatewaySetupLoading,
  openOrFocusSearchWindow,
  resolveSearchRoot,
} from "./AppShell";

const gatewaySetupLoadsAtShellImport = mocks.gatewaySetupDialogModuleLoaded.mock.calls.length;
// Issue #1207 (ADR-0042 D3.6) — first-load isolation for the shell's gesture-only surfaces. Each of
// these modules is reached through `next/dynamic(..., { ssr: false })`, so importing AppShell must
// not evaluate any of them; a static import would run the mock factory here and make this non-zero.
const gestureOnlyShellModuleLoadsAtImport = {
  newWindowDialog: mocks.newWindowDialogModuleLoaded.mock.calls.length,
  palette: mocks.paletteModuleLoaded.mock.calls.length,
  updateStartupNotice: mocks.updateStartupNoticeModuleLoaded.mock.calls.length,
};

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
    currentSelection: vi.fn(() => ({ focusedWindowId: null, selectedWindowIds: [] })),
    replaceSelection: vi.fn(),
    toggleWindowSelection: vi.fn(),
    clearSelection: vi.fn(),
    moveSelectedWindowsBy: vi.fn(() => ({ dx: 0, dy: 0 })),
    copySelectedWindows: vi.fn(() => false),
    pasteCopiedWindows: vi.fn(() => false),
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
    selection: { focusedWindowId: null, selectedWindowIds: [] },
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

function reportedError(value: unknown, failureMessage: string): Error {
  expect(value).toBeInstanceOf(Error);
  if (!(value instanceof Error)) {
    throw new TypeError(failureMessage);
  }
  return value;
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

async function renderMounted(): Promise<void> {
  render(<AppShell />);
  await screen.findByTestId("workspace");
  await waitFor(() => expect(mocks.state.workspaceOptions).toBeDefined());
}

describe("AppShell grounding connections", () => {
  beforeAll((): void => {
    originalDialogShowModal = installDialogMethod("showModal", mocks.dialogShowModal);
    originalDialogClose = installDialogMethod("close", mocks.dialogClose);
  });

  afterAll((): void => {
    restoreDialogMethod("showModal", originalDialogShowModal);
    restoreDialogMethod("close", originalDialogClose);
  });

  afterEach((): void => {
    delete document.documentElement.dataset.keikoModalOpen;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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
    mocks.state.rightRailOnTool = undefined;
    document.documentElement.removeAttribute("data-input-modality");
  });

  it("does not load the gateway setup implementation during ordinary shell startup", async () => {
    expect(gatewaySetupLoadsAtShellImport).toBe(0);

    await renderMounted();

    expect(mocks.gatewaySetupDialogModuleLoaded).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Gateway setup" })).toBeNull();
  });

  // Issue #1207 (ADR-0042 D3.6) — the static-export first-load gzip ceiling is enforced by
  // `npm run check:editor-bundle-size -- --require-static-export`, which needs a real production
  // build. This is the cheap unit-level guard for the same contract: the new-window dialog, the
  // window-launcher palette and the startup update notice are gesture-only surfaces, so neither
  // importing AppShell nor an ordinary startup render may evaluate their modules. Restoring a
  // static import for any of them makes its factory run at import time and fails this test.
  it("does not load the gesture-only shell surfaces during ordinary shell startup", async () => {
    expect(gestureOnlyShellModuleLoadsAtImport).toStrictEqual({
      newWindowDialog: 0,
      palette: 0,
      updateStartupNotice: 0,
    });

    await renderMounted();

    expect(mocks.newWindowDialogModuleLoaded).not.toHaveBeenCalled();
    expect(mocks.paletteModuleLoaded).not.toHaveBeenCalled();
    expect(mocks.updateStartupNoticeModuleLoaded).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "New window" })).toBeNull();
  });

  it("opens a deep-linked singleton when the route has trailing slashes", async () => {
    const api = workspaceApi();
    mocks.state.workspaceResult = workspaceResult([], [], api);
    const previousUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    try {
      window.history.replaceState(null, "", "/relationships///");

      await renderMounted();

      expect(api.toggleTool).toHaveBeenCalledWith("relationships");
      expect(window.location.pathname).toBe("/");
    } finally {
      window.history.replaceState(null, "", previousUrl);
    }
  });

  it("clears the existing singleton binding when the user confirms a new chat", async (): Promise<void> => {
    const add = vi.fn<WorkspaceApi["add"]>((): string => "chat-window");
    const api = workspaceApi({ add });
    mocks.state.workspaceResult = workspaceResult(
      [win("chat", { chatId: "chat-1", title: "Release chat" }, "chat-window")],
      [],
      api,
    );
    const user = userEvent.setup();
    await renderMounted();

    await user.click(screen.getByTestId("left-rail"));
    // The dialog resolves through `next/dynamic(..., { ssr: false })` (first-load isolation), so it
    // arrives on the microtask after the gesture rather than in the same render.
    await user.click(await screen.findByRole("button", { name: "Confirm new chat" }));

    expect(add).toHaveBeenCalledOnce();
    expect(add.mock.calls[0]?.[0]).toBe("chat");
    const newChatCfg = add.mock.calls[0]?.[1];
    expect(newChatCfg).toStrictEqual({
      title: "Release grounding review",
      chatId: undefined,
      selectionHandoffId: undefined,
      newChatRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(Object.hasOwn(newChatCfg ?? {}, "chatId")).toBe(true);
    expect(Object.hasOwn(newChatCfg ?? {}, "selectionHandoffId")).toBe(true);
  });

  it("drops retained edges without unbinding when a chat window changes conversation", async (): Promise<void> => {
    const api = workspaceApi();
    const files = win("files", { root: "/repo" }, "files-window");
    const connector = win(
      "connector",
      { selectedKind: "capsule", selectedId: "cap-1" },
      "connector-window",
    );
    const browser = win("browser", {}, "browser-window");
    const connections: Connection[] = [
      { id: "files-chat", a: "files-window", b: "chat-window" },
      { id: "connector-chat", a: "connector-window", b: "chat-window" },
      { id: "browser-chat", a: "browser-window", b: "chat-window" },
    ];
    const oldChat = chat({ id: "chat-old", connectedScopes: [fileScope("/repo")] });
    const newChat = chat({ id: "chat-new", connectedScopes: [] });
    const session = mocks.state.session;
    if (session === undefined) throw new Error("missing test session");
    mocks.state.session = { ...session, activeChat: oldChat, chats: [oldChat, newChat] };
    mocks.state.workspaceResult = workspaceResult(
      [win("chat", { chatId: "chat-old" }, "chat-window"), files, connector, browser],
      connections,
      api,
    );
    const view = render(<AppShell />);
    await screen.findByTestId("workspace");
    await waitFor((): void => expect(api.updateConnBoundScope).toHaveBeenCalledOnce());
    vi.mocked(api.updateConnBoundScope).mockClear();
    mocks.updateChatConnectedScopes.mockClear();

    mocks.state.workspaceResult = workspaceResult(
      [win("chat", { chatId: "chat-new" }, "chat-window"), files, connector, browser],
      connections,
      api,
    );
    view.rerender(<AppShell />);

    await waitFor((): void => expect(api.removeConn).toHaveBeenCalledTimes(2));
    expect(api.removeConn).toHaveBeenCalledWith("files-chat", { unbind: false });
    expect(api.removeConn).toHaveBeenCalledWith("connector-chat", { unbind: false });
    expect(api.removeConn).not.toHaveBeenCalledWith("browser-chat", expect.anything());
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(api.updateConnBoundScope).not.toHaveBeenCalled();
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

  it("reports a redacted diagnostic when grounding persistence fails", async (): Promise<void> => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    mocks.updateChatConnectedScopes.mockRejectedValueOnce(
      new Error("customer endpoint and response detail"),
    );
    await renderMounted();

    await expect(
      mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/repo")),
    ).resolves.toBe(false);

    expect(await screen.findByText(/Keiko could not connect that source/u)).toBeInTheDocument();
    const reported = reportedError(
      reportError.mock.calls[0]?.[0],
      "Expected grounding diagnostics to report an Error.",
    );
    expect(reported.message).toMatch(
      /^Chat grounding mutation failed\. Correlation ID: [A-Za-z0-9._-]{8,128}$/u,
    );
    expect(reported.message).not.toContain("customer endpoint");
  });

  it("reports a redacted diagnostic when connector persistence fails", async (): Promise<void> => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    mocks.updateChatLocalKnowledgeScopes.mockRejectedValueOnce(
      new Error("customer connector endpoint and response detail"),
    );
    await renderMounted();

    await expect(
      mocks.state.workspaceOptions?.onConnectorBind?.("chat-window", capsuleScope("cap-sensitive")),
    ).resolves.toBe(false);

    expect(
      await screen.findByText(/Keiko could not connect that knowledge source/u),
    ).toBeInTheDocument();
    const reported = reportedError(
      reportError.mock.calls[0]?.[0],
      "Expected connector diagnostics to report an Error.",
    );
    expect(reported.message).toMatch(
      /^Chat grounding mutation failed\. Correlation ID: [A-Za-z0-9._-]{8,128}$/u,
    );
    expect(reported.message).not.toContain("customer connector endpoint");
  });

  it("compensates a Files bind when its chat ownership changes in flight", async (): Promise<void> => {
    const persisted = deferred<{ readonly chat: Chat }>();
    const compensation = deferred<{ readonly chat: Chat }>();
    const updated = chat({ connectedScopes: [fileScope("/repo")] });
    const restored = chat({ connectedScopes: [] });
    const concurrent = chat({ connectedScopes: [fileScope("/other")] });
    mocks.updateChatConnectedScopes
      .mockReturnValueOnce(persisted.promise)
      .mockReturnValueOnce(compensation.promise)
      .mockResolvedValueOnce({ chat: concurrent });
    await renderMounted();
    let current = true;
    const target: ChatBindingTarget = {
      conversationId: "chat-1",
      isCurrent: (): boolean => current,
    };

    const binding = Promise.resolve(
      mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/repo"), target),
    );
    await waitFor((): void => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce());
    const concurrentBinding = Promise.resolve(
      mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/other")),
    );
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce();
    current = false;
    persisted.resolve({ chat: updated });

    await waitFor((): void => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2));
    expect(mocks.updateChatConnectedScopes).toHaveBeenNthCalledWith(2, "chat-1", null);
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
    compensation.resolve({ chat: restored });
    await expect(binding).resolves.toBe(false);
    await expect(concurrentBinding).resolves.toBe(true);
    expect(mocks.updateChatConnectedScopes).toHaveBeenNthCalledWith(
      3,
      "chat-1",
      expect.arrayContaining([expect.objectContaining({ root: "/other" })]),
    );
    expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(concurrent);
    expect(mocks.recordReadsContextRelationship).not.toHaveBeenCalledWith("chat-1", "/repo");
    expect(mocks.recordReadsContextRelationship).toHaveBeenCalledWith("chat-1", "/other");
  });

  it("rejects an already-stale binding target before either persistence API runs", async (): Promise<void> => {
    await renderMounted();
    const target: ChatBindingTarget = {
      conversationId: "chat-1",
      isCurrent: (): boolean => false,
    };

    const [filesAccepted, connectorAccepted] = await Promise.all([
      mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/repo"), target),
      mocks.state.workspaceOptions?.onConnectorBind?.(
        "chat-window",
        capsuleScope("cap-stale"),
        target,
      ),
    ]);

    expect(filesAccepted).toBe(false);
    expect(connectorAccepted).toBe(false);
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(mocks.updateChatLocalKnowledgeScopes).not.toHaveBeenCalled();
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalled();
  });

  it("derives a queued bind from the latest confirmed grounding state", async (): Promise<void> => {
    const firstPersist = deferred<{ readonly chat: Chat }>();
    const firstScope = fileScope("/first");
    const secondScope = fileScope("/second");
    const firstChat = chat({ connectedScopes: [firstScope], updatedAt: 2 });
    const secondChat = chat({ connectedScopes: [firstScope, secondScope], updatedAt: 3 });
    mocks.updateChatConnectedScopes
      .mockReturnValueOnce(firstPersist.promise)
      .mockResolvedValueOnce({ chat: secondChat });
    await renderMounted();

    const firstBinding = Promise.resolve(
      mocks.state.workspaceOptions?.onScopeBind?.("chat-window", firstScope),
    );
    await waitFor((): void => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce());
    const secondBinding = Promise.resolve(
      mocks.state.workspaceOptions?.onScopeBind?.("chat-window", secondScope),
    );
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce();
    firstPersist.resolve({ chat: firstChat });

    await expect(firstBinding).resolves.toBe(true);
    await expect(secondBinding).resolves.toBe(true);
    expect(mocks.updateChatConnectedScopes).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      expect.arrayContaining([
        expect.objectContaining({ root: "/first" }),
        expect.objectContaining({ root: "/second" }),
      ]),
    );
  });

  it("compensates a timed-out bind and blocks later mutations", async (): Promise<void> => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const persisted = deferred<{ readonly chat: Chat }>();
    const nextScope = fileScope("/late");
    const updated = chat({ connectedScopes: [nextScope], updatedAt: 2 });
    const restored = chat({ connectedScopes: [], updatedAt: 3 });
    mocks.updateChatConnectedScopes
      .mockReturnValueOnce(persisted.promise)
      .mockResolvedValueOnce({ chat: restored });
    await renderMounted();
    vi.useFakeTimers();

    const binding = Promise.resolve(
      mocks.state.workspaceOptions?.onScopeBind?.("chat-window", nextScope),
    );
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);

    await expect(binding).resolves.toBe(false);
    await expect(
      mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/blocked")),
    ).resolves.toBe(false);
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce();

    await act(async (): Promise<void> => {
      persisted.resolve({ chat: updated });
      await persisted.promise;
    });

    expect(mocks.updateChatConnectedScopes).toHaveBeenNthCalledWith(2, "chat-1", null);
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalledWith(updated);
    expect(mocks.recordReadsContextRelationship).not.toHaveBeenCalledWith("chat-1", "/late");
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("surfaces a distinct diagnostic when stale-bind compensation fails", async (): Promise<void> => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const persisted = deferred<{ readonly chat: Chat }>();
    mocks.updateChatConnectedScopes
      .mockReturnValueOnce(persisted.promise)
      .mockRejectedValueOnce(new Error("customer-compensation-detail"));
    await renderMounted();
    let current = true;
    const target: ChatBindingTarget = {
      conversationId: "chat-1",
      isCurrent: (): boolean => current,
    };

    const binding = Promise.resolve(
      mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/repo"), target),
    );
    await waitFor((): void => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce());
    current = false;
    persisted.resolve({ chat: chat({ connectedScopes: [fileScope("/repo")] }) });

    await expect(binding).resolves.toBe(false);
    expect(await screen.findByText(/Chat grounding recovery failed/u)).toBeInTheDocument();
    const reported = reportedError(
      reportError.mock.calls[0]?.[0],
      "Expected compensation diagnostics to report an Error.",
    );
    expect(reported.message).toMatch(
      /^Chat binding compensation failed\. Correlation ID: [A-Za-z0-9._-]{8,128}$/,
    );
    expect(reported.message).not.toContain("customer-compensation-detail");
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

  it("compensates a connector bind when its chat ownership changes in flight", async (): Promise<void> => {
    const persisted = deferred<{ readonly chat: Chat }>();
    const updated = chat({ localKnowledgeScopes: [capsuleScope("cap-stale")] });
    const restored = chat({ localKnowledgeScopes: [] });
    mocks.updateChatLocalKnowledgeScopes
      .mockReturnValueOnce(persisted.promise)
      .mockResolvedValueOnce({ chat: restored });
    await renderMounted();
    let current = true;
    const target: ChatBindingTarget = {
      conversationId: "chat-1",
      isCurrent: (): boolean => current,
    };

    const binding = Promise.resolve(
      mocks.state.workspaceOptions?.onConnectorBind?.(
        "chat-window",
        capsuleScope("cap-stale"),
        target,
      ),
    );
    await waitFor((): void => expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenCalledOnce());
    current = false;
    persisted.resolve({ chat: updated });

    await expect(binding).resolves.toBe(false);
    expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenNthCalledWith(2, "chat-1", null);
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalled();
  });

  // The `next/dynamic` loadable for GatewaySetupDialog is created once when AppShell is imported and
  // caches its resolved payload for the rest of the worker's life — neither `cleanup()` nor
  // `vi.clearAllMocks()` puts it back into its pending state. The transient loading placeholder
  // asserted below therefore only exists while that payload is still unresolved, which is a
  // precondition this test must establish itself: relying on being declared before the other test
  // that mounts the same dialog made the assertion pass on declaration order alone, and it
  // disappeared under `--sequence.shuffle.tests` (#2871). Re-importing AppShell from a fresh module
  // registry hands this test its own loadable, still pending on first render.
  it("hides both side rails while the first-run gateway setup is open", async () => {
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      models: [],
      noEligibleModels: true,
      selectedModel: "",
    };
    vi.resetModules();
    const { AppShell: FirstRunAppShell } = await import("./AppShell");

    render(<FirstRunAppShell />);
    const loadingDialog = screen.getByRole("dialog", {
      name: "Preparing model gateway setup",
    });
    expect(loadingDialog).toHaveFocus();
    expect(within(loadingDialog).getByRole("status")).toHaveTextContent("Loading...");
    await screen.findByRole("dialog", { name: "Gateway setup" });

    expect(screen.getByRole("dialog", { name: "Gateway setup" })).toBeInTheDocument();
    expect(screen.queryByTestId("left-rail")).toBeNull();
    expect(screen.queryByTestId("right-rail")).toBeNull();
  });

  it("keeps a redacted retry surface available when gateway setup loading fails", async (): Promise<void> => {
    const retry = vi.fn();
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    const { container, unmount } = render(
      <GatewaySetupLoading error={new Error("credential=must-not-render")} retry={retry} />,
    );

    const dialog = screen.getByRole("dialog", { name: "Preparing model gateway setup" });
    expect(dialog.tagName).toBe("DIALOG");
    expect(mocks.dialogShowModal).toHaveBeenCalledOnce();
    expect(mocks.dialogShowModal.mock.contexts[0]).toBe(dialog);
    expect(dialog).toHaveAttribute("open");
    expect(dialog).not.toHaveAttribute("role");
    expect(dialog.parentElement).toHaveClass("gw-setup-backdrop");
    expect(dialog.parentElement).not.toHaveAttribute("role");
    expect(dialog).toHaveClass("gw-setup", appShellCssClass("gatewaySetupDialog"));
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveFocus();
    const showModalOrder = mocks.dialogShowModal.mock.invocationCallOrder[0];
    const focusOrder = focusSpy.mock.invocationCallOrder[0];
    expect(showModalOrder).toBeDefined();
    expect(focusOrder).toBeDefined();
    if (showModalOrder === undefined || focusOrder === undefined) {
      throw new Error("expected modal activation and focus calls");
    }
    expect(showModalOrder).toBeLessThan(focusOrder);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "The setup controls could not be loaded.",
    );
    expect(screen.queryByText(/must-not-render/u)).toBeNull();

    const cancelEvent = new Event("cancel", { cancelable: true });
    expect(dialog.dispatchEvent(cancelEvent)).toBe(false);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(dialog).toHaveAttribute("open");
    expect(mocks.dialogClose).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(await axe(container)).toHaveNoViolations();

    unmount();
    expect(mocks.dialogClose).toHaveBeenCalledOnce();
    expect(mocks.dialogClose.mock.contexts[0]).toBe(dialog);
    expect(dialog).not.toHaveAttribute("open");
  });

  it("dispatches undo, redo, focus-status, and search shortcuts through the shell handler", async () => {
    const api = workspaceApi();
    mocks.state.workspaceResult = workspaceResult(
      [
        win("search", { root: "/repo/stale-chat" }, "search-window"),
        { ...win("editor", { root: "/repo/editor-selected" }, "editor-window"), z: 2 },
      ],
      [],
      api,
    );
    await renderMounted();

    const keyboardProps = mocks.useKeyboardShortcuts.mock.calls[0]?.[0] as
      { readonly dispatch?: (commandId: string) => void } | undefined;
    expect(keyboardProps?.dispatch).toBeTypeOf("function");

    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback): number => {
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
    expect(api.add).toHaveBeenCalledWith("search", { root: "/repo/editor-selected" });
    expect(api.toggleTool).not.toHaveBeenCalledWith("search");
    statusSpy.mockRestore();
    rafSpy.mockRestore();
  });

  it("records a rooted minimized Search restore as a closed-to-open transition", async (): Promise<void> => {
    const api = workspaceApi();
    mocks.state.workspaceResult = workspaceResult(
      [
        { ...win("search", { root: "/repo/stale" }, "search-window"), minimized: true },
        { ...win("editor", { root: "/repo/editor-selected" }, "editor-window"), z: 2 },
      ],
      [],
      api,
    );
    await renderMounted();
    expect(mocks.state.rightRailOnTool).toBeTypeOf("function");
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((): number => 0);
    vi.mocked(api.add).mockClear();
    mocks.pushUndo.mockClear();

    await act(async (): Promise<void> => {
      mocks.state.rightRailOnTool?.("search");
    });

    expect(api.add).toHaveBeenCalledWith("search", { root: "/repo/editor-selected" });
    expect(mocks.pushUndo).toHaveBeenCalledWith({
      kind: "ui.panel.toggle",
      panel: "search",
      before: false,
      after: true,
      searchRoot: "/repo/editor-selected",
    });
    rafSpy.mockRestore();
  });

  // Issue #2723 — the connected-scope rebind scan (chatWindowIdOf via useEffect) must reach its
  // per-connection body at least once; when neither endpoint is a chat window and no bind-time
  // snapshot exists, chatWindowIdOf returns null and the scan skips the connection entirely.
  it("skips the connected-scope rebind scan when neither endpoint of a connection is a chat window", async () => {
    const api = workspaceApi();
    const filesA = win("files", {}, "files-a");
    const filesB = win("files", {}, "files-b");
    mocks.state.workspaceResult = workspaceResult(
      [filesA, filesB],
      [{ id: "conn-1", a: "files-a", b: "files-b" }],
      api,
    );
    await renderMounted();

    expect(api.updateConnBoundScope).not.toHaveBeenCalled();
  });

  it("opens or focuses Search with an explicit root and clears it when ownership is unavailable", (): void => {
    const api = workspaceApi();
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });

    openOrFocusSearchWindow(api, "/repo/editor-selected");
    openOrFocusSearchWindow(api, undefined);

    expect(api.add).toHaveBeenNthCalledWith(1, "search", { root: "/repo/editor-selected" });
    expect(api.add).toHaveBeenNthCalledWith(2, "search", { root: undefined });
    expect(api.toggleTool).not.toHaveBeenCalled();
    rafSpy.mockRestore();
  });

  it("resolves only explicit active-workspace, Editor, Files, Search, or Git root ownership", (): void => {
    expect(resolveSearchRoot("/task/worktree", win("editor", { root: "/repo/editor" }))).toBe(
      "/task/worktree",
    );
    expect(resolveSearchRoot(null, win("editor", { root: "/repo/editor" }))).toBe("/repo/editor");
    expect(resolveSearchRoot(null, win("files", { root: "/repo/files" }))).toBe("/repo/files");
    expect(
      resolveSearchRoot(
        null,
        win("files", { root: "/repo/configured", resolvedRoot: "/repo/current" }),
      ),
    ).toBe("/repo/current");
    expect(resolveSearchRoot(null, win("search", { root: "/repo/search" }))).toBe("/repo/search");
    expect(resolveSearchRoot(null, win("governedGit", { projectPath: "/repo/git" }))).toBe(
      "/repo/git",
    );
    expect(resolveSearchRoot(null, win("chat", { projectPath: "/repo/chat" }))).toBeUndefined();
  });

  it("rejects missing, non-string, empty, and whitespace-only persisted roots", (): void => {
    expect(resolveSearchRoot(null, win("editor"))).toBeUndefined();
    expect(resolveSearchRoot(null, win("editor", { root: 42 }))).toBeUndefined();
    expect(resolveSearchRoot(null, win("files", { root: "" }))).toBeUndefined();
    expect(resolveSearchRoot(null, win("search", { root: "   " }))).toBeUndefined();
  });

  it("uses the frontmost eligible root owner beneath an unrelated top window", (): void => {
    const editor = { ...win("editor", { root: "/repo/editor" }), z: 4 };
    const files = { ...win("files", { root: "/repo/files" }), z: 6 };
    const chatWindow = { ...win("chat", { projectPath: "/repo/chat" }), z: 9 };

    expect(frontmostSearchRootOwner([editor, files, chatWindow])).toBe(files);
    expect(resolveSearchRoot(null, frontmostSearchRootOwner([editor, files, chatWindow]))).toBe(
      "/repo/files",
    );
  });

  it("returns no root owner when the window collection is absent", (): void => {
    expect(frontmostSearchRootOwner(null)).toBeNull();
  });

  it("skips minimized otherwise-eligible root owners", (): void => {
    const editor = { ...win("editor", { root: "/repo/editor" }), z: 4 };
    const minimizedFiles = {
      ...win("files", { resolvedRoot: "/repo/files" }),
      minimized: true,
      z: 9,
    };

    expect(frontmostSearchRootOwner([editor, minimizedFiles])).toBe(editor);
    expect(frontmostSearchRootOwner([minimizedFiles])).toBeNull();
  });

  it("fails closed when Git carries conflicting current and legacy roots", (): void => {
    expect(
      resolveSearchRoot(
        null,
        win("governedGit", {
          projectPath: "/repo/current",
          workspaceRoot: "/repo/legacy",
        }),
      ),
    ).toBeUndefined();
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

  it("keeps shell shortcuts inert while a governed modal owns interaction", async () => {
    await renderMounted();
    const keyboardProps = mocks.useKeyboardShortcuts.mock.calls[0]?.[0] as
      { readonly dispatch?: (commandId: string) => void } | undefined;
    document.documentElement.dataset.keikoModalOpen = "true";

    await act(async () => {
      keyboardProps?.dispatch?.("quick-access.files");
    });

    expect(screen.queryByTestId("quick-access-palette")).toBeNull();
    delete document.documentElement.dataset.keikoModalOpen;
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

  // GEN-UI-A11Y-003 — the complete background shell is available while no modal is open and becomes
  // inert + aria-hidden while a modal dialog (here: first-run gateway setup) owns interaction.
  it("does not inert the background shell while no modal dialog is open", async () => {
    await renderMounted();

    const background = document.querySelector(".app");
    expect(background).not.toBeNull();
    expect(background?.hasAttribute("inert")).toBe(false);
    expect(background?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("inerts and aria-hides the complete shell behind the gateway-setup modal", async () => {
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      models: [],
      noEligibleModels: true,
      selectedModel: "",
    };

    await renderMounted();

    const dialog = screen.getByRole("dialog", { name: "Gateway setup" });
    const background = document.querySelector(".app");
    expect(background).not.toBeNull();
    expect(background?.hasAttribute("inert")).toBe(true);
    expect(background).toHaveAttribute("aria-hidden", "true");
    expect(background).toContainElement(document.querySelector("header"));
    expect(background).toContainElement(document.querySelector("footer"));
    expect(background).not.toContainElement(dialog);
  });
});
