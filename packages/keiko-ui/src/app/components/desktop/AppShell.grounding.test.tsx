import type { ReactElement, ReactNode, RefObject } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { DEFAULT_GROUNDING_LIMITS } from "@/lib/types";
import {
  reportClientDiagnostic,
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import type {
  Chat,
  ChatConnectedScope,
  ChatGitChangeScope,
  ChatLocalKnowledgeScope,
  GroundingLimits,
} from "@/lib/types";
import type { UseWorkspaceResult, WorkspaceApi } from "./hooks/useWorkspace.types";
import { MAX_WORKSPACE_WINDOWS, sanitizePersistedWorkspace } from "./hooks/workspace-persistence";
import { connectedScopeFingerprint } from "./hooks/workspaceScopeIdentity";
import type { AppWindow, Connection } from "./windows/types";
import appShellStyles from "./AppShell.module.css";
import { registerChatWindowRuntime } from "./windows/chatWindowActivity";
import { cutResult } from "../../../test-utils/workspace-api-fixture";

interface WorkspaceHookOptions {
  readonly onWindowLimitReached?: (limit: number) => void;
  readonly onGitChangeBind?: (
    chatWindowId: string,
    selection: { readonly baseRef: string; readonly headRef: string },
    target?: ChatBindingTarget,
  ) => false | ChatGitChangeScope | Promise<false | ChatGitChangeScope>;
  readonly onScopeBind?: (
    chatWindowId: string,
    scope: ChatConnectedScope,
    target?: ChatBindingTarget,
  ) => boolean | Promise<boolean>;
  readonly onScopeUnbind?: (
    chatWindowId: string,
    scope: ChatConnectedScope,
    target?: ChatUnbindTarget,
    connectionId?: string,
  ) => boolean | Promise<boolean>;
  readonly onConnectorBind?: (
    chatWindowId: string,
    scope: ChatLocalKnowledgeScope,
    target?: ChatBindingTarget,
  ) => boolean | Promise<boolean>;
  readonly onConnectorUnbind?: (
    chatWindowId: string,
    scope: ChatLocalKnowledgeScope,
    target?: ChatUnbindTarget,
  ) => boolean | Promise<boolean>;
}

interface ChatBindingTarget {
  readonly conversationId: string | undefined;
  readonly projectPath?: string | undefined;
  readonly isCurrent: () => boolean;
}

interface ChatUnbindTarget {
  readonly conversationId: string;
  readonly projectPath: string | undefined;
}

interface TestSession {
  readonly chats: Chat[];
  readonly activeChat: Chat | undefined;
  readonly activeProject:
    { readonly name: string; readonly path: string; readonly available: boolean } | undefined;
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
    canonicalChats: new Map<string, Chat>(),
    groundingLimits: undefined as GroundingLimits | undefined,
    activeWorkspaceRoot: null as string | null,
    workspaceRendered: false,
    rightRailRendered: false,
    rightRailOnTool: undefined as ((id: string) => void) | undefined,
  },
  connectGitChangeToChat: vi.fn(),
  fetchConfig: vi.fn(),
  fetchChats: vi.fn(),
  fetchStartupUpdatePreflight: vi.fn(),
  updateChatConnectedScopes: vi.fn(),
  updateChatLocalKnowledgeScopes: vi.fn(),
  recordReadsContextRelationship: vi.fn(),
  registerSw: vi.fn(),
  refreshActiveWorkspace: vi.fn(),
  mutateActiveWorkspace: vi.fn(),
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

interface CapturedClientDiagnostic {
  readonly message: string;
  readonly meta?: ClientDiagnosticMeta | undefined;
}

const reportedDiagnostics: CapturedClientDiagnostic[] = [];

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

vi.mock("./hooks/useBackendHealth", () => ({
  useBackendHealth: (): { state: "loading" } => ({ state: "loading" }),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import("@/lib/api")>()).ApiError,
  fetchChats: mocks.fetchChats,
  connectGitChangeToChat: mocks.connectGitChangeToChat,
  fetchConfig: mocks.fetchConfig,
  fetchStartupUpdatePreflight: mocks.fetchStartupUpdatePreflight,
  updateChatConnectedScopes: async (
    id: string,
    scopes: readonly ChatConnectedScope[] | null,
    expectedIdentity?: string,
  ): Promise<{ readonly chat: Chat }> => {
    const response = (await (expectedIdentity === undefined
      ? mocks.updateChatConnectedScopes(id, scopes)
      : mocks.updateChatConnectedScopes(id, scopes, expectedIdentity))) as { readonly chat: Chat };
    mocks.state.canonicalChats.set(id, response.chat);
    return response;
  },
  updateChatLocalKnowledgeScopes: mocks.updateChatLocalKnowledgeScopes,
}));

vi.mock("../../relationships/connector-relationship", () => ({
  recordReadsContextRelationship: mocks.recordReadsContextRelationship,
}));

vi.mock("./install/registerSw", () => ({
  registerSw: mocks.registerSw,
}));

vi.mock("./context/ChatSessionContext", () => ({
  ChatSessionProvider: ({ children }: { readonly children: ReactNode }): ReactNode => (
    <>{children}</>
  ),
}));

vi.mock("./hooks/useTheme", () => ({
  useTheme: (): { readonly theme: "dark"; readonly toggle: () => void } => ({
    theme: "dark",
    toggle: vi.fn(),
  }),
}));

vi.mock("./hooks/useChatSession", () => ({
  useChatSession: (): TestSession => {
    if (mocks.state.session === undefined) throw new Error("missing test session");
    return mocks.state.session;
  },
}));

vi.mock("./hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: mocks.useKeyboardShortcuts,
}));

