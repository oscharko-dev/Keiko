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
  readonly onGitChangeUnbind?: (
    chatWindowId: string,
    relationshipId: string,
    target?: ChatUnbindTarget,
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
  updateChatGitChangeScopes: vi.fn(),
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

function recordedFilesScopeDecision(decision: string): CapturedClientDiagnostic | undefined {
  return reportedDiagnostics.find(
    (record) => record.meta?.filesScopeDecision?.decision === decision,
  );
}

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
    correlationId?: string,
  ): Promise<{ readonly chat: Chat }> => {
    const response = (await mocks.updateChatConnectedScopes(
      id,
      scopes,
      expectedIdentity,
      correlationId,
    )) as { readonly chat: Chat };
    mocks.state.canonicalChats.set(id, response.chat);
    return response;
  },
  updateChatLocalKnowledgeScopes: mocks.updateChatLocalKnowledgeScopes,
  updateChatGitChangeScopes: mocks.updateChatGitChangeScopes,
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
  mutationWithTimeout,
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

function rejectScopeMutationConflict(
  _id: string,
  _scopes: readonly unknown[] | null,
  _identity: string | undefined,
  correlationId: string | undefined,
): Promise<never> {
  const error = new ApiError("GROUNDING_SCOPE_CHANGED", "Sources changed", 409);
  if (correlationId !== undefined) error.correlationId = correlationId;
  return Promise.reject(error);
}

function expectSharedMutationCorrelation(calls: readonly (readonly unknown[])[]): unknown {
  const correlationId = calls[0]?.[3];
  expect(correlationId).toEqual(expect.any(String));
  expect(calls.map((call) => call[3])).toEqual(calls.map(() => correlationId));
  return correlationId;
}

function expectedTimeoutDiagnostic(correlationId: unknown): unknown {
  return {
    message: "[keiko] Chat grounding timeout: Error",
    meta: {
      correlationId,
      kind: "other",
      errorKind: "timeout",
      errorEvidence: { errorClass: "Error", frames: [], causeChain: [] },
    },
  };
}

function decisionMetadata(): ClientDiagnosticMeta[] {
  return reportedDiagnostics.flatMap((record) =>
    record.meta?.filesScopeDecision === undefined ? [] : [record.meta],
  );
}

function expectScopeRetry(correlationId: unknown, mutationSurface: string): void {
  expect(
    decisionMetadata().filter((meta) => meta.filesScopeDecision?.decision === "conflict-retried"),
  ).toEqual([
    { correlationId, filesScopeDecision: { decision: "conflict-retried", mutationSurface } },
  ]);
}