vi.mock("./hooks/useUndoStack", () => ({
  useUndoStack: (): {
    readonly canUndo: false;
    readonly canRedo: false;
    readonly undoLabel: null;
    readonly redoLabel: null;
    readonly push: () => void;
    readonly undo: () => void;
    readonly redo: () => void;
    readonly clear: () => void;
  } => ({
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
  useWorkspace: (
    _ref: RefObject<HTMLDivElement | null>,
    options: WorkspaceHookOptions,
  ): UseWorkspaceResult => {
    mocks.state.workspaceOptions = options;
    if (mocks.state.workspaceResult === undefined) throw new Error("missing workspace result");
    return mocks.state.workspaceResult;
  },
}));

vi.mock("./hooks/useActiveWorkspaceState", () => ({
  useActiveWorkspaceState: (): Record<string, unknown> => ({
    instances: [],
    activeBinding:
      mocks.state.activeWorkspaceRoot === null
        ? null
        : {
            schemaVersion: "1",
            workspaceId: "workspace-1",
            taskId: "task-1",
            activeRoot: mocks.state.activeWorkspaceRoot,
            boundSurfaces: ["git-delivery"],
            gitDeliveryRoot: mocks.state.activeWorkspaceRoot,
            editorProjectRoot: mocks.state.activeWorkspaceRoot,
          },
    activeInstance: null,
    activeRoot: mocks.state.activeWorkspaceRoot,
    loading: false,
    inventoryUnavailable: false,
    switching: false,
    error: null,
    refresh: mocks.refreshActiveWorkspace,
    switchTo: mocks.mutateActiveWorkspace,
    clearActive: mocks.mutateActiveWorkspace,
    pause: mocks.mutateActiveWorkspace,
    resume: mocks.mutateActiveWorkspace,
    prepareHandoff: mocks.mutateActiveWorkspace,
    repair: mocks.mutateActiveWorkspace,
    provision: mocks.mutateActiveWorkspace,
  }),
}));

vi.mock("./Header", () => ({
  Header: ({
    projectName,
    statusLabel,
  }: {
    readonly projectName: string;
    readonly statusLabel: string;
  }): ReactNode => (
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
  }): ReactNode => (
    <footer ref={statusRef} data-testid="footer" tabIndex={-1}>
      {winCount}
    </footer>
  ),
}));

vi.mock("./LeftRail", () => ({
  LeftRail: ({ onNewChat }: { readonly onNewChat: () => void }): ReactNode => (
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
  Workspace: (): ReactNode => {
    mocks.state.workspaceRendered = true;
    return <main data-testid="workspace" />;
  },
}));

vi.mock("./modals/CommandPalette", () => ({
  DesktopCommandPalette: (): ReactNode => <div data-testid="command-palette" />,
}));

vi.mock("./modals/GatewaySetupDialog", (): { readonly GatewaySetupDialog: () => ReactNode } => {
  mocks.gatewaySetupDialogModuleLoaded();
  return {
    GatewaySetupDialog: (): ReactNode => <div role="dialog" aria-label="Gateway setup" />,
  };
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

vi.mock("./modals/Palette", (): { readonly Palette: () => ReactNode } => {
  mocks.paletteModuleLoaded();
  return { Palette: (): ReactNode => <div role="dialog" aria-label="Palette" /> };
});

vi.mock("./update/UpdateStartupNotice", (): { readonly UpdateStartupNotice: () => ReactNode } => {
  mocks.updateStartupNoticeModuleLoaded();
  return {
    UpdateStartupNotice: (): ReactNode => <div data-testid="update-startup-notice" />,
  };
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
    activateWindow: vi.fn(),
    focus: vi.fn(),
    currentSelection: vi.fn(() => ({ focusedWindowId: null, selectedWindowIds: [] })),
    replaceSelection: vi.fn(),
    toggleWindowSelection: vi.fn(),
    clearSelection: vi.fn(),
    moveSelectedWindowsBy: vi.fn(() => ({ dx: 0, dy: 0 })),
    copySelectedWindows: vi.fn(() => ({ captured: 0, skipped: 0, overflow: 0 })),
    cutSelectedWindows: vi.fn(() => cutResult({ captured: 0, skipped: 0, overflow: 0 })),
    pasteCopiedWindows: vi.fn(() => ({ pasted: 0, limitReached: false })),
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
    toggleLayoutLock: vi.fn(),
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
    layoutLocked: false,
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

function restoredTeardownFixture(digest: string | undefined): {
  readonly oldScope: ChatConnectedScope;
  readonly otherScope: ChatConnectedScope;
  readonly api: WorkspaceApi;
} {
  const oldScope = fileScope("/manuals/Scale");
  const otherScope = fileScope("/manuals/ManualOther");
  const active = chat({ connectedScopes: [oldScope, otherScope], updatedAt: 1 });
  const api = workspaceApi();
  mocks.state.session = { ...mocks.state.session!, activeChat: active, chats: [active] };
  mocks.state.workspaceResult = workspaceResult(
    [
      win("files", {}, "files-owner"),
      win("chat", { chatId: active.id, projectPath: "/repo" }, "chat-owner"),
    ],
    [
      {
        id: "owned-edge",
        a: "files-owner",
        b: "chat-owner",
        boundScopeElided: true,
        ...(digest === undefined ? {} : { boundScopeFingerprint: digest }),
      },
    ],
    api,
  );
  mocks.updateChatConnectedScopes.mockImplementation(async (id, scopes) => ({
    chat: chat({ ...active, id, connectedScopes: scopes ?? [], updatedAt: 2 }),
  }));
  return { oldScope, otherScope, api };
}

function capsuleScope(id: string): ChatLocalKnowledgeScope {
  return { kind: "capsule", capsuleId: id as never, connectedAtMs: 1 };
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
    resetClientDiagnosticWriter();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    reportedDiagnostics.length = 0;
    setClientDiagnosticWriter((message, meta): void => {
      reportedDiagnostics.push(meta === undefined ? { message } : { message, meta });
    });
    mocks.state.groundingLimits = DEFAULT_GROUNDING_LIMITS;
    mocks.fetchConfig.mockResolvedValue({
      config: null,
      configPresent: false,
      effectiveGroundingLimits: DEFAULT_GROUNDING_LIMITS,
    });
    mocks.state.canonicalChats.clear();
    mocks.fetchChats.mockReset().mockImplementation(async () => ({
      chats: (mocks.state.session?.chats ?? []).map(
        (current) => mocks.state.canonicalChats.get(current.id) ?? current,
      ),
    }));
    mocks.state.activeWorkspaceRoot = null;
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
      activeProject: { name: "Keiko", path: "/repo", available: true },
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

  it("adopts the canonical chat after a Git connection instead of retaining the old identity", async () => {
    const scope: ChatGitChangeScope = {
      kind: "git-change",
      relationshipId: "git-rel",
      remoteDigest: "d".repeat(64),
      comparisonLabel: "dev...feature",
      baseRef: "dev",
      headRef: "feature",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      mergeBaseSha: "a".repeat(40),
      snapshotDigest: "e".repeat(64),
      fileCount: 1,
      totalFiles: 1,
      omittedFiles: 0,
      truncatedFiles: 0,
      descriptionStatus: "current",
      connectedAtMs: 3,
    };
    const canonical = chat({
      title: "Concurrent server rename",
      gitChangeScopes: [scope],
      updatedAt: 4,
      groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}`,
    });
    mocks.connectGitChangeToChat.mockImplementation(() => {
      mocks.state.canonicalChats.set(canonical.id, canonical);
      return Promise.resolve({ status: "connected", scope });
    });
    await renderMounted();
    const result = await mocks.state.workspaceOptions?.onGitChangeBind?.("chat-window", {
      baseRef: "dev",
      headRef: "feature",
    });
    expect(result).toEqual(scope);
    expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(canonical);
    expect(mocks.fetchChats).toHaveBeenLastCalledWith("/repo", expect.any(String), "chat-1");
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
      projectPath: "/repo",
      chatId: undefined,
      newChatRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(Object.hasOwn(newChatCfg ?? {}, "chatId")).toBe(true);
    expect(Object.hasOwn(newChatCfg ?? {}, "selectionHandoffId")).toBe(false);
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

  it("reports a redacted client diagnostic when grounding persistence fails", async (): Promise<void> => {
    mocks.updateChatConnectedScopes.mockRejectedValueOnce(
      new Error("customer endpoint and response detail"),
    );
    await renderMounted();

    await expect(
      mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/repo")),
    ).resolves.toBe(false);

    expect(await screen.findByText(/Keiko could not connect that source/u)).toBeInTheDocument();
    expect(reportedDiagnostics).toEqual([
      { message: "[keiko] Chat grounding mutation failed: Error" },
    ]);
  });

  it("reports a redacted client diagnostic when connector persistence fails", async (): Promise<void> => {
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
    expect(reportedDiagnostics).toEqual([
      { message: "[keiko] Chat grounding mutation failed: Error" },
    ]);
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

  it("resolves grounding against the chat window's private project session", async (): Promise<void> => {
    const privateChat = chat({ id: "chat-private", projectPath: "/private", updatedAt: 4 });
    const grounded = chat({
      id: privateChat.id,
      projectPath: privateChat.projectPath,
      connectedScopes: [fileScope("/repo")],
      updatedAt: 5,
    });
    mocks.state.workspaceResult = workspaceResult([
      win(
        "chat",
        { chatId: privateChat.id, projectPath: privateChat.projectPath },
        "private-window",
      ),
    ]);
    mocks.fetchChats.mockResolvedValueOnce({ chats: [privateChat] });
    mocks.updateChatConnectedScopes.mockResolvedValueOnce({ chat: grounded });

    await renderMounted();
    const accepted = await mocks.state.workspaceOptions?.onScopeBind?.(
      "private-window",
      fileScope("/repo"),
    );

    expect(accepted).toBe(true);
    expect(mocks.fetchChats).toHaveBeenCalledWith("/private", expect.any(String), "chat-private");
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledWith(
      privateChat.id,
      expect.arrayContaining([expect.objectContaining({ root: "/repo" })]),
    );
    expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(grounded);
  });

  it("resolves a privacy-omitted chat through its transient window target", async (): Promise<void> => {
    const privateChat = chat({ id: "chat-private", projectPath: "/private", updatedAt: 4 });
    const grounded = chat({
      id: privateChat.id,
      projectPath: privateChat.projectPath,
      connectedScopes: [fileScope("/repo")],
      updatedAt: 5,
    });
    mocks.state.workspaceResult = workspaceResult([
      win("chat", { chatId: privateChat.id, projectPathPrivacy: "omit" }, "private-window"),
    ]);
    mocks.fetchChats.mockResolvedValueOnce({ chats: [privateChat] });
    mocks.updateChatConnectedScopes.mockResolvedValueOnce({ chat: grounded });
    const unregister = registerChatWindowRuntime("private-window", {
      conversationId: privateChat.id,
      projectPath: privateChat.projectPath,
    });

    try {
      await renderMounted();
      const accepted = await mocks.state.workspaceOptions?.onScopeBind?.(
        "private-window",
        fileScope("/repo"),
      );

      expect(accepted).toBe(true);
      expect(mocks.fetchChats).toHaveBeenCalledWith("/private", expect.any(String), "chat-private");
      expect(mocks.updateChatConnectedScopes).toHaveBeenCalledWith(
        privateChat.id,
        expect.arrayContaining([expect.objectContaining({ root: "/repo" })]),
      );
    } finally {
      unregister();
    }
  });

  it("resolves a transient private chat before its workspace snapshot is committed", async () => {
    const privateChat = chat({ id: "chat-private", projectPath: "/private", updatedAt: 4 });
    const grounded = chat({
      id: privateChat.id,
      projectPath: privateChat.projectPath,
      connectedScopes: [fileScope("/repo")],
      updatedAt: 5,
    });
    mocks.state.workspaceResult = workspaceResult([]);
    mocks.fetchChats.mockResolvedValueOnce({ chats: [privateChat] });
    mocks.updateChatConnectedScopes.mockResolvedValueOnce({ chat: grounded });
    const unregister = registerChatWindowRuntime("private-window", {
      conversationId: privateChat.id,
      projectPath: privateChat.projectPath,
    });

    try {
      await renderMounted();
      const accepted = await mocks.state.workspaceOptions?.onScopeBind?.(
        "private-window",
        fileScope("/repo"),
      );

      expect(accepted).toBe(true);
      expect(mocks.fetchChats).toHaveBeenCalledWith("/private", expect.any(String), "chat-private");
      expect(mocks.updateChatConnectedScopes).toHaveBeenCalledWith(
        privateChat.id,
        expect.arrayContaining([expect.objectContaining({ root: "/repo" })]),
      );
    } finally {
      unregister();
    }
  });

  it("retains the server correlation when a scoped chat lookup fails", async (): Promise<void> => {
    mocks.state.workspaceResult = workspaceResult([
      win("chat", { chatId: "chat-private", projectPath: "/private" }, "private-window"),
    ]);
    const failure = new ApiError("SERVER_ERROR", "private detail", 503);
    failure.correlationId = "scope-lookup-test";
    mocks.fetchChats.mockRejectedValueOnce(failure);
    await renderMounted();
    await mocks.state.workspaceOptions?.onScopeBind?.("private-window", fileScope("/repo"));
    expect(reportedDiagnostics).toEqual([
      {
        message: "[keiko] Chat lookup failed: ChatLookupFailure",
        meta: {
          correlationId: "scope-lookup-test",
          kind: "other",
          errorKind: "unavailable",
          errorEvidence: { errorClass: "ApiError", causeChain: [], frames: [] },
        },
      },
    ]);
  });

  it.each([
    {
      error: new ApiError("STALE_SESSION", "private cause canary", 403),
      errorKind: "authority-denied",
      errorClass: "ApiError",
    },
    {
      error: new DOMException("private cause canary", "TimeoutError"),
      errorKind: "timeout",
      errorClass: "TimeoutError",
    },
    {
      error: new TypeError("private cause canary"),
      errorKind: "unavailable",
      errorClass: "TypeError",
    },
  ])(
    "records $errorKind for the actual scoped lookup cause",
    async ({ error, errorKind, errorClass }) => {
      mocks.state.workspaceResult = workspaceResult([
        win("chat", { chatId: "chat-private", projectPath: "/private" }, "private-window"),
      ]);
      mocks.fetchChats.mockRejectedValueOnce(error);
      await renderMounted();
      await mocks.state.workspaceOptions?.onScopeBind?.("private-window", fileScope("/repo"));
      expect(reportedDiagnostics).toEqual([
        expect.objectContaining({
          meta: expect.objectContaining({
            correlationId: expect.any(String),
            errorKind,
            errorEvidence: expect.objectContaining({ errorClass }),
          }),
        }),
      ]);
      expect(JSON.stringify(reportedDiagnostics)).not.toContain("private cause canary");
    },
  );

  it("surfaces a redacted client diagnostic when a private chat lookup fails", async (): Promise<void> => {
    mocks.state.workspaceResult = workspaceResult([
      win("chat", { chatId: "chat-private", projectPath: "/private" }, "private-window"),
    ]);
    mocks.fetchChats.mockRejectedValueOnce(new Error("customer-specific upstream detail"));

    await renderMounted();
    const accepted = await mocks.state.workspaceOptions?.onScopeBind?.(
      "private-window",
      fileScope("/repo"),
    );

    expect(accepted).toBe(false);
    expect(await screen.findByText(/Keiko could not connect that source/u)).toBeInTheDocument();
    expect(reportedDiagnostics).toEqual([
      {
        message: "[keiko] Chat lookup failed: ChatLookupFailure",
        meta: {
          correlationId: expect.any(String),
          kind: "other",
          errorKind: "unknown",
          errorEvidence: { errorClass: "Error", causeChain: [], frames: [] },
        },
      },
    ]);
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

  it("gives the one canonical conflict retry a fresh mutation budget", async (): Promise<void> => {
    const conflictReady = deferred<void>();
    const persisted = deferred<{ readonly chat: Chat }>();
    const nextScope = fileScope("/retry-budget");
    const updated = chat({ connectedScopes: [nextScope], updatedAt: 2 });
    mocks.updateChatConnectedScopes
      .mockImplementationOnce(async (): Promise<never> => {
        await conflictReady.promise;
        throw new ApiError("GROUNDING_SCOPE_CHANGED", "Sources changed", 409);
      })
      .mockReturnValueOnce(persisted.promise);
    await renderMounted();
    vi.useFakeTimers();
    const binding = Promise.resolve(
      mocks.state.workspaceOptions?.onScopeBind?.("chat-window", nextScope),
    );
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS - 1000);
    await act(async (): Promise<void> => {
      conflictReady.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    await act(async (): Promise<void> => {
      persisted.resolve({ chat: updated });
      await persisted.promise;
    });
    await expect(binding).resolves.toBe(true);
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
    expect(reportedDiagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filesScopeDecision: { decision: "timeout-blocked" },
        }),
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
    expect(reportError).not.toHaveBeenCalled();
    const attemptCorrelation = mocks.fetchChats.mock.calls[0]?.[1] as string;
    expect(reportedDiagnostics).toEqual([
      {
        message: "Keiko Files scope ownership decision.",
        meta: {
          correlationId: attemptCorrelation,
          filesScopeDecision: { decision: "timeout-blocked" },
        },
      },
      { message: "[keiko] Chat grounding timeout: Error" },
      { message: "[keiko] Chat grounding timeout: Error" },
      {
        message: "Keiko Files scope ownership decision.",
        meta: {
          correlationId: attemptCorrelation,
          filesScopeDecision: { decision: "timeout-recovered" },
        },
      },
    ]);
  });

  it("unblocks a timed-out chat only after the late mutation and compensation settle", async (): Promise<void> => {
    const persisted = deferred<{ readonly chat: Chat }>();
    const compensation = deferred<{ readonly chat: Chat }>();
    const source = fileScope("/late");
    mocks.updateChatConnectedScopes
      .mockReturnValueOnce(persisted.promise)
      .mockReturnValueOnce(compensation.promise);
    await renderMounted();
    vi.useFakeTimers();
    const bind = mocks.state.workspaceOptions?.onScopeBind;
    const first = bind?.("chat-window", source);
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);
    expect(await first).toBe(false);
    await act(async (): Promise<void> => {
      persisted.resolve({ chat: chat({ connectedScopes: [source], updatedAt: 2 }) });
    });
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
    expect(await bind?.("chat-window", fileScope("/still-blocked"))).toBe(false);
    await act(async (): Promise<void> => {
      compensation.resolve({ chat: chat({ connectedScopes: [], updatedAt: 3 }) });
    });
    await act(async (): Promise<void> => {
      expect(await bind?.("chat-window", fileScope("/after-recovery"))).toBe(true);
    });
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(3);
    expect(mocks.updateChatConnectedScopes.mock.calls.at(-1)?.[1]).toEqual([
      expect.objectContaining({ root: "/after-recovery" }),
    ]);
  });

  it("keeps a timed-out connector blocked when its late compensation fails", async (): Promise<void> => {
    const persisted = deferred<{ readonly chat: Chat }>();
    const source = capsuleScope("late-capsule");
    mocks.updateChatLocalKnowledgeScopes
      .mockReturnValueOnce(persisted.promise)
      .mockRejectedValueOnce(new Error("compensation unavailable"));
    await renderMounted();
    vi.useFakeTimers();
    const bind = mocks.state.workspaceOptions?.onConnectorBind;
    const first = bind?.("chat-window", source);
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);
    expect(await first).toBe(false);
    await act(async (): Promise<void> => {
      persisted.resolve({ chat: chat({ localKnowledgeScopes: [source], updatedAt: 2 }) });
    });
    expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenCalledTimes(2);
    expect(await bind?.("chat-window", capsuleScope("must-remain-blocked"))).toBe(false);
    expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenCalledTimes(2);
  });

  it("compensates a timed-out scope unbind before retaining the visible edge", async () => {
    vi.stubGlobal("reportError", vi.fn());
    const scope = fileScope("/late-unbind");
    const current = chat({ connectedScopes: [scope], updatedAt: 1 });
    const removed = chat({ connectedScopes: [], updatedAt: 2 });
    const restored = chat({ connectedScopes: [scope], updatedAt: 3 });
    const persisted = deferred<{ readonly chat: Chat }>();
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      activeChat: current,
      chats: [current],
    };
    mocks.updateChatConnectedScopes
      .mockReturnValueOnce(persisted.promise)
      .mockResolvedValueOnce({ chat: restored });
    await renderMounted();
    vi.useFakeTimers();

    const unbinding = Promise.resolve(
      mocks.state.workspaceOptions?.onScopeUnbind?.("chat-window", scope),
    );
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);
    await expect(unbinding).resolves.toBe(false);

    await act(async (): Promise<void> => {
      persisted.resolve({ chat: removed });
      await persisted.promise;
      await Promise.resolve();
    });

    expect(mocks.updateChatConnectedScopes).toHaveBeenNthCalledWith(2, "chat-1", [scope]);
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalledWith(removed);
  });

  it("compensates a timed-out connector unbind before retaining the visible edge", async () => {
    vi.stubGlobal("reportError", vi.fn());
    const scope = capsuleScope("cap-late-unbind");
    const current = chat({ localKnowledgeScopes: [scope], updatedAt: 1 });
    const removed = chat({ localKnowledgeScopes: [], updatedAt: 2 });
    const restored = chat({ localKnowledgeScopes: [scope], updatedAt: 3 });
    const persisted = deferred<{ readonly chat: Chat }>();
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      activeChat: current,
      chats: [current],
    };
    mocks.updateChatLocalKnowledgeScopes
      .mockReturnValueOnce(persisted.promise)
      .mockResolvedValueOnce({ chat: restored });
    await renderMounted();
    vi.useFakeTimers();

    const unbinding = Promise.resolve(
      mocks.state.workspaceOptions?.onConnectorUnbind?.("chat-window", scope),
    );
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);
    await expect(unbinding).resolves.toBe(false);

    await act(async (): Promise<void> => {
      persisted.resolve({ chat: removed });
      await persisted.promise;
      await Promise.resolve();
    });

    expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenNthCalledWith(2, "chat-1", [scope]);
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalledWith(removed);
  });

  it("surfaces a distinct client diagnostic when stale-bind compensation fails", async (): Promise<void> => {
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
    expect(reportedDiagnostics).toEqual([
      { message: "[keiko] Chat binding compensation failed: Error" },
    ]);
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

  it("stacks global failure and source notices with independent dismissal", async () => {
    const cappedChat = chat({
      connectedScopes: Array.from({ length: 8 }, (_unused, index) =>
        fileScope(`/repo-${String(index)}`, index),
      ),
      localKnowledgeScopes: Array.from({ length: 8 }, (_unused, index) =>
        capsuleScope(`cap-${String(index)}`),
      ),
    });
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      chats: [cappedChat],
      activeChat: cappedChat,
    };
    await renderMounted();
    await act(async () => {
      await mocks.state.workspaceOptions?.onConnectorBind?.("chat-window", capsuleScope("cap-17"));
      reportClientDiagnostic("[keiko] uncaught window error: Error", {
        kind: "window-error",
        globalFailure: true,
        correlationId: "stack-global-failure",
      });
    });
    const sourceNotice = await screen.findByText(/already has 16 of 16 connected sources/u);
    const globalNotice = screen.getByText("Keiko encountered an error.");
    const stack = sourceNotice.closest(`.${appShellStyles.cmpSourceAlertStack}`);
    expect(stack).not.toBeNull();
    expect(globalNotice.closest(`.${appShellStyles.cmpSourceAlertStack}`)).toBe(stack);
    expect(stack?.querySelectorAll("[role='alert']")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss workspace notice" }));
    expect(sourceNotice).not.toBeInTheDocument();
    expect(globalNotice).toBeVisible();
    const globalAlert = globalNotice.closest("[role='alert']");
    if (!(globalAlert instanceof HTMLElement)) throw new TypeError("Global alert missing");
    await userEvent.click(within(globalAlert).getByRole("button", { name: "Close" }));
    expect(globalNotice).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Dismiss workspace notice" }));

    await waitFor(() => {
      expect(document.querySelector(".source-limit-alert")).toBeNull();
    });
  });

  it("surfaces and announces a rejected window allocation", async () => {
    await renderMounted();

    act(() => {
      mocks.state.workspaceOptions?.onWindowLimitReached?.(MAX_WORKSPACE_WINDOWS);
    });

    const notice = await screen.findByText(
      `The workspace already has ${String(MAX_WORKSPACE_WINDOWS)} open windows. Close a window and try again.`,
    );
    expect(notice.closest(".source-limit-alert")).toHaveAttribute("role", "alert");
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

    await user.click(screen.getByRole("button", { name: "Dismiss workspace notice" }));

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

  it("unbinds a detached private-project chat from its immutable close snapshot", async () => {
    const privateScope = fileScope("/private/source");
    const privateChat = chat({
      id: "chat-private",
      projectPath: "/private",
      connectedScopes: [privateScope],
      updatedAt: 4,
    });
    const updated = chat({
      id: privateChat.id,
      projectPath: privateChat.projectPath,
      connectedScopes: [],
      updatedAt: 5,
    });
    mocks.fetchChats.mockResolvedValueOnce({ chats: [privateChat] });
    mocks.updateChatConnectedScopes.mockResolvedValueOnce({ chat: updated });
    await renderMounted();

    act((): void => {
      mocks.state.workspaceOptions?.onScopeUnbind?.("closed-window", privateScope, {
        conversationId: privateChat.id,
        projectPath: privateChat.projectPath,
      });
    });

    await waitFor((): void => {
      expect(mocks.updateChatConnectedScopes).toHaveBeenCalledWith(privateChat.id, null);
    });
    expect(mocks.fetchChats).toHaveBeenCalledWith("/private", expect.any(String), "chat-private");
    expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(updated);
  });

  it("rejects an unbind and surfaces a notice when private chat lookup fails", async () => {
    const privateScope = fileScope("/private/source");
    mocks.fetchChats.mockRejectedValueOnce(new Error("customer-specific upstream detail"));
    await renderMounted();

    let accepted = true;
    await act(async () => {
      accepted =
        (await mocks.state.workspaceOptions?.onScopeUnbind?.("closed-window", privateScope, {
          conversationId: "chat-private",
          projectPath: "/private",
        })) !== false;
    });

    expect(accepted).toBe(false);
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(await screen.findByText("Unable to disconnect scope.")).toBeInTheDocument();
    expect(reportedDiagnostics).toEqual([
      {
        message: "[keiko] Chat lookup failed: ChatLookupFailure",
        meta: {
          correlationId: expect.any(String),
          kind: "other",
          errorKind: "unknown",
          errorEvidence: { errorClass: "Error", causeChain: [], frames: [] },
        },
      },
    ]);
  });

  it("rejects an unbind when its bound chat can no longer be resolved", async () => {
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      chats: [],
      activeChat: undefined,
    };
    await renderMounted();

    let accepted = true;
    await act(async () => {
      accepted =
        (await mocks.state.workspaceOptions?.onScopeUnbind?.(
          "missing-window",
          fileScope("/private/source"),
          { conversationId: "chat-missing", projectPath: undefined },
        )) !== false;
    });

    expect(accepted).toBe(false);
    expect(mocks.fetchChats).not.toHaveBeenCalled();
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(await screen.findByText("Unable to disconnect scope.")).toBeInTheDocument();
  });

  it("rejects connector unbind when the server mutation fails", async () => {
    vi.stubGlobal("reportError", vi.fn());
    const currentChat = chat({ localKnowledgeScopes: [capsuleScope("cap-a")] });
    mocks.state.session = {
      ...(mocks.state.session as TestSession),
      chats: [currentChat],
      activeChat: currentChat,
    };
    mocks.updateChatLocalKnowledgeScopes.mockRejectedValueOnce(new Error("upstream detail"));
    await renderMounted();

    let accepted = true;
    await act(async () => {
      accepted =
        (await mocks.state.workspaceOptions?.onConnectorUnbind?.(
          "chat-window",
          capsuleScope("cap-a"),
        )) !== false;
    });

    expect(accepted).toBe(false);
    expect(await screen.findByText("Unable to disconnect scope.")).toBeInTheDocument();
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalled();
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
    vi.mocked(api.add).mockReturnValue("search-window");
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
    expect(api.activateWindow).not.toHaveBeenCalled();
    expect(api.toggleTool).not.toHaveBeenCalledWith("search");
    statusSpy.mockRestore();
    rafSpy.mockRestore();
  });

  it("records a rooted minimized Search restore as a closed-to-open transition", async (): Promise<void> => {
    const api = workspaceApi();
    vi.mocked(api.add).mockReturnValue("search-window");
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
    expect(api.activateWindow).not.toHaveBeenCalled();
    expect(mocks.pushUndo).toHaveBeenCalledWith({
      kind: "ui.panel.toggle",
      panel: "search",
      before: false,
      after: true,
      searchRoot: "/repo/editor-selected",
    });
    rafSpy.mockRestore();
  });

  it("opens Git from the rail with the selected project and records it for redo", async () => {
    const api = workspaceApi();
    vi.mocked(api.add).mockReturnValue("governedGit");
    mocks.state.workspaceResult = workspaceResult([], [], api);
    await renderMounted();
    expect(mocks.state.rightRailOnTool).toBeTypeOf("function");
    vi.mocked(api.add).mockClear();
    mocks.pushUndo.mockClear();

    await act(async (): Promise<void> => {
      mocks.state.rightRailOnTool?.("governedGit");
    });

    expect(api.add).toHaveBeenCalledWith("governedGit", {
      projectPath: "/repo",
      rootBinding: "coding-repository",
    });
    expect(api.activateWindow).not.toHaveBeenCalled();
    expect(api.toggleTool).not.toHaveBeenCalledWith("governedGit");
    expect(mocks.pushUndo).toHaveBeenCalledWith({
      kind: "ui.panel.toggle",
      panel: "governedGit",
      before: false,
      after: true,
      projectRoot: "/repo",
    });
  });

  it("opens Git from the rail with the selected project while a task workspace is active", async () => {
    const api = workspaceApi();
    mocks.state.activeWorkspaceRoot = "/repo/.keiko/dev/ui/task-workspaces/repo/ws-active";
    vi.mocked(api.add).mockReturnValue("governedGit");
    mocks.state.workspaceResult = workspaceResult([], [], api);
    await renderMounted();
    vi.mocked(api.add).mockClear();
    mocks.pushUndo.mockClear();

    await act(async (): Promise<void> => {
      mocks.state.rightRailOnTool?.("governedGit");
    });

    expect(api.add).toHaveBeenCalledWith("governedGit", {
      projectPath: "/repo",
      rootBinding: "coding-repository",
    });
    expect(api.add).not.toHaveBeenCalledWith(
      "governedGit",
      expect.objectContaining({
        projectPath: "/repo/.keiko/dev/ui/task-workspaces/repo/ws-active",
      }),
    );
    expect(mocks.pushUndo).toHaveBeenCalledWith({
      kind: "ui.panel.toggle",
      panel: "governedGit",
      before: false,
      after: true,
      projectRoot: "/repo",
    });
  });

  it("records the Search window root when closing it so undo restores the same binding", async () => {
    const api = workspaceApi();
    mocks.state.workspaceResult = workspaceResult(
      [win("search", { root: "/repo/search-bound" }, "search-window")],
      [],
      api,
    );
    await renderMounted();
    mocks.pushUndo.mockClear();

    await act(async (): Promise<void> => {
      mocks.state.rightRailOnTool?.("search");
    });

    expect(api.toggleTool).toHaveBeenCalledWith("search");
    expect(mocks.pushUndo).toHaveBeenCalledWith({
      kind: "ui.panel.toggle",
      panel: "search",
      before: true,
      after: false,
      searchRoot: "/repo/search-bound",
    });
  });

  it("records the Git window root when closing it so undo restores the same binding", async () => {
    const api = workspaceApi();
    mocks.state.workspaceResult = workspaceResult(
      [
        win(
          "governedGit",
          { projectPath: "/repo/git-bound", rootBinding: "coding-repository" },
          "git-window",
        ),
      ],
      [],
      api,
    );
    await renderMounted();
    mocks.pushUndo.mockClear();

    await act(async (): Promise<void> => {
      mocks.state.rightRailOnTool?.("governedGit");
    });

    expect(api.toggleTool).toHaveBeenCalledWith("governedGit");
    expect(mocks.pushUndo).toHaveBeenCalledWith({
      kind: "ui.panel.toggle",
      panel: "governedGit",
      before: true,
      after: false,
      projectRoot: "/repo/git-bound",
    });
  });

  it("replaces only the acknowledged restored Files source while preserving chat history", async (): Promise<void> => {
    const oldScope = fileScope("/manuals/Scale");
    const otherScope = fileScope("/manuals/ManualOther");
    const active = chat({
      connectedScopes: [oldScope, otherScope],
      title: "Saved history",
      updatedAt: 1,
    });
    mocks.state.session = { ...mocks.state.session!, activeChat: active, chats: [active] };
    const snapshot = sanitizePersistedWorkspace(
      [
        win(
          "files",
          { root: "/manuals/Distinct", rootBinding: "coding-repository" },
          "files-owner",
        ),
        win("chat", { chatId: active.id, projectPath: "/repo" }, "chat-owner"),
      ],
      [
        {
          id: "owned-edge",
          a: "files-owner",
          b: "chat-owner",
          boundRoot: oldScope.root,
          boundScopeKind: oldScope.kind,
          boundScopeFingerprint: connectedScopeFingerprint(oldScope),
        },
      ],
    );
    mocks.state.workspaceResult = workspaceResult(snapshot.wins, snapshot.conns);
    mocks.updateChatConnectedScopes.mockImplementation(async (id, scopes) => ({
      chat: chat({ ...active, id, connectedScopes: scopes ?? [], updatedAt: 2 }),
    }));
    await renderMounted();
    await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalled());
    expect(mocks.updateChatConnectedScopes.mock.calls.at(-1)?.[1]).toEqual([
      otherScope,
      expect.objectContaining({ root: "/manuals/Distinct" }),
    ]);
    expect(mocks.state.session?.replaceChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: active.id, title: "Saved history" }),
    );
  });

  it("does not append a new root when a legacy edge cannot identify its existing source", async (): Promise<void> => {
    const active = chat({ connectedScopes: [fileScope("/manuals/Scale")] });
    mocks.state.session = { ...mocks.state.session!, activeChat: active, chats: [active] };
    mocks.state.workspaceResult = workspaceResult(
      [
        win(
          "files",
          { root: "/manuals/Distinct", rootBinding: "coding-repository" },
          "files-owner",
        ),
        win("chat", { chatId: active.id, projectPath: "/repo" }, "chat-owner"),
      ],
      [{ id: "legacy-edge", a: "files-owner", b: "chat-owner", boundScopeElided: true }],
    );
    await renderMounted();
    await waitFor(() => expect(screen.getByText(/cannot be restored uniquely/u)).toBeVisible());
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalled();
  });

  it("keeps a restored old source while another Files edge still owns it", async (): Promise<void> => {
    const oldScope = fileScope("/manuals/Scale");
    const active = chat({ connectedScopes: [oldScope], updatedAt: 1 });
    mocks.state.session = { ...mocks.state.session!, activeChat: active, chats: [active] };
    const snapshot = sanitizePersistedWorkspace(
      [
        win(
          "files",
          { root: "/manuals/Distinct", rootBinding: "coding-repository" },
          "files-moving",
        ),
        win("files", {}, "files-other"),
        win("chat", { chatId: active.id, projectPath: "/repo" }, "chat-owner"),
      ],
      ["files-moving", "files-other"].map((id) => ({
        id: `${id}-edge`,
        a: id,
        b: "chat-owner",
        boundScopeElided: true,
        boundScopeFingerprint: connectedScopeFingerprint(oldScope),
      })),
    );
    mocks.state.workspaceResult = workspaceResult(snapshot.wins, snapshot.conns);
    mocks.updateChatConnectedScopes.mockImplementation(async (id, scopes) => ({
      chat: chat({ ...active, id, connectedScopes: scopes ?? [], updatedAt: 2 }),
    }));
    await renderMounted();
    await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalled());
    expect(mocks.updateChatConnectedScopes.mock.calls.at(-1)?.[1]).toEqual([
      oldScope,
      expect.objectContaining({ root: "/manuals/Distinct" }),
    ]);
  });

  it.each(["BAD-DIGEST"])(
    "never deletes canonical sources for an unmatched ownership digest %s",
    async (digest): Promise<void> => {
      const active = chat({ connectedScopes: [fileScope("/manuals/Unowned")] });
      mocks.state.session = { ...mocks.state.session!, activeChat: active, chats: [active] };
      mocks.state.workspaceResult = workspaceResult(
        [
          win("files", { root: "/manuals/Distinct" }, "files-owner"),
          win("chat", { chatId: active.id, projectPath: "/repo" }, "chat-owner"),
        ],
        [
          {
            id: "owned-edge",
            a: "files-owner",
            b: "chat-owner",
            boundScopeElided: true,
            boundScopeFingerprint: digest,
          },
        ],
      );
      await renderMounted();
      await waitFor(() => expect(screen.getByText(/cannot be restored uniquely/u)).toBeVisible());
      expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    },
  );

  it("rebinds a valid absent fingerprint without deleting other canonical sources", async (): Promise<void> => {
    const absent = connectedScopeFingerprint(fileScope("/removed-from-chat"));
    const { oldScope, otherScope } = restoredTeardownFixture(absent);
    const workspace = mocks.state.workspaceResult!;
    mocks.state.workspaceResult = workspaceResult(
      (workspace.wins ?? []).map((window) =>
        window.type === "files" ? { ...window, cfg: { root: "/newly-selected" } } : window,
      ),
      workspace.conns,
      workspace.api,
    );
    await renderMounted();
    await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce());
    expect(mocks.updateChatConnectedScopes.mock.calls[0]?.[1]).toEqual([
      oldScope,
      otherScope,
      expect.objectContaining({ root: "/newly-selected" }),
    ]);
  });

  it("accepts teardown when a valid fingerprint proves that its source is absent", async (): Promise<void> => {
    const absent = connectedScopeFingerprint(fileScope("/removed-from-chat"));
    restoredTeardownFixture(absent);
    await renderMounted();
    await act(async (): Promise<void> => {
      expect(
        await mocks.state.workspaceOptions?.onScopeUnbind?.(
          "chat-owner",
          fileScope("/visible-folder"),
          undefined,
          "owned-edge",
        ),
      ).toBe(true);
    });
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalled();
  });

  it("preserves a newer local chat edit during an already canonical source refresh", async (): Promise<void> => {
    const source = fileScope("/already-connected");
    const initial = chat({ connectedScopes: [source], title: "Old title", updatedAt: 1 });
    mocks.state.session = { ...mocks.state.session!, activeChat: initial, chats: [initial] };
    const lookup = deferred<{ readonly chats: readonly Chat[] }>();
    mocks.fetchChats.mockReturnValueOnce(lookup.promise);
    const view = render(<AppShell />);
    await screen.findByTestId("workspace");
    const binding = mocks.state.workspaceOptions?.onScopeBind?.("chat-window", source);
    await waitFor(() => expect(mocks.fetchChats).toHaveBeenCalledOnce());
    const edited = { ...initial, title: "New local title", updatedAt: 2 };
    mocks.state.session = { ...mocks.state.session!, activeChat: edited, chats: [edited] };
    view.rerender(<AppShell />);
    await act(async (): Promise<void> => {
      lookup.resolve({ chats: [initial] });
      expect(await binding).toBe(true);
    });
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalled();
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
  });

  it("adopts a legacy edge already matching a canonical source without deleting other sources", async (): Promise<void> => {
    const visible = fileScope("/manuals/Scale");
    const active = chat({ connectedScopes: [fileScope("/manuals/Unowned"), visible] });
    const api = workspaceApi();
    mocks.state.session = { ...mocks.state.session!, activeChat: active, chats: [active] };
    mocks.state.workspaceResult = workspaceResult(
      [
        win("files", { root: visible.root }, "files-owner"),
        win("chat", { chatId: active.id, projectPath: "/repo" }, "chat-owner"),
      ],
      [{ id: "legacy-edge", a: "files-owner", b: "chat-owner", boundScopeElided: true }],
      api,
    );
    await renderMounted();
    await waitFor(() =>
      expect(api.updateConnBoundScope).toHaveBeenCalledWith("legacy-edge", visible),
    );
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "resolves canonical ownership for immediate teardown before a replay acknowledgement (rootless=%s)",
    async (rootless): Promise<void> => {
      const digest = connectedScopeFingerprint(fileScope("/manuals/Scale"));
      const { otherScope, api } = restoredTeardownFixture(digest);
      await renderMounted();
      expect(api.updateConnBoundScope).not.toHaveBeenCalled();
      const trigger: ChatConnectedScope = rootless
        ? { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 }
        : fileScope("/manuals/Distinct");
      await act(async (): Promise<void> => {
        expect(
          await mocks.state.workspaceOptions?.onScopeUnbind?.(
            "chat-owner",
            trigger,
            undefined,
            "owned-edge",
          ),
        ).toBe(true);
      });
      expect(mocks.updateChatConnectedScopes.mock.calls.at(-1)?.[1]).toEqual([otherScope]);
    },
  );

  it.each([undefined, "BAD-DIGEST"])(
    "refuses immediate teardown with unproven ownership %s",
    async (digest): Promise<void> => {
      restoredTeardownFixture(digest);
      await renderMounted();
      await act(async (): Promise<void> => {
        expect(
          await mocks.state.workspaceOptions?.onScopeUnbind?.(
            "chat-owner",
            fileScope("/manuals/Distinct"),
            undefined,
            "owned-edge",
          ),
        ).toBe(false);
      });
      expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
      expect(screen.getByText(/cannot be restored uniquely/u)).toBeVisible();
      expect(JSON.stringify(reportedDiagnostics)).not.toContain("/manuals/");
    },
  );

  it("retains another Files edge's source when one shared folder binding moves", async (): Promise<void> => {
    const oldScope = fileScope("/manual-shared");
    const active = chat({ connectedScopes: [oldScope], updatedAt: 1 });
    mocks.state.session = { ...mocks.state.session!, activeChat: active, chats: [active] };
    let updatedAt = 1;
    mocks.updateChatConnectedScopes.mockImplementation(
      async (_id, scopes: ChatConnectedScope[] | null) => ({
        chat: chat({
          connectedScopes: scopes ?? [],
          updatedAt: ++updatedAt,
          groundingScopeIdentity: "gsi-v1:" + "c".repeat(64),
        }),
      }),
    );
    const edges: Connection[] = [
      { id: "shared-first", a: "files-1", b: "chat-window", boundRoot: "/manual-shared" },
      { id: "shared-second", a: "files-2", b: "chat-window", boundRoot: "/manual-shared" },
    ];
    const windows = [
      win("files", { root: oldScope.root }, "files-1"),
      win("files", { root: oldScope.root }, "files-2"),
      win("chat", { chatId: active.id, projectPath: "/repo" }, "chat-window"),
    ];
    mocks.state.workspaceResult = workspaceResult(windows, edges);
    const view = render(<AppShell />);
    await screen.findByTestId("workspace");
    const nextScope = fileScope("/manual-new");
    mocks.state.workspaceResult = workspaceResult(
      [{ ...windows[0]!, cfg: { root: nextScope.root } }, ...windows.slice(1)],
      edges,
    );
    view.rerender(<AppShell />);
    await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalled());
    expect(mocks.updateChatConnectedScopes.mock.calls.at(-1)?.[1]).toEqual([
      oldScope,
      expect.objectContaining({ root: nextScope.root }),
    ]);
    expect(mocks.state.session?.replaceChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        groundingScopeIdentity: "gsi-v1:" + "c".repeat(64),
      }),
    );
    await act(async (): Promise<void> => {
      await mocks.state.workspaceOptions?.onScopeUnbind?.(
        "chat-window",
        nextScope,
        undefined,
        "shared-first",
      );
    });
    expect(mocks.updateChatConnectedScopes.mock.calls.at(-1)?.[1]).toEqual([oldScope]);
    await act(async (): Promise<void> => {
      await mocks.state.workspaceOptions?.onScopeUnbind?.(
        "chat-window",
        oldScope,
        undefined,
        "shared-second",
      );
    });
    expect(mocks.updateChatConnectedScopes.mock.calls.at(-1)?.[1]).toBeNull();
  });

  it("releases a shared source only after both Files edges disconnect before React redraws", async (): Promise<void> => {
    const scope = fileScope("/manual-shared");
    const active = chat({ connectedScopes: [scope], updatedAt: 1 });
    mocks.state.session = { ...mocks.state.session!, activeChat: active, chats: [active] };
    let updatedAt = 1;
    mocks.updateChatConnectedScopes.mockImplementation(
      async (_id, scopes: ChatConnectedScope[] | null) => ({
        chat: chat({ connectedScopes: scopes ?? [], updatedAt: ++updatedAt }),
      }),
    );
    const edges: Connection[] = [
      { id: "shared-first", a: "files-1", b: "chat-window", boundRoot: "/manual-shared" },
      { id: "shared-second", a: "files-2", b: "chat-window", boundRoot: "/manual-shared" },
    ];
    mocks.state.workspaceResult = workspaceResult(
      [
        win("files", { root: scope.root }, "files-1"),
        win("files", { root: scope.root }, "files-2"),
        win("chat", { chatId: active.id, projectPath: "/repo" }, "chat-window"),
      ],
      edges,
    );
    await renderMounted();
    await act(async (): Promise<void> => {
      const unbind = mocks.state.workspaceOptions?.onScopeUnbind;
      await Promise.all([
        unbind?.("chat-window", scope, undefined, "shared-first"),
        unbind?.("chat-window", scope, undefined, "shared-second"),
      ]);
    });
    expect(mocks.updateChatConnectedScopes.mock.calls.map((call) => call[1])).toEqual([
      [scope],
      null,
    ]);
    await act(async (): Promise<void> => {
      await mocks.state.workspaceOptions?.onScopeBind?.("chat-window", scope);
      await mocks.state.workspaceOptions?.onScopeUnbind?.("chat-window", scope);
    });
    expect(mocks.updateChatConnectedScopes.mock.calls.at(-1)?.[1]).toBeNull();
  });

  it("coalesces queued Files roots after an in-flight initial acknowledgement", async (): Promise<void> => {
    const initial = deferred<{ readonly chats: readonly Chat[] }>();
    const oldScope = fileScope("/manual-old");
    const otherScope = fileScope("/independent-folder");
    const active = chat({ connectedScopes: [oldScope, otherScope], updatedAt: 1 });
    const api = workspaceApi();
    const connection: Connection = {
      id: "files-edge",
      a: "files-1",
      b: "chat-window",
      boundScopeElided: true,
    };
    const windows = [
      win("files", { root: "/manual-old", rootBinding: "coding-repository" }),
      win("files", { root: "/independent-folder" }, "files-independent"),
      win("chat", { chatId: active.id, projectPath: "/repo" }, "chat-window"),
    ];
    mocks.state.session = { ...mocks.state.session!, activeChat: undefined, chats: [] };
    const independentConnection: Connection = {
      id: "independent-edge",
      a: "files-independent",
      b: "chat-window",
      boundRoot: "/independent-folder",
      boundScopeKind: "workspace-root",
    };
    const connections = [connection, independentConnection];
    mocks.state.workspaceResult = workspaceResult(windows, connections, api);
    mocks.fetchChats.mockResolvedValue({ chats: [active] }).mockReturnValueOnce(initial.promise);
    const view = render(<AppShell />);
    await screen.findByTestId("workspace");
    await waitFor(() => expect(mocks.fetchChats).toHaveBeenCalled());
    mocks.state.workspaceResult = workspaceResult(
      [{ ...windows[0]!, cfg: { root: "/intermediate-root" } }, ...windows.slice(1)],
      connections,
      api,
    );
    await act(async (): Promise<void> => {
      view.rerender(<AppShell />);
    });
    const nextScope = fileScope("/manual-new");
    const updated = chat({
      connectedScopes: [otherScope, nextScope],
      groundingScopeIdentity: "gsi-v1:" + "b".repeat(64),
      updatedAt: 3,
    });
    mocks.updateChatConnectedScopes.mockResolvedValue({ chat: updated });
    mocks.state.workspaceResult = workspaceResult(
      [
        { ...windows[0]!, cfg: { root: "/manual-new", rootBinding: "coding-repository" } },
        ...windows.slice(1),
      ],
      connections,
      api,
    );
    view.rerender(<AppShell />);
    await act(async (): Promise<void> => {
      initial.resolve({ chats: [active] });
    });
    await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalled());
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce();
    const requested = mocks.updateChatConnectedScopes.mock.calls.at(
      -1,
    )?.[1] as ChatConnectedScope[];
    expect(requested.map((scope) => scope.root)).toEqual(["/independent-folder", "/manual-new"]);
    expect(mocks.state.session?.replaceChat).toHaveBeenLastCalledWith(updated);
  });

  it("does not reconnect a Files edge removed while its initial lookup is pending", async (): Promise<void> => {
    const initial = deferred<{ readonly chats: readonly Chat[] }>();
    const api = workspaceApi();
    const windows = [
      win("files", { root: "/manual-old" }),
      win("chat", { chatId: "chat-1", projectPath: "/repo" }, "chat-window"),
    ];
    const edge: Connection = {
      id: "files-edge",
      a: "files-1",
      b: "chat-window",
      boundScopeElided: true,
    };
    mocks.state.session = { ...mocks.state.session!, activeChat: undefined, chats: [] };
    mocks.state.workspaceResult = workspaceResult(windows, [edge], api);
    mocks.fetchChats.mockReturnValueOnce(initial.promise);
    const view = render(<AppShell />);
    await screen.findByTestId("workspace");
    await waitFor(() => expect(mocks.fetchChats).toHaveBeenCalled());
    mocks.state.workspaceResult = workspaceResult(windows, [], api);
    view.rerender(<AppShell />);
    await act(async (): Promise<void> => {
      initial.resolve({ chats: [chat()] });
    });
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(api.updateConnBoundScope).not.toHaveBeenCalled();
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
    vi.mocked(api.add).mockReturnValueOnce("search").mockReturnValueOnce(null);
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });

    openOrFocusSearchWindow(api, "/repo/editor-selected");
    openOrFocusSearchWindow(api, undefined);

    expect(api.add).toHaveBeenNthCalledWith(1, "search", { root: "/repo/editor-selected" });
    expect(api.add).toHaveBeenNthCalledWith(2, "search", { root: undefined });
    expect(api.activateWindow).not.toHaveBeenCalled();
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
    expect(screen.queryByTestId("command-palette")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    expect(screen.queryByTestId("command-palette")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "K", metaKey: true }));
    });
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it("opens workspace commands from the Cmd/Ctrl+Shift+P shell shortcut", async () => {
    await renderMounted();
    expect(screen.queryByTestId("command-palette")).toBeNull();

    const keyboardProps = mocks.useKeyboardShortcuts.mock.calls[0]?.[0] as
      { readonly dispatch?: (commandId: string) => void } | undefined;
    await act(async () => {
      keyboardProps?.dispatch?.("workspace.commands");
    });

    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
  });

  it("keeps shell shortcuts inert while a governed modal owns interaction", async () => {
    await renderMounted();
    const keyboardProps = mocks.useKeyboardShortcuts.mock.calls[0]?.[0] as
      { readonly dispatch?: (commandId: string) => void } | undefined;
    const dispatch = keyboardProps?.dispatch;
    expect(dispatch).toBeTypeOf("function");
    if (dispatch === undefined) throw new Error("keyboard shortcut dispatch is unavailable");
    document.documentElement.dataset.keikoModalOpen = "true";

    await act(async () => {
      dispatch("workspace.commands");
    });

    expect(screen.queryByTestId("command-palette")).toBeNull();
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