function expectQueueRecovery(mutationSurface: string): void {
  const decisions = decisionMetadata();
  expect(decisions.map((meta) => meta.filesScopeDecision)).toEqual([
    { decision: "timeout-blocked", mutationSurface },
    { decision: "timeout-rejected", mutationSurface },
    { decision: "timeout-recovered", mutationSurface, rejectionCount: 1 },
  ]);
  const correlationId = decisions[0]?.correlationId;
  expect(correlationId).toMatch(/^[a-zA-Z0-9._-]{8,128}$/u);
  expect(decisions[2]?.correlationId).toBe(correlationId);
  expect(decisions[1]?.correlationId).not.toBe(correlationId);
  expect(decisions[1]?.parentCorrelationId).toBe(correlationId);
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

function gitScope(relationshipId = "git-rel"): ChatGitChangeScope {
  return {
    kind: "git-change",
    relationshipId,
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

function queuedConnectorMutation(
  action: "bind" | "unbind",
  pending: Promise<void>,
): () => Promise<unknown> {
  const source = capsuleScope("queue-source");
  const initial = chat({ localKnowledgeScopes: action === "unbind" ? [source] : [] });
  mocks.state.session = { ...mocks.state.session!, activeChat: initial, chats: [initial] };
  mocks.updateChatLocalKnowledgeScopes
    .mockImplementationOnce(async () => {
      await pending;
      return {
        chat: chat({ localKnowledgeScopes: action === "bind" ? [source] : [], updatedAt: 3 }),
      };
    })
    .mockResolvedValueOnce({ chat: { ...initial, updatedAt: 4 } });
  return async () => {
    const handler =
      action === "bind"
        ? mocks.state.workspaceOptions?.onConnectorBind
        : mocks.state.workspaceOptions?.onConnectorUnbind;
    return handler?.("chat-window", source);
  };
}

function queuedGitMutation(
  action: "bind" | "unbind",
  pending: Promise<void>,
): () => Promise<unknown> {
  const scope = gitScope();
  const initial = chat({ gitChangeScopes: action === "unbind" ? [scope] : [] });
  mocks.state.session = { ...mocks.state.session!, activeChat: initial, chats: [initial] };
  if (action === "bind") {
    mocks.connectGitChangeToChat.mockImplementationOnce(async () => {
      await pending;
      return { status: "connected", scope };
    });
    return async () =>
      mocks.state.workspaceOptions?.onGitChangeBind?.("chat-window", {
        baseRef: "dev",
        headRef: "feature",
      });
  }
  mocks.updateChatGitChangeScopes
    .mockImplementationOnce(async () => {
      await pending;
      return { chat: chat({ gitChangeScopes: [], updatedAt: 3 }) };
    })
    .mockResolvedValueOnce({ chat: { ...initial, updatedAt: 4 } });
  return async () =>
    mocks.state.workspaceOptions?.onGitChangeUnbind?.("chat-window", scope.relationshipId);
}

type ScopeConflictAction = "connector-bind" | "connector-unbind" | "git-unbind";

function scopeConflictFixture(action: ScopeConflictAction): {
  readonly persist: typeof mocks.updateChatLocalKnowledgeScopes;
  readonly invoke: () => Promise<unknown>;
  readonly surface: "local-knowledge" | "git-change";
} {
  const source = capsuleScope("queue-conflict");
  const initial = chat({
    localKnowledgeScopes: action === "connector-unbind" ? [source] : [],
    gitChangeScopes: [gitScope()],
  });
  mocks.state.session = { ...mocks.state.session!, activeChat: initial, chats: [initial] };
  const handlers = {
    "connector-bind": async (): Promise<unknown> =>
      mocks.state.workspaceOptions?.onConnectorBind?.("chat-window", source),
    "connector-unbind": async (): Promise<unknown> =>
      mocks.state.workspaceOptions?.onConnectorUnbind?.("chat-window", source),
    "git-unbind": async (): Promise<unknown> =>
      mocks.state.workspaceOptions?.onGitChangeUnbind?.("chat-window", "git-rel"),
  };
  return {
    persist:
      action === "git-unbind"
        ? mocks.updateChatGitChangeScopes
        : mocks.updateChatLocalKnowledgeScopes,
    invoke: handlers[action],
    surface: action === "git-unbind" ? "git-change" : "local-knowledge",
  };
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
    const scope = gitScope();
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

  it("adopts the committed Git response without letting a later failed read reject its connection", async () => {
    const scope = gitScope();
    const committed = chat({
      title: "Concurrent server rename",
      gitChangeScopes: [scope],
      updatedAt: 4,
      groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}`,
    });
    await renderMounted();
    mocks.connectGitChangeToChat.mockResolvedValue({ status: "connected", scope, chat: committed });
    mocks.fetchChats.mockRejectedValue(new TypeError("private read failure"));
    const result = await mocks.state.workspaceOptions?.onGitChangeBind?.("chat-window", {
      baseRef: "dev",
      headRef: "feature",
    });
    expect(result).toEqual(scope);
    expect(mocks.fetchChats).not.toHaveBeenCalled();
    expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(committed);
  });

  it.each(["read-failed", "missing-chat", "missing-scope"] as const)(
    "retains an already committed legacy Git connection when its canonical adoption is %s",
    async (failure) => {
      const scope = gitScope();
      await renderMounted();
      mocks.connectGitChangeToChat.mockResolvedValue({ status: "connected", scope });
      if (failure === "read-failed") mocks.fetchChats.mockRejectedValue(new TypeError("private"));
      else
        mocks.fetchChats.mockResolvedValue({ chats: failure === "missing-chat" ? [] : [chat()] });
      const result = await mocks.state.workspaceOptions?.onGitChangeBind?.("chat-window", {
        baseRef: "dev",
        headRef: "feature",
      });
      expect(result).toEqual(failure === "missing-chat" ? false : scope);
      if (failure === "missing-chat")
        expect(mocks.state.session?.replaceChat).not.toHaveBeenCalled();
      else
        expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "chat-1",
            gitChangeScopes: [scope],
          }),
        );
      expect(mocks.connectGitChangeToChat).toHaveBeenCalledOnce();
    },
  );

  it("renews the Git read deadline after the connection POST commits", async () => {
    const scope = gitScope();
    const posted = deferred<{ status: "connected"; scope: ChatGitChangeScope }>();
    const refreshed = deferred<{ chats: Chat[] }>();
    await renderMounted();
    mocks.connectGitChangeToChat.mockReturnValue(posted.promise);
    mocks.fetchChats.mockReturnValue(refreshed.promise);
    vi.useFakeTimers();
    const binding = mocks.state.workspaceOptions?.onGitChangeBind?.("chat-window", {
      baseRef: "dev",
      headRef: "feature",
    });
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS - 2000);
    await act(async () => posted.resolve({ status: "connected", scope }));
    await vi.advanceTimersByTimeAsync(3000);
    await act(async () =>
      refreshed.resolve({ chats: [chat({ gitChangeScopes: [scope], updatedAt: 4 })] }),
    );
    expect(await binding).toEqual(scope);
    expect(recordedFilesScopeDecision("timeout-blocked")).toBeUndefined();
    const correlation = mocks.connectGitChangeToChat.mock.calls[0]?.[2];
    expect(correlation).toEqual(expect.any(String));
    expect(mocks.fetchChats).toHaveBeenCalledWith("/repo", correlation, "chat-1");
  });

  it("compensates only its committed Git scope when the selected Chat changes during POST", async () => {
    const scope = gitScope();
    const unrelated = gitScope("other-relationship");
    const pending = deferred<{ status: "connected"; scope: ChatGitChangeScope; chat: Chat }>();
    await renderMounted();
    mocks.connectGitChangeToChat.mockReturnValue(pending.promise);
    const canonical = chat({
      gitChangeScopes: [unrelated, scope],
      groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}`,
      updatedAt: 4,
    });
    mocks.fetchChats.mockResolvedValue({ chats: [canonical] });
    mocks.updateChatGitChangeScopes.mockResolvedValueOnce({
      chat: chat({ gitChangeScopes: [unrelated], updatedAt: 5 }),
    });
    let current = true;
    const binding = mocks.state.workspaceOptions?.onGitChangeBind?.(
      "chat-window",
      { baseRef: "dev", headRef: "feature" },
      {
        conversationId: "chat-1",
        projectPath: "/repo",
        isCurrent: () => current,
      },
    );
    await waitFor(() => expect(mocks.connectGitChangeToChat).toHaveBeenCalledOnce());
    current = false;
    await act(async () => pending.resolve({ status: "connected", scope, chat: canonical }));
    expect(await binding).toBe(false);
    const correlation = mocks.connectGitChangeToChat.mock.calls[0]?.[2];
    expect(mocks.updateChatGitChangeScopes).toHaveBeenCalledExactlyOnceWith(
      "chat-1",
      [unrelated],
      canonical.groundingScopeIdentity,
      correlation,
    );
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalledWith(canonical);
  });

  it.each([false, true])(
    "settles a late committed Git connection only after compensation (refused=%s)",
    async (refused) => {
      const scope = gitScope();
      const pending = deferred<{ status: "connected"; scope: ChatGitChangeScope }>();
      const canonical = chat({
        gitChangeScopes: [scope],
        groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}`,
        updatedAt: 3,
      });
      await renderMounted();
      mocks.connectGitChangeToChat.mockReturnValue(pending.promise);
      mocks.fetchChats.mockResolvedValue({ chats: [canonical] });
      if (refused)
        mocks.updateChatGitChangeScopes.mockRejectedValueOnce(
          new TypeError("private-compensation-failure"),
        );
      else
        mocks.updateChatGitChangeScopes.mockResolvedValueOnce({
          chat: chat({ gitChangeScopes: [], updatedAt: 4 }),
        });
      vi.useFakeTimers();
      const invoke = ():
        ReturnType<NonNullable<WorkspaceHookOptions["onGitChangeBind"]>> | undefined =>
        mocks.state.workspaceOptions?.onGitChangeBind?.("chat-window", {
          baseRef: "dev",
          headRef: "feature",
        });
      const binding = invoke();
      await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS + 1);
      expect(await binding).toBe(false);
      await act(async () => pending.resolve({ status: "connected", scope }));
      const correlation = mocks.connectGitChangeToChat.mock.calls[0]?.[2];
      expect(mocks.updateChatGitChangeScopes).toHaveBeenCalledExactlyOnceWith(
        "chat-1",
        null,
        canonical.groundingScopeIdentity,
        correlation,
      );
      if (refused) {
        expect(recordedFilesScopeDecision("timeout-recovered")).toBeUndefined();
        expect(await invoke()).toBe(false);
        expect(mocks.connectGitChangeToChat).toHaveBeenCalledOnce();
        const failure = reportedDiagnostics.find((record) =>
          record.message.includes("Late chat grounding mutation failed"),
        );
        expect(failure?.meta).toMatchObject({
          correlationId: correlation,
          errorKind: "unavailable",
          errorEvidence: { errorClass: "TypeError" },
        });
        expect(JSON.stringify(failure)).not.toContain("private-compensation-failure");
      } else expect(recordedFilesScopeDecision("timeout-recovered")).toBeDefined();
    },
  );

  it("does not load the gateway setup implementation during ordinary shell startup", async () => {
    expect(gatewaySetupLoadsAtShellImport).toBe(0);

    await renderMounted();

    expect(mocks.gatewaySetupDialogModuleLoaded).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Gateway setup" })).toBeNull();
  });

  it.each(["bind", "unbind"] as const)(
    "reapplies the connector %s intent once with the refreshed server identity",
    async (action) => {
      const source = capsuleScope("requested-source");
      const concurrent = capsuleScope("concurrent-source");
      const initial = chat({
        localKnowledgeScopes: action === "unbind" ? [source] : [],
        groundingScopeIdentity: `gsi-v1:${"a".repeat(64)}`,
      });
      const refreshed = chat({
        localKnowledgeScopes: action === "unbind" ? [source, concurrent] : [concurrent],
        groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}`,
        updatedAt: 3,
      });
      const next = action === "bind" ? [concurrent, source] : [concurrent];
      const accepted = chat({
        localKnowledgeScopes: next,
        groundingScopeIdentity: `gsi-v1:${"c".repeat(64)}`,
        updatedAt: 4,
      });
      mocks.state.session = { ...mocks.state.session!, activeChat: initial, chats: [initial] };
      mocks.state.canonicalChats.set(initial.id, refreshed);
      mocks.updateChatLocalKnowledgeScopes
        .mockImplementationOnce(rejectScopeMutationConflict)
        .mockResolvedValueOnce({ chat: accepted });
      await renderMounted();
      const handler =
        action === "bind"
          ? mocks.state.workspaceOptions?.onConnectorBind
          : mocks.state.workspaceOptions?.onConnectorUnbind;
      await expect(handler?.("chat-window", source)).resolves.toBe(true);
      expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenNthCalledWith(
        1,
        initial.id,
        action === "bind" ? [source] : null,
        initial.groundingScopeIdentity,
        expect.any(String),
      );
      expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenNthCalledWith(
        2,
        initial.id,
        next,
        refreshed.groundingScopeIdentity,
        expect.any(String),
      );
      const correlationId = expectSharedMutationCorrelation(
        mocks.updateChatLocalKnowledgeScopes.mock.calls,
      );
      expect(mocks.fetchChats).toHaveBeenCalledWith("/repo", correlationId, initial.id);
      expectScopeRetry(correlationId, "local-knowledge");
      expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(accepted);
    },
  );

  it("does not persist or adopt a conflict refresh after the binding target is superseded", async () => {
    const refreshedRead = deferred<{ readonly chats: readonly Chat[] }>();
    const initial = chat({ groundingScopeIdentity: `gsi-v1:${"a".repeat(64)}` });
    const refreshed = chat({
      groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}`,
      localKnowledgeScopes: [capsuleScope("concurrent-source")],
      updatedAt: 3,
    });
    mocks.state.session = { ...mocks.state.session!, activeChat: initial, chats: [initial] };
    mocks.fetchChats.mockReturnValueOnce(refreshedRead.promise);
    mocks.updateChatLocalKnowledgeScopes.mockRejectedValueOnce(
      new ApiError("GROUNDING_SCOPE_CHANGED", "Sources changed", 409),
    );
    await renderMounted();
    let current = true;
    const binding = mocks.state.workspaceOptions?.onConnectorBind?.(
      "chat-window",
      capsuleScope("requested-source"),
      { conversationId: initial.id, isCurrent: (): boolean => current },
    );
    await waitFor(() => expect(mocks.fetchChats).toHaveBeenCalledOnce());
    current = false;
    refreshedRead.resolve({ chats: [refreshed] });
    await expect(binding).resolves.toBe(false);
    expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenCalledOnce();
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalled();
  });

  it("compensates a superseded connector write with its acknowledged identity", async () => {
    const persisted = deferred<{ readonly chat: Chat }>();
    const initial = chat({ groundingScopeIdentity: `gsi-v1:${"a".repeat(64)}` });
    const source = capsuleScope("requested-source");
    const accepted = chat({
      localKnowledgeScopes: [source],
      groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}`,
      updatedAt: 3,
    });
    mocks.state.session = { ...mocks.state.session!, activeChat: initial, chats: [initial] };
    mocks.updateChatLocalKnowledgeScopes
      .mockReturnValueOnce(persisted.promise)
      .mockResolvedValueOnce({ chat: initial });
    await renderMounted();
    let current = true;
    const binding = mocks.state.workspaceOptions?.onConnectorBind?.("chat-window", source, {
      conversationId: initial.id,
      isCurrent: (): boolean => current,
    });
    await waitFor(() => expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenCalledOnce());
    current = false;
    persisted.resolve({ chat: accepted });
    await expect(binding).resolves.toBe(false);
    expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenNthCalledWith(
      2,
      initial.id,
      null,
      accepted.groundingScopeIdentity,
      expect.any(String),
    );
    const correlationId = mocks.updateChatLocalKnowledgeScopes.mock.calls[0]?.[3];
    expect(correlationId).toEqual(expect.any(String));
    expect(mocks.updateChatLocalKnowledgeScopes.mock.calls[1]?.[3]).toBe(correlationId);
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalled();
  });

  it("reapplies a Git disconnect against the refreshed identity and preserves concurrent comparisons", async () => {
    const source = gitScope();
    const concurrent = gitScope("concurrent-comparison");
    const initial = chat({
      gitChangeScopes: [source],
      groundingScopeIdentity: `gsi-v1:${"a".repeat(64)}`,
    });
    const refreshed = chat({
      gitChangeScopes: [source, concurrent],
      updatedAt: 3,
      groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}`,
    });
    const accepted = chat({
      gitChangeScopes: [concurrent],
      updatedAt: 4,
      groundingScopeIdentity: `gsi-v1:${"c".repeat(64)}`,
    });
    mocks.state.session = { ...mocks.state.session!, activeChat: initial, chats: [initial] };
    mocks.state.canonicalChats.set(initial.id, refreshed);
    mocks.updateChatGitChangeScopes
      .mockImplementationOnce(rejectScopeMutationConflict)
      .mockResolvedValueOnce({ chat: accepted });
    await renderMounted();
    await expect(
      mocks.state.workspaceOptions?.onGitChangeUnbind?.("chat-window", source.relationshipId),
    ).resolves.toBe(true);
    expect(mocks.updateChatGitChangeScopes).toHaveBeenNthCalledWith(
      1,
      initial.id,
      null,
      initial.groundingScopeIdentity,
      expect.any(String),
    );
    expect(mocks.updateChatGitChangeScopes).toHaveBeenNthCalledWith(
      2,
      initial.id,
      [concurrent],
      refreshed.groundingScopeIdentity,
      expect.any(String),
    );
    const correlationId = expectSharedMutationCorrelation(
      mocks.updateChatGitChangeScopes.mock.calls,
    );
    expect(mocks.fetchChats).toHaveBeenCalledWith("/repo", correlationId, initial.id);
    expectScopeRetry(correlationId, "git-change");
    expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(accepted);
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
      undefined,
      expect.any(String),
    );
    expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(updated);
    expect(mocks.recordReadsContextRelationship).toHaveBeenCalledWith(
      "chat-1",
      "/repo",
      mocks.updateChatConnectedScopes.mock.calls[0]?.[3],
    );
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
    const correlationId = expectSharedMutationCorrelation(
      mocks.updateChatConnectedScopes.mock.calls,
    );
    expect(reportedDiagnostics).toEqual([
      {
        message: "[keiko] Chat grounding mutation failed: Error",
        meta: {
          correlationId,
          kind: "other",
          errorKind: "unknown",
          errorEvidence: { errorClass: "Error", frames: [], causeChain: [] },
        },
      },
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
    const correlationId = expectSharedMutationCorrelation(
      mocks.updateChatLocalKnowledgeScopes.mock.calls,
    );
    expect(reportedDiagnostics).toEqual([
      {
        message: "[keiko] Chat grounding mutation failed: Error",
        meta: {
          correlationId,
          kind: "other",
          errorKind: "unknown",
          errorEvidence: { errorClass: "Error", frames: [], causeChain: [] },
        },
      },
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
    expect(mocks.updateChatConnectedScopes).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      null,
      undefined,
      expect.any(String),
    );
    expect(mocks.updateChatConnectedScopes.mock.calls[1]?.[3]).toBe(
      mocks.updateChatConnectedScopes.mock.calls[0]?.[3],
    );
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
    compensation.resolve({ chat: restored });
    await expect(binding).resolves.toBe(false);
    await expect(concurrentBinding).resolves.toBe(true);
    expect(mocks.updateChatConnectedScopes).toHaveBeenNthCalledWith(
      3,
      "chat-1",
      expect.arrayContaining([expect.objectContaining({ root: "/other" })]),
      undefined,
      expect.any(String),
    );
    expect(mocks.state.session?.replaceChat).toHaveBeenCalledWith(concurrent);
    expect(mocks.recordReadsContextRelationship).not.toHaveBeenCalledWith(
      "chat-1",
      "/repo",
      expect.any(String),
    );
    expect(mocks.recordReadsContextRelationship).toHaveBeenCalledWith(
      "chat-1",
      "/other",
      mocks.updateChatConnectedScopes.mock.calls.at(-1)?.[3],
    );
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
      undefined,
      expect.any(String),
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
        undefined,
        expect.any(String),
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
        undefined,
        expect.any(String),
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
    const parentCorrelationId = mocks.fetchChats.mock.calls[0]?.[1];
    expect(parentCorrelationId).toEqual(expect.any(String));
    expect(reportedDiagnostics).toEqual([
      {
        message: "[keiko] Chat lookup failed: ChatLookupFailure",
        meta: {
          correlationId: "scope-lookup-test",
          parentCorrelationId,
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
      undefined,
      expect.any(String),
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
    expect(
      reportedDiagnostics.some(
        (record) => record.meta?.filesScopeDecision?.decision === "timeout-blocked",
      ),
    ).toBe(false);
    await expect(binding).resolves.toBe(true);
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
  });

  it("attributes cross-surface refusals separately and summarizes their exact recovery count", async () => {
    const pending = deferred<{ readonly chat: Chat }>();
    mocks.updateChatConnectedScopes
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ chat: chat({ connectedScopes: [], updatedAt: 4 }) });
    await renderMounted();
    vi.useFakeTimers();
    const actions = mocks.state.workspaceOptions!;
    const binding = actions.onScopeBind?.("chat-window", fileScope("/late"));
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);
    expect(await binding).toBe(false);
    expect(await actions.onConnectorBind?.("chat-window", capsuleScope("refused"))).toBe(false);
    expect(await actions.onGitChangeUnbind?.("chat-window", "refused-comparison")).toBe(false);
    await act(async () => {
      pending.resolve({ chat: chat({ connectedScopes: [fileScope("/late")], updatedAt: 3 }) });
    });
    const decisions = reportedDiagnostics.flatMap((record) =>
      record.meta?.filesScopeDecision === undefined ? [] : [record.meta],
    );
    expect(decisions.map((meta) => meta.filesScopeDecision)).toEqual([
      { decision: "timeout-blocked", mutationSurface: "files" },
      { decision: "timeout-rejected", mutationSurface: "local-knowledge" },
      { decision: "timeout-rejected", mutationSurface: "git-change" },
      { decision: "timeout-recovered", mutationSurface: "files", rejectionCount: 2 },
    ]);
    const parent = decisions[0]?.correlationId;
    expect(parent).toEqual(expect.any(String));
    expect(decisions[3]?.correlationId).toBe(parent);
    expect(decisions.slice(1, 3).map((meta) => meta.parentCorrelationId)).toEqual([parent, parent]);
    expect(new Set(decisions.slice(0, 3).map((meta) => meta.correlationId)).size).toBe(3);
    const failures = reportedDiagnostics.filter((record) => record.meta?.errorKind === "timeout");
    expect(failures.map((record) => record.meta?.correlationId)).toEqual(
      decisions.slice(0, 3).map((meta) => meta.correlationId),
    );
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
  });

  it("attributes a Files refusal to its action when a Knowledge mutation blocks the shared chat", async () => {
    const pending = deferred<void>();
    const invoke = queuedConnectorMutation("bind", pending.promise);
    await renderMounted();
    vi.useFakeTimers();
    const first = invoke();
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);
    expect(await first).toBe(false);
    expect(
      await mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/refused")),
    ).toBe(false);
    await act(async () => pending.resolve());
    const decisions = decisionMetadata();
    expect(decisions.map((meta) => meta.filesScopeDecision)).toEqual([
      { decision: "timeout-blocked", mutationSurface: "local-knowledge" },
      { decision: "timeout-rejected", mutationSurface: "files" },
      { decision: "timeout-recovered", mutationSurface: "local-knowledge", rejectionCount: 1 },
    ]);
    expect(decisions[1]?.correlationId).not.toBe(decisions[0]?.correlationId);
    expect(decisions[1]?.parentCorrelationId).toBe(decisions[0]?.correlationId);
  });

  it("joins an immediate untagged mutation failure to its actual attempt", async () => {
    mocks.updateChatConnectedScopes.mockRejectedValueOnce(new TypeError("private-scope-failure"));
    await renderMounted();
    expect(
      await mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/failed")),
    ).toBe(false);
    const correlationId = mocks.updateChatConnectedScopes.mock.calls[0]?.[3];
    expect(correlationId).toEqual(expect.any(String));
    expect(reportedDiagnostics).toContainEqual({
      message: "[keiko] Chat grounding mutation failed: TypeError",
      meta: {
        correlationId,
        kind: "other",
        errorKind: "unavailable",
        errorEvidence: { errorClass: "TypeError", frames: [], causeChain: [] },
      },
    });
    expect(JSON.stringify(reportedDiagnostics)).not.toContain("private-scope-failure");
  });

  it("retains a late server failure identity and its timeout-attempt parent", async () => {
    const pending = deferred<void>();
    const failure = new ApiError("INTERNAL", "private-server-failure", 500);
    failure.correlationId = "server-failed-request-123";
    mocks.updateChatConnectedScopes.mockImplementationOnce(async () => {
      await pending.promise;
      throw failure;
    });
    await renderMounted();
    vi.useFakeTimers();
    const binding = mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/late"));
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);
    expect(await binding).toBe(false);
    const correlationId = mocks.updateChatConnectedScopes.mock.calls[0]?.[3];
    expect(correlationId).toEqual(expect.any(String));
    expect(reportedDiagnostics).toContainEqual(expectedTimeoutDiagnostic(correlationId));
    await act(async () => pending.resolve());
    expect(recordedFilesScopeDecision("timeout-recovered")?.meta?.correlationId).toBe(
      correlationId,
    );
    expect(reportedDiagnostics).toContainEqual({
      message: "[keiko] Late chat grounding mutation failed: ApiError",
      meta: {
        correlationId: "server-failed-request-123",
        parentCorrelationId: correlationId,
        kind: "other",
        errorKind: "internal",
        errorEvidence: { errorClass: "ApiError", frames: [], causeChain: [] },
      },
    });
    expect(JSON.stringify(reportedDiagnostics)).not.toContain("private-server-failure");
    expect(failure.correlationId).toBe("server-failed-request-123");
  });

  it("keeps an echoed request identity without a self-parent correlation", async () => {
    mocks.updateChatConnectedScopes.mockImplementationOnce(
      async (
        _id: string,
        _scopes: readonly ChatConnectedScope[] | null,
        _identity: string | undefined,
        id: string | undefined,
      ): Promise<never> => {
        const failure = new ApiError("INTERNAL", "private-server-failure", 500);
        if (id !== undefined) failure.correlationId = id;
        throw failure;
      },
    );
    await renderMounted();
    expect(
      await mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/failed")),
    ).toBe(false);
    const correlationId = expectSharedMutationCorrelation(
      mocks.updateChatConnectedScopes.mock.calls,
    );
    expect(reportedDiagnostics).toEqual([
      {
        message: "[keiko] Chat grounding mutation failed: ApiError",
        meta: {
          correlationId,
          kind: "other",
          errorKind: "internal",
          errorEvidence: { errorClass: "ApiError", frames: [], causeChain: [] },
        },
      },
    ]);
  });

  it("joins late failure facts and zero-refusal recovery to the original timeout", async () => {
    const pending = deferred<void>();
    mocks.updateChatConnectedScopes.mockImplementationOnce(async () => {
      await pending.promise;
      throw new TypeError("private-late-failure-canary");
    });
    await renderMounted();
    vi.useFakeTimers();
    const first = mocks.state.workspaceOptions?.onScopeBind?.("chat-window", fileScope("/late"));
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);
    expect(await first).toBe(false);
    await act(async () => pending.resolve());
    const correlationId = recordedFilesScopeDecision("timeout-blocked")?.meta?.correlationId;
    expect(correlationId).toEqual(expect.any(String));
    expect(recordedFilesScopeDecision("timeout-recovered")?.meta).toEqual({
      correlationId,
      filesScopeDecision: {
        decision: "timeout-recovered",
        mutationSurface: "files",
        rejectionCount: 0,
      },
    });
    expect(reportedDiagnostics).toContainEqual({
      message: "[keiko] Late chat grounding mutation failed: TypeError",
      meta: {
        correlationId,
        kind: "other",
        errorKind: "unavailable",
        errorEvidence: { errorClass: "TypeError", frames: [], causeChain: [] },
      },
    });
    expect(JSON.stringify(reportedDiagnostics)).not.toContain("private-late-failure-canary");
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

    expect(mocks.updateChatConnectedScopes).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      null,
      undefined,
      expect.any(String),
    );
    expect(mocks.state.session?.replaceChat).not.toHaveBeenCalledWith(updated);
    expect(mocks.recordReadsContextRelationship).not.toHaveBeenCalledWith(
      "chat-1",
      "/late",
      expect.any(String),
    );
    expect(reportError).not.toHaveBeenCalled();
    const attemptCorrelation = mocks.fetchChats.mock.calls[0]?.[1] as string;
    const rejectedCorrelation = recordedFilesScopeDecision("timeout-rejected")?.meta?.correlationId;
    expect(rejectedCorrelation).toEqual(expect.any(String));
    expect(rejectedCorrelation).not.toBe(attemptCorrelation);
    expect(reportedDiagnostics).toEqual([
      {
        message: "Keiko Files scope ownership decision.",
        meta: {
          correlationId: attemptCorrelation,
          filesScopeDecision: { decision: "timeout-blocked", mutationSurface: "files" },
        },
      },
      expectedTimeoutDiagnostic(attemptCorrelation),
      {
        message: "Keiko Files scope ownership decision.",
        meta: {
          correlationId: rejectedCorrelation,
          parentCorrelationId: attemptCorrelation,
          filesScopeDecision: { decision: "timeout-rejected", mutationSurface: "files" },
        },
      },
      expectedTimeoutDiagnostic(rejectedCorrelation),
      {
        message: "Keiko Files scope ownership decision.",
        meta: {
          correlationId: attemptCorrelation,
          filesScopeDecision: {
            decision: "timeout-recovered",
            mutationSurface: "files",
            rejectionCount: 1,
          },
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

  it("joins connector timeout recovery and the distinct refused attempt through its parent", async () => {
    const persisted = deferred<{ readonly chat: Chat }>();
    const source = capsuleScope("late-capsule");
    mocks.updateChatLocalKnowledgeScopes
      .mockReturnValueOnce(persisted.promise)
      .mockResolvedValueOnce({ chat: chat({ localKnowledgeScopes: [], updatedAt: 4 }) });
    await renderMounted();
    vi.useFakeTimers();
    const bind = mocks.state.workspaceOptions?.onConnectorBind;
    const pending = bind?.("chat-window", source);
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);
    expect(await pending).toBe(false);
    expect(await bind?.("chat-window", capsuleScope("blocked"))).toBe(false);
    await act(async () => {
      persisted.resolve({ chat: chat({ localKnowledgeScopes: [source], updatedAt: 3 }) });
    });
    expectQueueRecovery("local-knowledge");
    expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(decisionMetadata())).not.toContain("late-capsule");
  });

  it.each([
    ["connector", "bind", queuedConnectorMutation, "local-knowledge"],
    ["connector", "unbind", queuedConnectorMutation, "local-knowledge"],
    ["Git", "bind", queuedGitMutation, "git-change"],
    ["Git", "unbind", queuedGitMutation, "git-change"],
  ] as const)(
    "retains the complete %s %s queue lifecycle and refused-action parent",
    async (_kind, action, prepare, surface) => {
      const pending = deferred<void>();
      const invoke = prepare(action, pending.promise);
      await renderMounted();
      vi.useFakeTimers();
      const first = invoke();
      await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);
      expect(await first).toBe(false);
      expect(await invoke()).toBe(false);
      await act(async () => pending.resolve());
      expectQueueRecovery(surface);
    },
  );

  it.each(["connector-bind", "connector-unbind", "git-unbind"] as const)(
    "refuses a second 409 without a third %s attempt",
    async (action) => {
      const { persist, invoke, surface } = scopeConflictFixture(action);
      persist
        .mockImplementationOnce(rejectScopeMutationConflict)
        .mockImplementationOnce(rejectScopeMutationConflict);
      await renderMounted();
      expect(await invoke()).toBe(false);
      expect(persist).toHaveBeenCalledTimes(2);
      expectScopeRetry(expectSharedMutationCorrelation(persist.mock.calls), surface);
      expect(
        reportedDiagnostics.some(
          (record) => record.message === "[keiko] Chat grounding mutation failed: ApiError",
        ),
      ).toBe(true);
    },
  );

  it.each(["connector-bind", "connector-unbind", "git-unbind"] as const)(
    "renews the actual %s deadline after a late scope conflict",
    async (action) => {
      const { persist, invoke, surface } = scopeConflictFixture(action);
      const conflictReady = deferred<void>();
      const persisted = deferred<{ chat: Chat }>();
      persist
        .mockImplementationOnce(async (...args: Parameters<typeof rejectScopeMutationConflict>) => {
          await conflictReady.promise;
          return rejectScopeMutationConflict(...args);
        })
        .mockReturnValueOnce(persisted.promise);
      await renderMounted();
      vi.useFakeTimers();
      const binding = invoke();
      await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS - 1000);
      await act(async () => {
        conflictReady.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(persist).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2000);
      await act(async () => persisted.resolve({ chat: chat({ updatedAt: 4 }) }));
      expect(recordedFilesScopeDecision("timeout-blocked")).toBeUndefined();
      expect(await binding).toBe(true);
      expectScopeRetry(expectSharedMutationCorrelation(persist.mock.calls), surface);
    },
  );

  it("disposes the mutation deadline when the producer throws synchronously", async () => {
    vi.useFakeTimers();
    const failure = new TypeError("Synthetic mutation rejection");
    const timedOut = vi.fn();
    const recovered = vi.fn();
    await expect(
      mutationWithTimeout(
        (): Promise<never> => {
          throw failure;
        },
        timedOut,
        recovered,
        "mutation-sync-123",
      ),
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS);
    expect(timedOut).not.toHaveBeenCalled();
    expect(recovered).not.toHaveBeenCalled();
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

    expect(mocks.updateChatConnectedScopes).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      [scope],
      undefined,
      expect.any(String),
    );
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

    expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      [scope],
      undefined,
      expect.any(String),
    );
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
    const correlationId = expectSharedMutationCorrelation(
      mocks.updateChatConnectedScopes.mock.calls,
    );
    expect(reportedDiagnostics).toEqual([
      {
        message: "[keiko] Chat binding compensation failed: Error",
        meta: {
          correlationId,
          kind: "other",
          errorKind: "unknown",
          errorEvidence: { errorClass: "Error", frames: [], causeChain: [] },
        },
      },
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
    const globalAlert = globalNotice.closest(".source-limit-alert");
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
      undefined,
      expect.any(String),
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
      expect(mocks.updateChatConnectedScopes).toHaveBeenCalledWith(
        privateChat.id,
        null,
        undefined,
        expect.any(String),
      );
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
    expect(mocks.updateChatLocalKnowledgeScopes).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      null,
      undefined,
      expect.any(String),
    );
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
    expect(recordedFilesScopeDecision("restored")?.meta?.filesScopeDecision).toEqual({
      decision: "restored",
      sourceCount: 2,
      candidateCount: 1,
      bindingFingerprint: connectedScopeFingerprint(oldScope),
    });
    await waitFor(() => expect(recordedFilesScopeDecision("acknowledged")).toBeDefined());
    expect(recordedFilesScopeDecision("acknowledged")?.meta?.correlationId).toBe(
      recordedFilesScopeDecision("restored")?.meta?.correlationId,
    );
    expect(JSON.stringify(reportedDiagnostics)).not.toContain("/manuals/");
  });

  it("joins changed Files acknowledgement evidence to the original acknowledgement", async () => {
    const scope = fileScope("/manuals/Scale");
    const active = chat({ connectedScopes: [scope] });
    mocks.state.session = { ...mocks.state.session!, activeChat: active, chats: [active] };
    const next = fileScope("/manuals/Updated");
    mocks.updateChatConnectedScopes.mockResolvedValue({
      chat: chat({ connectedScopes: [next], updatedAt: 4 }),
    });
    const windows = [
      win("files", { root: next.root, rootBinding: "coding-repository" }, "files-owner"),
      win("chat", { chatId: active.id, projectPath: "/repo" }, "chat-owner"),
    ];
    const edge: Connection = {
      id: "owned-edge",
      a: "files-owner",
      b: "chat-owner",
      boundRoot: "/manuals/Scale",
      boundScopeKind: scope.kind,
      boundScopeFingerprint: connectedScopeFingerprint(scope)!,
    };
    mocks.state.workspaceResult = workspaceResult(windows, [edge]);
    const view = render(<AppShell />);
    await waitFor(() => expect(recordedFilesScopeDecision("acknowledged")).toBeDefined());
    const acknowledged = recordedFilesScopeDecision("acknowledged");
    const changed = fileScope("/manuals/New");
    mocks.state.workspaceResult = workspaceResult(windows, [
      {
        ...edge,
        boundRoot: "/manuals/New",
        boundScopeFingerprint: connectedScopeFingerprint(changed)!,
      },
    ]);
    view.rerender(<AppShell />);
    await waitFor(() => expect(recordedFilesScopeDecision("ack-invalidated")).toBeDefined());
    expect(recordedFilesScopeDecision("ack-invalidated")?.meta).toMatchObject({
      parentCorrelationId: acknowledged?.meta?.correlationId,
      filesScopeDecision: { decision: "ack-invalidated", candidateCount: 1 },
    });
    expect(recordedFilesScopeDecision("ack-invalidated")?.meta?.correlationId).not.toBe(
      acknowledged?.meta?.correlationId,
    );
    expect(acknowledged?.meta?.filesScopeDecision).toMatchObject({
      sourceCount: 1,
      candidateCount: 1,
    });
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
    expect(recordedFilesScopeDecision("blocked-ambiguous")?.meta).toEqual({
      correlationId: mocks.fetchChats.mock.calls[0]?.[1],
      filesScopeDecision: { decision: "blocked-ambiguous", sourceCount: 1, candidateCount: 0 },
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Remove connection only; keep chat sources" }));
    expect(mocks.state.workspaceResult?.api.removeConn).toHaveBeenCalledWith("legacy-edge", {
      unbind: false,
    });
    expect(recordedFilesScopeDecision("released")?.meta?.filesScopeDecision).toEqual({
      decision: "released",
    });
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
    expect(recordedFilesScopeDecision("owned-elsewhere")?.meta?.filesScopeDecision).toEqual({
      decision: "owned-elsewhere",
    });
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
    expect(recordedFilesScopeDecision("fingerprint-absent")?.meta).toMatchObject({
      correlationId: mocks.fetchChats.mock.calls[0]?.[1],
      filesScopeDecision: {
        decision: "fingerprint-absent",
        sourceCount: 2,
        candidateCount: 0,
        bindingFingerprint: absent,
      },
    });
    expect(JSON.stringify(reportedDiagnostics)).not.toContain("/removed-from-chat");
  });

  it("records a missing canonical acknowledgement instead of accepting an unproven root", async () => {
    const old = fileScope("/manuals/Scale");
    restoredTeardownFixture(connectedScopeFingerprint(old));
    const workspace = mocks.state.workspaceResult!;
    mocks.state.workspaceResult = workspaceResult(
      (workspace.wins ?? []).map((window) =>
        window.type === "files" ? { ...window, cfg: { root: "/manuals/New" } } : window,
      ),
      workspace.conns,
      workspace.api,
    );
    mocks.updateChatConnectedScopes.mockResolvedValueOnce({
      chat: chat({ connectedScopes: [], updatedAt: 3 }),
    });
    await renderMounted();
    await waitFor(() => expect(recordedFilesScopeDecision("ack-missing")).toBeDefined());
    const missing = recordedFilesScopeDecision("ack-missing");
    expect(missing?.meta).toEqual({
      correlationId: mocks.fetchChats.mock.calls[0]?.[1],
      filesScopeDecision: { decision: "ack-missing" },
    });
    expect(mocks.state.workspaceResult?.api.update).not.toHaveBeenCalled();
    expect(JSON.stringify(missing)).not.toContain("/manuals/");
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
      expect(recordedFilesScopeDecision("released")?.meta).toEqual({
        correlationId: mocks.fetchChats.mock.calls.at(-1)?.[1],
        filesScopeDecision: { decision: "released", sourceCount: 1 },
      });
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
      expect(recordedFilesScopeDecision("blocked-ambiguous")?.meta).toEqual({
        correlationId: mocks.fetchChats.mock.calls.at(-1)?.[1],
        filesScopeDecision: { decision: "blocked-ambiguous", sourceCount: 2, candidateCount: 0 },
      });
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
    const superseded = recordedFilesScopeDecision("request-superseded");
    expect(superseded?.meta?.correlationId).toMatch(/^[a-zA-Z0-9._-]{8,128}$/u);
    expect(superseded?.meta?.filesScopeDecision).toEqual({ decision: "request-superseded" });
    expect(JSON.stringify(superseded)).not.toContain("/intermediate-root");
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
