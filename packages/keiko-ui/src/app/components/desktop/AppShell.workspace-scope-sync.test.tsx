import { useCallback, useMemo, useState, type ReactNode, type RefObject } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { Chat, ChatConnectedScope } from "@/lib/types";
import { DEFAULT_GROUNDING_LIMITS } from "@/lib/types";
import type { UseWorkspaceResult } from "./hooks/useWorkspace.types";
import { sanitizePersistedWorkspace } from "./hooks/workspace-persistence";
import { connectedScopeFingerprint } from "./hooks/workspaceScopeIdentity";
import {
  reportClientDiagnostic,
  reportFilesScopeDecision,
  resetClientDiagnosticWriter,
} from "@/lib/client-diagnostics";
import type { AppWindow, Connection } from "./windows/types";
import { FilesWindowSessionHost } from "./widgets/SelectionAwareWorkspaceHosts";
import { registerWindowRender } from "./windows/WindowsRegistry";
import { WindowFrame } from "./windows/WindowFrame";
import { useLinkRevision } from "./hooks/useLinkRevision";
import { nativeFilesChatFixture } from "../../../../../../tests/support/files-chat-native-support";
import {
  usePublishChatWindowRuntime,
  registerChatWindowRuntime,
  chatScopeTransition,
  clearChatScopeTransitions,
  useChatScopeCancellation,
  beginChatScopeTransition,
  chatScopeSourceTransition,
  refuseChatScopeSend,
} from "./windows/chatWindowActivity";
import { notifyWorkspaceFileMutated } from "./widgets/cards/workspace-file-events";

const mocks = vi.hoisted(() => ({
  initialChat: undefined as Chat | undefined,
  serverChat: undefined as Chat | undefined,
  workspace: undefined as UseWorkspaceResult | undefined,
  publishChat: undefined as ((chat: Chat) => void) | undefined,
  fetchChats: vi.fn(),
  fetchHealth: vi.fn(),
  updateChatConnectedScopes: vi.fn(),
  recordReadsContextRelationship: vi.fn(),
  renderFiles: false,
  fetchFilesTree: vi.fn(),
}));

// Use WindowFrame's live cfgRef and immediate pending writes. A captured cfg mock can
// restore a pre-ACK alias when several Files callbacks run in one commit.
registerWindowRender("files", (cfg, ctx) => (
  <FilesWindowSessionHost
    cfg={cfg}
    ctx={ctx}
    root={typeof cfg["root"] === "string" ? cfg["root"] : undefined}
  />
));

function NativeChatRuntime(): ReactNode {
  const chat = mocks.serverChat;
  usePublishChatWindowRuntime(
    "chat-window",
    chat === undefined
      ? undefined
      : {
          conversationId: chat.id,
          projectPath: chat.projectPath,
          connectedScopes: chat.connectedScopes ?? [],
        },
  );
  return null;
}

function currentFilesWindow(): AppWindow {
  const files = mocks.workspace?.wins?.find((win) => win.type === "files");
  if (files === undefined) throw new TypeError("Missing mounted Files window");
  return files;
}

function useTestChatSession(): Record<string, unknown> {
  const [activeChat, setActiveChat] = useState(mocks.initialChat);
  const chats = useMemo(() => (activeChat === undefined ? [] : [activeChat]), [activeChat]);
  const replaceChat = useCallback((chat: Chat): void => setActiveChat(chat), []);
  mocks.publishChat = replaceChat;
  return {
    chats,
    activeChat,
    activeProject: { name: "Search lab", path: "/repo", available: true },
    models: [{ id: "example-chat-model" }],
    loading: false,
    error: undefined,
    noEligibleModels: false,
    selectedModel: "example-chat-model",
    replaceChat,
  };
}

vi.mock("./hooks/useChatSession", () => ({ useChatSession: useTestChatSession }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchChats: mocks.fetchChats,
  fetchHealth: mocks.fetchHealth,
  fetchConfig: vi.fn(async () => ({ effectiveGroundingLimits: DEFAULT_GROUNDING_LIMITS })),
  fetchStartupUpdatePreflight: vi.fn(async () => ({})),
  updateChatConnectedScopes: mocks.updateChatConnectedScopes,
  fetchFilesTree: mocks.fetchFilesTree,
  fetchGitStatus: vi.fn(async (root: string) => ({
    schemaVersion: "1",
    root,
    state: "unavailable",
    available: false,
    reason: "not-a-repository",
    detached: false,
    clean: true,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    changes: [],
    truncated: false,
    maxChanges: 500,
  })),
  fetchFilesPreview: vi.fn(async (root: string, path: string) => ({
    root,
    path,
    name: "one.ts",
    sizeBytes: 34,
    modifiedAt: 1,
    extension: "ts",
    mime: "text/plain",
    symlink: false,
    kind: "text",
    content: "export const validationAlpha = 11;",
    truncated: false,
    maxBytes: 1000,
  })),
}));
vi.mock("@/lib/workspace-manifest-api", async (original) => ({
  ...(await original<typeof import("@/lib/workspace-manifest-api")>()),
  fetchWorkspaceManifestAccess: vi.fn(async () => ({ session: "paired", manifests: [] })),
}));
vi.mock("../../relationships/connector-relationship", () => ({
  recordReadsContextRelationship: mocks.recordReadsContextRelationship,
}));
vi.mock("@/lib/client-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-diagnostics")>()),
  reportClientDiagnostic: vi.fn(),
  reportFilesScopeDecision: vi.fn(),
}));
vi.mock("./install/registerSw", () => ({ registerSw: vi.fn() }));
vi.mock("./context/ChatSessionContext", async (original) => ({
  ...(await original<typeof import("./context/ChatSessionContext")>()),
  ChatSessionProvider: ({ children }: { readonly children: ReactNode }): ReactNode => children,
}));
vi.mock("./hooks/useTheme", () => ({
  useTheme: (): Record<string, unknown> => ({ theme: "dark", toggle: vi.fn() }),
}));
vi.mock("./hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: vi.fn() }));
vi.mock("./hooks/useUndoStack", () => ({
  useUndoStack: (): Record<string, unknown> => ({
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    push: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    clear: vi.fn(),
  }),
}));
vi.mock("./hooks/useActiveWorkspaceState", () => ({
  useActiveWorkspaceState: (): Record<string, unknown> => ({
    instances: [],
    activeBinding: null,
    activeRoot: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("./Header", () => ({ Header: (): ReactNode => <header /> }));
vi.mock("./Footer", () => ({ Footer: (): ReactNode => <footer /> }));
vi.mock("./LeftRail", () => ({ LeftRail: (): ReactNode => <aside /> }));
vi.mock("./RightRail", () => ({ RightRail: (): ReactNode => <aside /> }));
vi.mock("./Workspace", () => ({
  Workspace: ({
    ws,
    wsRef,
  }: {
    readonly ws: UseWorkspaceResult;
    readonly wsRef: RefObject<HTMLDivElement | null>;
  }): ReactNode => {
    mocks.workspace = ws;
    const linkRevision = useLinkRevision(ws.wins, ws.conns);
    return (
      <main ref={wsRef} data-testid="workspace">
        {mocks.renderFiles ? (
          <>
            <NativeChatRuntime />
            <button onPointerDown={(event) => ws.api.startConnect("files-0", event)}>
              Connect Files
            </button>
            <button onPointerDown={(event) => ws.api.confirmConnect("chat-window", event)}>
              Confirm Chat
            </button>
          </>
        ) : null}
        {mocks.renderFiles
          ? ws.wins
              ?.filter((win) => win.type === "files")
              .map((win) => (
                <WindowFrame
                  key={win.id}
                  win={win}
                  top
                  connState={null}
                  linkRevision={linkRevision}
                  api={ws.api}
                  wsRef={wsRef}
                />
              ))
          : (ws.wins?.length ?? 0)}
      </main>
    );
  },
}));
vi.mock("./widgets", () => ({}));
vi.mock("./modals/CommandPalette", () => ({ DesktopCommandPalette: (): ReactNode => null }));
vi.mock("./modals/GatewaySetupDialog", () => ({ GatewaySetupDialog: (): ReactNode => null }));
vi.mock("./modals/NewWindowDialog", () => ({ NewWindowDialog: (): ReactNode => null }));
vi.mock("./modals/Palette", () => ({ Palette: (): ReactNode => null }));
vi.mock("./update/UpdateStartupNotice", () => ({ UpdateStartupNotice: (): ReactNode => null }));

import { AppShell, CHAT_MUTATION_TIMEOUT_MS } from "./AppShell";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete): void => {
    resolve = complete;
  });
  return { promise, resolve };
}

function scope(root: string): ChatConnectedScope {
  return { kind: "workspace-root", relativePaths: [], root, connectedAtMs: 1 };
}
function chat(scopes: readonly ChatConnectedScope[], updatedAt = 1): Chat {
  return {
    id: "chat-1",
    projectPath: "/repo",
    title: "Preserved history",
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    localKnowledgeScope: undefined,
    connectedScopes: scopes,
    connectedScope: scopes[0],
    createdAt: 1,
    updatedAt,
    groundingScopeIdentity: `gsi-v1:${String(updatedAt).padStart(64, "0")}`,
  };
}
function windowRecord(id: string, type: AppWindow["type"], cfg: AppWindow["cfg"]): AppWindow {
  return { id, type, cfg, x: 0, y: 0, w: 400, h: 300, z: 1, max: false, zoom: 1 };
}
function fixture(roots: readonly string[]): {
  readonly wins: AppWindow[];
  readonly conns: Connection[];
} {
  return {
    wins: [
      windowRecord("chat-window", "chat", { chatId: "chat-1", projectPath: "/repo" }),
      ...roots.map((root, i) =>
        windowRecord(`files-${String(i)}`, "files", {
          root,
          resolvedRoot: root,
          rootBinding: "coding-repository",
        }),
      ),
    ],
    conns: roots.map((root, i) => ({
      id: `edge-${String(i)}`,
      a: `files-${String(i)}`,
      b: "chat-window",
      boundChatWindowId: "chat-window",
      boundRoot: root,
      boundScopeKind: "workspace-root",
      boundScopeFingerprint: connectedScopeFingerprint(scope(root)),
    })),
  };
}
function persist(wins: readonly AppWindow[], conns: readonly Connection[]): void {
  window.localStorage.setItem("keiko.workspace.v4", JSON.stringify(wins));
  window.localStorage.setItem("keiko.conns.v1", JSON.stringify(conns));
}
async function storageReplay(
  wins: readonly AppWindow[],
  conns: readonly Connection[],
): Promise<void> {
  const snapshot = sanitizePersistedWorkspace(wins, conns);
  await act(async (): Promise<void> => {
    persist(snapshot.wins, snapshot.conns);
    window.dispatchEvent(new StorageEvent("storage", { key: "keiko.workspace.v4" }));
  });
}

async function mountAmbiguousFiles(
  runtimeOnly = false,
): Promise<{ wins: AppWindow[]; conns: Connection[] }> {
  const initial = fixture(["/manuals/New"]);
  if (runtimeOnly) {
    const chatWindow = initial.wins.find((win) => win.type === "chat");
    if (chatWindow === undefined) throw new TypeError("Missing Chat window");
    delete chatWindow.cfg["chatId"];
  }
  initial.wins.push(windowRecord("unconnected-files", "files", { root: "/unrelated" }));
  const conns: Connection[] = [
    { id: "edge-0", a: "files-0", b: "chat-window", boundScopeElided: true },
  ];
  mocks.initialChat = chat([scope("/manuals/Old")]);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, conns);
  render(<AppShell />);
  await screen.findByText(/cannot be restored uniquely/u);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss workspace notice" }));
  return { wins: initial.wins, conns };
}

beforeEach((): void => {
  resetClientDiagnosticWriter();
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.workspace = undefined;
  mocks.renderFiles = false;
  mocks.fetchHealth.mockResolvedValue({ status: "ok", version: "1.2.3" });
  Object.defineProperty(navigator, "webdriver", { configurable: true, value: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
  mocks.fetchChats.mockImplementation(async () => ({
    chats: mocks.serverChat === undefined ? [] : [mocks.serverChat],
  }));
  mocks.updateChatConnectedScopes.mockImplementation(
    async (
      _id: string,
      scopes: readonly ChatConnectedScope[] | null,
      expectedIdentity?: string,
    ) => {
      if (mocks.updateChatConnectedScopes.mock.calls.length > 8)
        throw new Error("Unexpected repeated scope mutation");
      if (expectedIdentity !== mocks.serverChat?.groundingScopeIdentity)
        throw new ApiError("GROUNDING_SCOPE_CHANGED", "Sources changed", 409);
      mocks.serverChat = chat(scopes ?? [], (mocks.serverChat?.updatedAt ?? 1) + 1);
      return { chat: mocks.serverChat };
    },
  );
});
afterEach((): void => {
  cleanup();
  clearChatScopeTransitions("chat-1");
  resetClientDiagnosticWriter();
  Reflect.deleteProperty(navigator, "webdriver");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type NativeFilesSession = Awaited<ReturnType<typeof nativeFilesChatFixture>>;
type FilesSelection = "file" | "directory" | "keep-folder";

function assertRetiredFolderPreference(selection: FilesSelection): void {
  if (selection !== "keep-folder") return;
  expect(
    mocks.workspace?.wins?.find((win) => win.type === "chat")?.cfg["keepFilesFolder"],
  ).toBeUndefined();
}

async function mountNativeFilesSession(
  native: NativeFilesSession,
  kind: "canonical" | "symlink",
  selection: FilesSelection,
): Promise<void> {
  const selectedRoot = kind === "symlink" ? native.alias : native.root;
  const initial = fixture([selectedRoot]);
  const files = initial.wins.find((win) => win.type === "files");
  const chatWindow = initial.wins.find((win) => win.type === "chat");
  if (files === undefined || chatWindow === undefined)
    throw new TypeError("Missing Files/Chat fixture");
  files.cfg["activeDirectoryPath"] = "Alpha";
  chatWindow.cfg["chatId"] = native.chat.id;
  chatWindow.cfg["projectPath"] = native.root;
  if (selection === "keep-folder") chatWindow.cfg["keepFilesFolder"] = true;
  initial.conns.length = 0;
  mocks.initialChat = (await native.patch(null)).chat;
  mocks.serverChat = mocks.initialChat;
  mocks.renderFiles = true;
  mocks.fetchFilesTree.mockImplementation(native.tree);
  mocks.updateChatConnectedScopes.mockImplementation(async (_id, scopes, identity) => {
    const result = await native.patch(scopes, identity);
    mocks.serverChat = result.chat;
    return result;
  });
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByRole("treeitem", { name: /one\.ts/u });
}

describe("AppShell canonical workspace scope synchronization", () => {
  it("cancels the bound response before a navigation PATCH acknowledgement", async () => {
    const initial = fixture(["/manuals/Old"]);
    mocks.initialChat = chat([scope("/manuals/Old")]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, initial.conns);
    const pending = deferred<{ readonly chat: Chat }>();
    const cancel = vi.fn();
    const release = registerChatWindowRuntime("chat-window", {
      conversationId: "chat-1",
      projectPath: "/repo",
    });
    const cancellation = renderHook(() =>
      useChatScopeCancellation((conversationId): void => {
        if (conversationId === "chat-1") cancel();
      }),
    );
    try {
      render(<AppShell />);
      await screen.findByTestId("workspace");
      await act(async () => {
        await Promise.resolve();
      });
      cancel.mockClear();
      mocks.updateChatConnectedScopes.mockClear();
      mocks.updateChatConnectedScopes.mockReturnValueOnce(pending.promise);
      await act(async () => {
        mocks.workspace?.api.update("files-0", {
          cfg: { root: "/manuals/New", resolvedRoot: "/manuals/New" },
        });
      });
      await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce());
      expect(cancel).toHaveBeenCalledOnce();
      expect(chatScopeTransition("chat-1")).toBe("pending");
      await act(async () => {
        mocks.serverChat = chat([scope("/manuals/New")], 2);
        pending.resolve({ chat: mocks.serverChat });
      });
      await waitFor(() => expect(chatScopeTransition("chat-1")).toBeUndefined());
    } finally {
      pending.resolve({ chat: chat([scope("/manuals/New")], 2) });
      release();
      cancellation.unmount();
    }
  });

  it.each([
    ["canonical", "file"],
    ["symlink", "file"],
    ["canonical", "directory"],
    ["symlink", "directory"],
    ["canonical", "keep-folder"],
    ["symlink", "keep-folder"],
  ] as const)(
    "keeps mounted Files %s/%s scope through canonical ACK and authenticates no sibling",
    async (kind, selection) => {
      const native = await nativeFilesChatFixture();
      try {
        await mountNativeFilesSession(native, kind, selection);
        assertRetiredFolderPreference(selection);
        fireEvent.pointerDown(screen.getByRole("button", { name: "Connect Files" }));
        fireEvent.pointerDown(screen.getByRole("button", { name: "Confirm Chat" }));
        await waitFor(() => expect(mocks.workspace?.conns[0]?.boundScopeKind).toBe("directory"));
        if (selection !== "directory")
          fireEvent.click(await screen.findByRole("treeitem", { name: /one\.ts/u }));
        const expectedKind = selection === "directory" ? "directory" : "files";
        await waitFor(() => expect(mocks.workspace?.conns[0]?.boundScopeKind).toBe(expectedKind));
        await waitFor(() => expect(currentFilesWindow().cfg["root"]).toBe(native.root));
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        });
        const reply = await native.ask();
        expect({
          betaSent: reply.betaSent,
          betaAuthenticated: reply.answer.citations.some(
            (citation) => citation.scopePath === "Beta/two.ts",
          ),
        }).toEqual({ betaSent: false, betaAuthenticated: false });
        expect(reply.answer.citations).toEqual([
          expect.objectContaining({ scopePath: "Alpha/one.ts" }),
        ]);
        expect(mocks.serverChat?.connectedScopes).toEqual([
          expect.objectContaining({
            root: native.root,
            kind: expectedKind,
            relativePaths: [selection === "directory" ? "Alpha" : "Alpha/one.ts"],
          }),
        ]);
        expect(currentFilesWindow().cfg).toMatchObject({
          activeDirectoryPath: "Alpha",
          ...(selection === "directory" ? {} : { activeFilePath: "Alpha/one.ts" }),
        });
        expect(mocks.workspace?.conns[0]?.boundRoot).toBe(native.root);
      } finally {
        cleanup();
        await native.close();
      }
    },
  );
  it("adopts only the attributed canonical PATCH acknowledgement and persists its Files root", async () => {
    const alias = "/var/folders/canonical-ack-proof";
    const canonical = "/private/var/folders/canonical-ack-proof";
    const initial = fixture([alias]);
    mocks.initialChat = chat([scope(canonical)]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, initial.conns);
    mocks.updateChatConnectedScopes.mockImplementation(
      async (_id: string, scopes: readonly ChatConnectedScope[]) => {
        const next = scopes.at(-1);
        if (next === undefined) throw new Error("Missing submitted scope");
        mocks.serverChat = chat([{ ...next, root: canonical }], 2);
        return { chat: mocks.serverChat };
      },
    );
    const mounted = render(<AppShell />);
    await waitFor(() =>
      expect(mocks.workspace?.conns[0]?.boundScopeFingerprint).toBe(
        connectedScopeFingerprint(scope(canonical)),
      ),
    );
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(1);
    expect(mocks.workspace?.wins?.find((w) => w.id === "files-0")?.cfg).toMatchObject({
      root: canonical,
      resolvedRoot: canonical,
    });
    expect(reportFilesScopeDecision).not.toHaveBeenCalledWith(expect.any(String), {
      decision: "ack-missing",
    });
    const persistedWins = mocks.workspace?.wins ?? [];
    const persistedConnections = mocks.workspace?.conns ?? [];
    mounted.unmount();
    mocks.initialChat = mocks.serverChat;
    persist(persistedWins, persistedConnections);
    render(<AppShell />);
    await waitFor(() =>
      expect(mocks.workspace?.wins?.find((w) => w.id === "files-0")?.cfg["root"]).toBe(canonical),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(1);
  });

  it("attributes a canonical alias ACK while preserving an unchanged rootless legacy scope", async () => {
    const alias = "/var/folders/mixed-canonical-ack";
    const canonical = "/private/var/folders/mixed-canonical-ack";
    const legacy: ChatConnectedScope = {
      kind: "files",
      relativePaths: ["docs/legacy.md"],
      connectedAtMs: 17,
    };
    const initial = fixture([alias]);
    mocks.initialChat = chat([scope(canonical), legacy]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, initial.conns);
    mocks.updateChatConnectedScopes.mockImplementation(
      async (_id: string, scopes: readonly ChatConnectedScope[]) => {
        const submitted = scopes.at(-1);
        if (submitted === undefined) throw new Error("Missing submitted scope");
        mocks.serverChat = chat([{ ...submitted, root: canonical }, { ...legacy }], 2);
        return { chat: mocks.serverChat };
      },
    );
    render(<AppShell />);
    await waitFor(() =>
      expect(mocks.workspace?.conns[0]?.boundScopeFingerprint).toBe(
        connectedScopeFingerprint(scope(canonical)),
      ),
    );
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(1);
    expect(mocks.serverChat?.connectedScopes).toHaveLength(2);
    expect(mocks.serverChat?.connectedScopes?.[1]).toEqual(legacy);
    expect(mocks.workspace?.wins?.find((w) => w.id === "files-0")?.cfg["root"]).toBe(canonical);
  });

  it("does not overwrite a Files selection changed while its canonical PATCH acknowledgement is pending", async () => {
    const alias = "/var/folders/pending-canonical-ack";
    const canonical = "/private/var/folders/pending-canonical-ack";
    const changed = "/manuals/NewSelection";
    const initial = fixture([alias]);
    mocks.initialChat = chat([scope(canonical)]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, initial.conns);
    let settle: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    mocks.updateChatConnectedScopes.mockImplementationOnce(
      async (_id: string, scopes: readonly ChatConnectedScope[]) => {
        const submitted = scopes.at(-1);
        if (submitted === undefined) throw new Error("Missing submitted scope");
        await pending;
        mocks.serverChat = chat([{ ...submitted, root: canonical }], 2);
        return { chat: mocks.serverChat };
      },
    );
    render(<AppShell />);
    await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce());
    await act(async () => {
      mocks.workspace?.api.update("files-0", { cfg: { root: changed, resolvedRoot: changed } });
    });
    await act(async () => {
      settle?.();
      await pending;
    });
    await waitFor(() =>
      expect(mocks.workspace?.conns[0]?.boundScopeFingerprint).toBe(
        connectedScopeFingerprint(scope(changed)),
      ),
    );
    expect(mocks.workspace?.wins?.find((w) => w.id === "files-0")?.cfg).toMatchObject({
      root: changed,
      resolvedRoot: changed,
    });
    expect(mocks.serverChat?.connectedScopes).toHaveLength(1);
    expect(mocks.serverChat?.connectedScopes?.[0]?.root).toBe(changed);
  });

  it.each(["ambiguous canonical candidate", "changed unrelated scope"] as const)(
    "rejects an alias ACK with %s without changing the Files selection",
    async (failure) => {
      const alias = "/var/folders/rejected-ack";
      const canonical = "/private/var/folders/rejected-ack";
      const unrelated = scope("/manuals/Unrelated");
      const initial = fixture([alias]);
      mocks.initialChat = chat([scope(canonical), unrelated]);
      mocks.serverChat = mocks.initialChat;
      persist(initial.wins, initial.conns);
      mocks.updateChatConnectedScopes.mockImplementationOnce(
        async (_id: string, scopes: readonly ChatConnectedScope[]) => {
          const submitted = scopes.at(-1);
          if (submitted === undefined) throw new Error("Missing submitted scope");
          const accepted = { ...submitted, root: canonical };
          const other =
            failure === "ambiguous canonical candidate"
              ? { ...submitted, root: "/manuals/Other" }
              : { ...unrelated, root: "/manuals/Changed" };
          mocks.serverChat = chat([accepted, other], 2);
          return { chat: mocks.serverChat };
        },
      );
      const mounted = render(<AppShell />);
      await waitFor(() =>
        expect(reportFilesScopeDecision).toHaveBeenCalledWith(expect.any(String), {
          decision: "ack-missing",
        }),
      );
      expect(mocks.workspace?.wins?.find((w) => w.id === "files-0")?.cfg["root"]).toBe(alias);
      expect(mocks.workspace?.conns[0]?.boundScopeFingerprint).toBe(
        connectedScopeFingerprint(scope(alias)),
      );
      mounted.unmount();
    },
  );

  it("shows diagnostic readiness even when the lazy footer renders nothing", async (): Promise<void> => {
    mocks.fetchHealth.mockResolvedValue({
      status: "ok",
      version: "1.2.3",
      diagnostics: {
        readiness: "degraded",
        reasons: ["sink-unwritable"],
        writer: "production-file",
        lostEvents: 1,
      },
    });
    render(<AppShell />);
    await screen.findByText("Error reports may currently be incomplete.");
    expect(mocks.fetchHealth).toHaveBeenCalledOnce();
  });

  it("does not reannounce a dismissed unchanged automatic scope ambiguity on unrelated changes", async () => {
    await mountAmbiguousFiles();
    const initialReports = vi.mocked(reportClientDiagnostic).mock.calls.length;
    mocks.fetchChats.mockClear();
    await act(async () => {
      mocks.workspace?.api.update("unconnected-files", { cfg: { root: "/unrelated/new" } });
    });
    await waitFor(() =>
      expect(
        mocks.workspace?.wins?.find((win) => win.id === "unconnected-files")?.cfg["root"],
      ).toBe("/unrelated/new"),
    );
    expect(mocks.fetchChats).toHaveBeenCalledExactlyOnceWith("/repo", expect.any(String), "chat-1");
    expect(reportFilesScopeDecision).toHaveBeenCalledWith(expect.any(String), {
      decision: "automatic-suppressed",
    });
    expect(screen.queryByText(/cannot be restored uniquely/u)).not.toBeInTheDocument();
    expect(reportClientDiagnostic).toHaveBeenCalledTimes(initialReports);
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(mocks.recordReadsContextRelationship).not.toHaveBeenCalled();
    expect(mocks.workspace?.conns[0]?.boundScopeFingerprint).toBeUndefined();
  });

  it.each(["requested scope", "canonical GSI"] as const)(
    "reports a new automatic ambiguity when %s changes",
    async (change) => {
      await mountAmbiguousFiles();
      const initialReports = vi.mocked(reportClientDiagnostic).mock.calls.length;
      if (change === "canonical GSI") mocks.serverChat = chat([scope("/manuals/Old")], 2);
      await act(async () => {
        if (change === "canonical GSI") mocks.publishChat?.(mocks.serverChat!);
        mocks.workspace?.api.update(
          change === "requested scope" ? "files-0" : "unconnected-files",
          {
            cfg: {
              root: "/manuals/Changed",
              resolvedRoot: "/manuals/Changed",
              rootBinding: "coding-repository",
            },
          },
        );
      });
      await screen.findByText(/cannot be restored uniquely/u);
      expect(vi.mocked(reportClientDiagnostic).mock.calls.length).toBeGreaterThan(initialReports);
      expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
      expect(mocks.recordReadsContextRelationship).not.toHaveBeenCalled();
    },
  );

  it("reannounces a digest-only change that still has multiple ownership candidates", async () => {
    const initial = fixture(["/manuals/New"]);
    const first = scope("/manuals/First");
    const second = scope("/manuals/Second");
    const firstDigest = connectedScopeFingerprint(first);
    const secondDigest = connectedScopeFingerprint(second);
    const conns: Connection[] = [
      {
        id: "edge-0",
        a: "files-0",
        b: "chat-window",
        boundScopeElided: true,
        boundScopeFingerprint: firstDigest,
      },
    ];
    mocks.initialChat = chat([
      first,
      { ...first, connectedAtMs: 2 },
      second,
      { ...second, connectedAtMs: 2 },
    ]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, conns);
    const stringify = vi.spyOn(JSON, "stringify");
    render(<AppShell />);
    await screen.findByText(/cannot be restored uniquely/u);
    expect(vi.mocked(reportFilesScopeDecision)).toHaveBeenCalledWith(expect.any(String), {
      decision: "blocked-ambiguous",
      sourceCount: 4,
      candidateCount: 2,
      bindingFingerprint: firstDigest,
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss workspace notice" }));
    const currentWindows = mocks.workspace!.wins;
    expect(currentWindows).not.toBeNull();
    vi.mocked(reportClientDiagnostic).mockClear();
    vi.mocked(reportFilesScopeDecision).mockClear();
    stringify.mockClear();
    await storageReplay(currentWindows!, [{ ...conns[0]!, boundScopeFingerprint: secondDigest }]);
    await screen.findByText(/cannot be restored uniquely/u);
    expect(vi.mocked(reportFilesScopeDecision)).toHaveBeenCalledWith(expect.any(String), {
      decision: "blocked-ambiguous",
      sourceCount: 4,
      candidateCount: 2,
      bindingFingerprint: secondDigest,
    });
    expect(reportClientDiagnostic).toHaveBeenCalledOnce();
    const rejected = vi
      .mocked(reportFilesScopeDecision)
      .mock.calls.find(([, details]) => details.decision === "blocked-ambiguous");
    expect(rejected).toBeDefined();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ correlationId: rejected![0] }),
    );
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(mocks.recordReadsContextRelationship).not.toHaveBeenCalled();
    const ambiguitySerializations = stringify.mock.calls.filter(
      ([value]) => Array.isArray(value) && value.includes(secondDigest) && value.includes("chat-1"),
    );
    expect(ambiguitySerializations).toHaveLength(1);
  });

  it("refreshes an unchanged local ambiguity before adopting another client's resolved source", async () => {
    await mountAmbiguousFiles();
    mocks.fetchChats.mockClear();
    mocks.serverChat = chat([scope("/manuals/New")], 2);
    await act(async () => {
      mocks.workspace?.api.update("unconnected-files", { cfg: { root: "/unrelated/new" } });
    });
    await waitFor(() =>
      expect(mocks.workspace?.conns[0]?.boundScopeFingerprint).toBe(
        connectedScopeFingerprint(scope("/manuals/New")),
      ),
    );
    expect(mocks.fetchChats).toHaveBeenCalledWith("/repo", expect.any(String), "chat-1");
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(mocks.workspace?.conns[0]?.boundScopeElided).not.toBe(true);
  });

  it("forgets the ambiguity after an edge is removed and recreated", async () => {
    const initial = await mountAmbiguousFiles();
    await act(async () => mocks.workspace?.api.removeConn("edge-0", { unbind: false }));
    await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(0));
    await storageReplay(
      initial.wins.map((win) => ({ ...win, x: win.x + 1 })),
      initial.conns,
    );
    await screen.findByText(/cannot be restored uniquely/u);
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
  });

  it("resets the warning after canonical ownership is successfully restored", async () => {
    const initial = await mountAmbiguousFiles();
    mocks.serverChat = chat([scope("/manuals/New")], 2);
    await act(async () => {
      mocks.publishChat?.(mocks.serverChat!);
    });
    await act(async () =>
      mocks.workspace?.api.update("unconnected-files", { cfg: { root: "/changed" } }),
    );
    await waitFor(() =>
      expect(mocks.workspace?.conns[0]?.boundScopeFingerprint).toBe(
        connectedScopeFingerprint(scope("/manuals/New")),
      ),
    );
    mocks.serverChat = mocks.initialChat;
    await storageReplay(
      initial.wins.map((win) => ({ ...win, x: win.x + 1 })),
      initial.conns,
    );
    await screen.findByText(/cannot be restored uniquely/u);
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(mocks.recordReadsContextRelationship).not.toHaveBeenCalled();
  });

  it("still reports explicit teardown of an unresolved legacy edge after dismissal", async () => {
    await mountAmbiguousFiles();
    vi.mocked(reportClientDiagnostic).mockClear();
    vi.mocked(reportFilesScopeDecision).mockClear();
    await act(async () => mocks.workspace?.api.removeConn("edge-0"));
    await waitFor(() =>
      expect(reportClientDiagnostic).toHaveBeenCalledWith(
        expect.stringContaining("Files scope ownership unavailable"),
        expect.objectContaining({
          correlationId: expect.any(String),
          kind: "other",
          errorKind: "unknown",
          errorEvidence: expect.objectContaining({ errorClass: "Error" }),
        }),
      ),
    );
    const refusal = vi
      .mocked(reportClientDiagnostic)
      .mock.calls.find(([message]) => message.includes("Files scope ownership unavailable"));
    const decision = vi
      .mocked(reportFilesScopeDecision)
      .mock.calls.find(([, meta]) => meta.decision === "blocked-ambiguous");
    if (refusal === undefined || decision === undefined)
      throw new Error("Missing teardown evidence.");
    expect(refusal[1]?.correlationId).toBe(decision[0]);
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "lets the user forget an ambiguous connection without changing chat sources (runtimeOnly=%s)",
    async (runtimeOnly) => {
      const release = runtimeOnly
        ? registerChatWindowRuntime("chat-window", {
            conversationId: "chat-1",
            projectPath: "/repo",
          })
        : (): void => undefined;
      try {
        await mountAmbiguousFiles(runtimeOnly);
        const canonical = mocks.serverChat;
        await act(async () => mocks.workspace?.api.removeConn("edge-0"));
        expect(chatScopeTransition("chat-1")).toBe("failed");
        fireEvent.click(
          await screen.findByRole("button", { name: "Remove connection only; keep chat sources" }),
        );
        await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(0));
        expect(chatScopeTransition("chat-1")).toBeUndefined();
        expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
        expect(mocks.serverChat).toEqual(canonical);
        expect(reportFilesScopeDecision).toHaveBeenCalledWith(expect.any(String), {
          decision: "released",
        });
        expect(screen.queryByText(/cannot be restored uniquely/u)).not.toBeInTheDocument();
      } finally {
        release();
      }
    },
  );

  it("acknowledges an unchanged sanitized storage replay without scope writes or relationships", async (): Promise<void> => {
    const initial = fixture(["/manuals/Scale", "/manuals/Distinct"]);
    mocks.initialChat = chat([scope("/manuals/Scale"), scope("/manuals/Distinct")]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, initial.conns);
    render(<AppShell />);
    await screen.findByTestId("workspace");
    await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(2));
    await storageReplay(
      initial.wins.map((win) => ({ ...win, x: win.x + 1 })),
      initial.conns,
    );
    await waitFor(() => expect(mocks.workspace?.wins?.[0]?.x).toBe(1));
    await waitFor(() =>
      expect(mocks.workspace?.conns.map((edge) => edge.boundRoot)).toEqual([
        "/manuals/Scale",
        "/manuals/Distinct",
      ]),
    );
    expect(reportFilesScopeDecision).toHaveBeenCalledWith(expect.any(String), {
      decision: "acknowledged",
      sourceCount: 2,
      candidateCount: 1,
      bindingFingerprint: connectedScopeFingerprint(scope("/manuals/Scale")),
    });
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(mocks.recordReadsContextRelationship).not.toHaveBeenCalled();
    expect(mocks.serverChat?.connectedScopes).toEqual(mocks.initialChat.connectedScopes);
  });
  it("refreshes a stale tab before replacing its owned root and preserves the second canonical source", async (): Promise<void> => {
    const initial = fixture(["/manuals/Scale"]);
    mocks.initialChat = chat([scope("/manuals/Scale")]);
    mocks.serverChat = chat([scope("/manuals/Scale"), scope("/manuals/Distinct")], 2);
    persist(initial.wins, initial.conns);
    render(<AppShell />);
    await screen.findByTestId("workspace");
    await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(1));
    await act(async (): Promise<void> =>
      mocks.workspace?.api.update("files-0", {
        cfg: {
          root: "/manuals/Changed",
          resolvedRoot: "/manuals/Changed",
          rootBinding: "coding-repository",
        },
      }),
    );
    await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalled());
    expect(mocks.serverChat?.connectedScopes?.map((item) => item.root)).toEqual([
      "/manuals/Distinct",
      "/manuals/Changed",
    ]);
    expect(mocks.serverChat?.title).toBe("Preserved history");
  });
  it("reapplies a root-change intent after one competing canonical source write", async (): Promise<void> => {
    const initial = fixture(["/manuals/Scale"]);
    mocks.initialChat = chat([scope("/manuals/Scale")]);
    mocks.serverChat = chat([scope("/manuals/Scale"), scope("/manuals/Distinct")], 2);
    persist(initial.wins, initial.conns);
    render(<AppShell />);
    await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(1));
    mocks.updateChatConnectedScopes.mockImplementationOnce(async (): Promise<never> => {
      mocks.serverChat = chat(
        [scope("/manuals/Scale"), scope("/manuals/Distinct"), scope("/manuals/OtherTab")],
        3,
      );
      throw new ApiError("GROUNDING_SCOPE_CHANGED", "Sources changed", 409);
    });
    await act(async (): Promise<void> =>
      mocks.workspace?.api.update("files-0", {
        cfg: {
          root: "/manuals/Changed",
          resolvedRoot: "/manuals/Changed",
          rootBinding: "coding-repository",
        },
      }),
    );
    await waitFor(() =>
      expect(mocks.serverChat?.connectedScopes?.map((item) => item.root)).toEqual([
        "/manuals/Distinct",
        "/manuals/OtherTab",
        "/manuals/Changed",
      ]),
    );
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
    expect(mocks.updateChatConnectedScopes.mock.calls.map((call) => call[2])).toEqual([
      chat([], 2).groundingScopeIdentity,
      chat([], 3).groundingScopeIdentity,
    ]);
    expect(mocks.recordReadsContextRelationship).toHaveBeenCalledTimes(1);
    const retry = vi
      .mocked(reportFilesScopeDecision)
      .mock.calls.find((call) => call[1].decision === "conflict-retried");
    expect(retry).toBeDefined();
    expect(mocks.fetchChats.mock.calls.filter((call) => call[1] === retry?.[0])).toHaveLength(2);
    expect(mocks.updateChatConnectedScopes.mock.calls.map((call) => call[3])).toEqual([
      retry?.[0],
      retry?.[0],
    ]);
    expect(JSON.stringify(vi.mocked(reportFilesScopeDecision).mock.calls)).not.toContain(
      "/manuals/",
    );
  });

  it("does not retry an automatic scope superseded while its first write conflicts", async () => {
    const initial = fixture(["/manuals/Scale"]);
    mocks.initialChat = chat([scope("/manuals/Scale")]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, initial.conns);
    render(<AppShell />);
    await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(1));
    let releaseConflict = (): void => undefined;
    const conflict = new Promise<void>((resolve) => {
      releaseConflict = resolve;
    });
    mocks.updateChatConnectedScopes.mockImplementationOnce(async (): Promise<never> => {
      await conflict;
      throw new ApiError("GROUNDING_SCOPE_CHANGED", "Sources changed", 409);
    });
    await act(async () =>
      mocks.workspace?.api.update("files-0", {
        cfg: { root: "/manuals/Intermediate", rootBinding: "coding-repository" },
      }),
    );
    await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce());
    await act(async () =>
      mocks.workspace?.api.update("files-0", {
        cfg: { root: "/manuals/Latest", rootBinding: "coding-repository" },
      }),
    );
    await act(async () => releaseConflict());
    await waitFor(() =>
      expect(mocks.serverChat?.connectedScopes?.map((item) => item.root)).toEqual([
        "/manuals/Latest",
      ]),
    );
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
  });

  it("refuses repeated competing scope writes after one fresh intent retry", async (): Promise<void> => {
    const initial = fixture(["/manuals/Scale"]);
    mocks.initialChat = chat([scope("/manuals/Scale")]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, initial.conns);
    render(<AppShell />);
    await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(1));
    const conflict = async (): Promise<never> => {
      mocks.serverChat = chat(
        [scope("/manuals/Scale"), scope("/manuals/OtherTab")],
        (mocks.serverChat?.updatedAt ?? 1) + 1,
      );
      throw new ApiError("GROUNDING_SCOPE_CHANGED", "Sources changed", 409);
    };
    mocks.updateChatConnectedScopes
      .mockImplementationOnce(conflict)
      .mockImplementationOnce(conflict);
    await act(async (): Promise<void> =>
      mocks.workspace?.api.update("files-0", {
        cfg: { root: "/manuals/Changed", rootBinding: "coding-repository" },
      }),
    );
    await screen.findByText(
      "Keiko could not connect that source. Check that it is still available and try again.",
    );
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
    expect(mocks.serverChat?.connectedScopes?.map((item) => item.root)).toEqual([
      "/manuals/Scale",
      "/manuals/OtherTab",
    ]);
    expect(mocks.recordReadsContextRelationship).not.toHaveBeenCalled();
  });
  it("uses the fresh persisted ownership digest when an older local acknowledgement is absent", async (): Promise<void> => {
    const initial = fixture(["/manuals/Scale"]);
    mocks.initialChat = chat([scope("/manuals/Scale")]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, sanitizePersistedWorkspace(initial.wins, initial.conns).conns);
    render(<AppShell />);
    await waitFor(() => expect(mocks.workspace?.conns[0]?.boundRoot).toBe("/manuals/Scale"));
    const restoreCorrelation = vi
      .mocked(reportFilesScopeDecision)
      .mock.calls.find(([, decision]) => decision.decision === "restored")?.[0];
    expect(restoreCorrelation).toEqual(expect.any(String));
    vi.mocked(reportFilesScopeDecision).mockClear();
    mocks.serverChat = chat([scope("/manuals/Changed")], 2);
    const changed = fixture(["/manuals/Changed"]);
    await storageReplay(
      changed.wins.map((win) => (win.type === "files" ? { ...win, cfg: {} } : win)),
      changed.conns,
    );
    await waitFor(() => expect(mocks.workspace?.conns[0]?.boundScopeElided).toBe(true));
    await act(async (): Promise<void> => mocks.workspace?.api.removeConn("edge-0"));
    await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(0));
    expect(mocks.serverChat?.connectedScopes).toEqual([]);
    expect(reportFilesScopeDecision).toHaveBeenCalledWith(
      expect.any(String),
      {
        decision: "ack-invalidated",
        candidateCount: 1,
        bindingFingerprint: connectedScopeFingerprint(scope("/manuals/Changed")),
      },
      restoreCorrelation,
    );
  });
  it("adopts a changed persisted ownership digest without deleting the former manual source", async (): Promise<void> => {
    const initial = fixture(["/manuals/Scale"]);
    mocks.initialChat = chat([scope("/manuals/Scale")]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, sanitizePersistedWorkspace(initial.wins, initial.conns).conns);
    render(<AppShell />);
    await waitFor(() => expect(mocks.workspace?.conns[0]?.boundRoot).toBe("/manuals/Scale"));
    mocks.serverChat = chat([scope("/manuals/Scale"), scope("/manuals/Changed")], 2);
    const changed = fixture(["/manuals/Changed"]);
    await storageReplay(changed.wins, changed.conns);
    await waitFor(() => expect(mocks.workspace?.conns[0]?.boundRoot).toBe("/manuals/Changed"));
    expect(mocks.serverChat?.connectedScopes?.map((item) => item.root)).toEqual([
      "/manuals/Scale",
      "/manuals/Changed",
    ]);
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
  });
  it("revalidates captured acknowledgement ownership after a pending canonical read", async (): Promise<void> => {
    const initial = fixture(["/manuals/Scale"]);
    mocks.initialChat = chat([scope("/manuals/Scale")]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, sanitizePersistedWorkspace(initial.wins, initial.conns).conns);
    render(<AppShell />);
    await waitFor(() => expect(mocks.workspace?.conns[0]?.boundRoot).toBe("/manuals/Scale"));
    const pending = deferred<{ readonly chats: readonly Chat[] }>();
    mocks.fetchChats.mockClear().mockReturnValueOnce(pending.promise);
    await act(async (): Promise<void> =>
      mocks.workspace?.api.update("files-0", {
        cfg: { root: "/manuals/Changed", rootBinding: "coding-repository" },
      }),
    );
    await waitFor(() => expect(mocks.fetchChats).toHaveBeenCalled());
    mocks.serverChat = chat([scope("/manuals/Scale"), scope("/manuals/Changed")], 2);
    const changed = fixture(["/manuals/Changed"]);
    await storageReplay(changed.wins, changed.conns);
    await act(async (): Promise<void> => pending.resolve({ chats: [mocks.serverChat!] }));
    await waitFor(() => expect(mocks.workspace?.conns[0]?.boundRoot).toBe("/manuals/Changed"));
    expect(mocks.serverChat?.connectedScopes?.map((item) => item.root)).toEqual([
      "/manuals/Scale",
      "/manuals/Changed",
    ]);
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
  });
  it("preserves another tab's newer scopes when stale-turn compensation conflicts", async (): Promise<void> => {
    const initial = fixture(["/manuals/Scale"]);
    mocks.initialChat = chat([scope("/manuals/Scale")]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, initial.conns);
    render(<AppShell />);
    await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(1));
    const pending = deferred<{ readonly chat: Chat }>();
    mocks.updateChatConnectedScopes.mockReturnValueOnce(pending.promise);
    await act(async (): Promise<void> =>
      mocks.workspace?.api.update("files-0", {
        cfg: { root: "/manuals/Changed", rootBinding: "coding-repository" },
      }),
    );
    await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(1));
    await act(async (): Promise<void> =>
      mocks.workspace?.api.update("chat-window", {
        cfg: { chatId: "another-chat", projectPath: "/repo" },
      }),
    );
    mocks.serverChat = chat([scope("/manuals/OtherTab")], 3);
    await act(async (): Promise<void> =>
      pending.resolve({ chat: chat([scope("/manuals/Changed")], 2) }),
    );
    await screen.findByText(
      "Chat grounding recovery failed. Reload the chat before connecting another source.",
    );
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
    expect(mocks.updateChatConnectedScopes.mock.calls[1]?.[2]).toBe(
      chat([], 2).groundingScopeIdentity,
    );
    expect(mocks.serverChat?.connectedScopes?.map((item) => item.root)).toEqual([
      "/manuals/OtherTab",
    ]);
    expect(mocks.recordReadsContextRelationship).not.toHaveBeenCalled();
  });
});

it("retains a displayed file and the other connected root through a background root refresh", async () => {
  const native = await nativeFilesChatFixture();
  try {
    const secondRoot = `${native.root}/Beta`;
    const initial = fixture([native.root, secondRoot]);
    const files = initial.wins.find((win) => win.id === "files-0");
    const target = initial.wins.find((win) => win.type === "chat");
    if (files === undefined || target === undefined) throw new TypeError("Missing fixture windows");
    files.cfg["activeDirectoryPath"] = "Alpha";
    target.cfg["chatId"] = native.chat.id;
    target.cfg["projectPath"] = native.root;
    mocks.initialChat = (await native.patch([scope(native.root), scope(secondRoot)])).chat;
    mocks.serverChat = mocks.initialChat;
    mocks.renderFiles = true;
    const refreshed = deferred<void>();
    let observing = false;
    mocks.fetchFilesTree.mockImplementation(async (root: string, path = "") => {
      const result = await native.tree(root, path);
      if (observing && root === native.root && path === "") refreshed.resolve();
      return result;
    });
    mocks.updateChatConnectedScopes.mockImplementation(async (_id, scopes, identity) => {
      const result = await native.patch(scopes, identity);
      mocks.serverChat = result.chat;
      return result;
    });
    persist(initial.wins, initial.conns);
    render(<AppShell />);
    fireEvent.click(await screen.findByRole("treeitem", { name: /one\.ts/u }));
    await waitFor(() =>
      expect(mocks.serverChat?.connectedScopes).toContainEqual(
        expect.objectContaining({ kind: "files", relativePaths: ["Alpha/one.ts"] }),
      ),
    );
    const before = mocks.serverChat?.connectedScopes;
    observing = true;
    await act(async () => {
      notifyWorkspaceFileMutated(native.root, { relativePath: "README.md" });
      await refreshed.promise;
    });
    expect(currentFilesWindow().cfg["activeFilePath"]).toBe("Alpha/one.ts");
    expect(mocks.serverChat?.connectedScopes).toEqual(before);
    expect(mocks.serverChat?.connectedScopes).toContainEqual(
      expect.objectContaining({ kind: "workspace-root", root: secondRoot }),
    );
  } finally {
    cleanup();
    await native.close();
  }
});

it.each([false, true])(
  "holds first-bind admission before delayed ACK (runtimeOnly=%s)",
  async (runtimeOnly) => {
    const initial = fixture(["/manuals/New"]);
    if (runtimeOnly) {
      const target = initial.wins.find((win) => win.type === "chat");
      if (target === undefined) throw new TypeError("Missing Chat fixture");
      delete target.cfg["chatId"];
    }
    initial.conns.length = 0;
    mocks.initialChat = chat([]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, initial.conns);
    const pending = deferred<{ readonly chat: Chat }>();
    const cancel = vi.fn();
    const release = registerChatWindowRuntime("chat-window", {
      conversationId: "chat-1",
      projectPath: "/repo",
    });
    const cancellation = renderHook(() =>
      useChatScopeCancellation((conversationId): void => {
        if (conversationId === "chat-1") cancel();
      }),
    );
    try {
      render(<AppShell />);
      await screen.findByTestId("workspace");
      mocks.updateChatConnectedScopes.mockReturnValueOnce(pending.promise);
      fireEvent.pointerDown(document.body);
      await act(async () => {
        const event = {
          preventDefault(): void {},
          stopPropagation(): void {},
          button: 0,
        } as unknown as Parameters<NonNullable<typeof mocks.workspace>["api"]["startConnect"]>[1];
        mocks.workspace?.api.startConnect("files-0", event);
      });
      await act(async () => {
        const event = {
          preventDefault(): void {},
          stopPropagation(): void {},
          button: 0,
        } as unknown as Parameters<NonNullable<typeof mocks.workspace>["api"]["confirmConnect"]>[1];
        mocks.workspace?.api.confirmConnect("chat-window", event);
      });
      await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce());
      expect(chatScopeTransition("chat-1")).toBe("pending");
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        mocks.serverChat = chat([scope("/manuals/New")], 2);
        pending.resolve({ chat: mocks.serverChat });
      });
      release();
      cancellation.unmount();
    }
  },
);

it("returning to acknowledged root releases a failed navigation hold", async () => {
  const initial = fixture(["/manuals/Old"]);
  mocks.initialChat = chat([scope("/manuals/Old")]);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  mocks.updateChatConnectedScopes.mockRejectedValueOnce(
    new ApiError("UNAVAILABLE", "Unavailable", 503),
  );
  await act(async () =>
    mocks.workspace?.api.update("files-0", {
      cfg: { root: "/manuals/New", resolvedRoot: "/manuals/New" },
    }),
  );
  await waitFor(() => expect(chatScopeTransition("chat-1")).toBe("failed"));
  await act(async () =>
    mocks.workspace?.api.update("files-0", {
      cfg: { root: "/manuals/Old", resolvedRoot: "/manuals/Old" },
    }),
  );
  expect(mocks.serverChat?.connectedScopes?.[0]?.root).toBe("/manuals/Old");
  expect(chatScopeTransition("chat-1")).toBeUndefined();
});

it("chat switch cannot leave an unreachable source hold on the old conversation", async () => {
  const initial = fixture(["/manuals/Old"]);
  mocks.initialChat = chat([scope("/manuals/Old")]);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  mocks.updateChatConnectedScopes.mockRejectedValueOnce(
    new ApiError("UNAVAILABLE", "Unavailable", 503),
  );
  await act(async () =>
    mocks.workspace?.api.update("files-0", {
      cfg: { root: "/manuals/New", resolvedRoot: "/manuals/New" },
    }),
  );
  await waitFor(() => expect(chatScopeTransition("chat-1")).toBe("failed"));
  await act(async () =>
    mocks.workspace?.api.update("chat-window", { cfg: { chatId: "chat-2", projectPath: "/repo" } }),
  );
  await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(0));
  await act(async () =>
    mocks.workspace?.api.update("chat-window", { cfg: { chatId: "chat-1", projectPath: "/repo" } }),
  );
  expect(mocks.workspace?.conns).toHaveLength(0);
  expect(chatScopeTransition("chat-1")).toBeUndefined();
});

it("retains a detached timeout hold until the underlying compensation settles", async () => {
  const initial = fixture(["/manuals/Old"]);
  mocks.initialChat = chat([scope("/manuals/Old")]);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  const pending = deferred<{ readonly chat: Chat }>();
  const compensation = deferred<{ readonly chat: Chat }>();
  mocks.updateChatConnectedScopes
    .mockReturnValueOnce(pending.promise)
    .mockReturnValueOnce(compensation.promise);
  vi.useFakeTimers();
  try {
    await act(async () =>
      mocks.workspace?.api.update("files-0", {
        cfg: { root: "/manuals/New", resolvedRoot: "/manuals/New" },
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS));
    expect(chatScopeTransition("chat-1")).toBe("failed");
    await act(async () =>
      mocks.workspace?.api.update("chat-window", {
        cfg: { chatId: "chat-2", projectPath: "/repo" },
      }),
    );
    expect(chatScopeTransition("chat-1")).toBe("failed");
    await act(async () => {
      mocks.serverChat = chat([scope("/manuals/New")], 2);
      pending.resolve({ chat: mocks.serverChat });
    });
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
    expect(chatScopeTransition("chat-1")).toBe("failed");
    await act(async () => {
      mocks.serverChat = chat([scope("/manuals/Old")], 3);
      compensation.resolve({ chat: mocks.serverChat });
    });
    expect(chatScopeTransition("chat-1")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

async function auditConnect(filesId = "files-0"): Promise<void> {
  const event = {
    preventDefault(): void {},
    stopPropagation(): void {},
    button: 0,
  } as unknown as Parameters<NonNullable<typeof mocks.workspace>["api"]["startConnect"]>[1];
  await act(async () => {
    mocks.workspace?.api.startConnect(filesId, event);
  });
  await act(async () => {
    mocks.workspace?.api.confirmConnect("chat-window", event);
  });
}

it("recovers the same failed initial binding without orphaning its hold", async () => {
  const initial = fixture(["/manuals/New"]);
  initial.conns.length = 0;
  mocks.initialChat = chat([]);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  fireEvent.pointerDown(document.body);
  mocks.updateChatConnectedScopes.mockRejectedValueOnce(
    new ApiError("UNAVAILABLE", "Unavailable", 503),
  );
  await auditConnect();
  await waitFor(() => expect(chatScopeTransition("chat-1")).toBe("failed"));
  expect(mocks.workspace?.conns).toHaveLength(0);
  await auditConnect();
  await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(1));
  expect(chatScopeTransition("chat-1")).toBeUndefined();
  expect(mocks.serverChat?.connectedScopes?.map((s) => s.root)).toEqual(["/manuals/New"]);
});

it("releases a settled failed initial intent when its Files owner closes", async () => {
  const initial = fixture(["/manuals/New"]);
  initial.conns.length = 0;
  mocks.initialChat = chat([]);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  fireEvent.pointerDown(document.body);
  mocks.updateChatConnectedScopes.mockRejectedValueOnce(
    new ApiError("UNAVAILABLE", "Unavailable", 503),
  );
  await auditConnect();
  await waitFor(() => expect(chatScopeTransition("chat-1")).toBe("failed"));
  await act(async () => mocks.workspace?.api.close("files-0"));
  await waitFor(() =>
    expect(mocks.workspace?.wins?.find((win) => win.id === "files-0")).toBeUndefined(),
  );
  expect(chatScopeTransition("chat-1")).toBeUndefined();
  expect(mocks.serverChat?.connectedScopes).toEqual([]);
});

async function mountDetachedFilesCompensationFailure(
  failedFile?: string,
  canonicalRoot = "/manuals/New",
): Promise<void> {
  const initial = fixture(["/manuals/Old"]);
  initial.wins.push(
    windowRecord("files-1", "files", {
      root: "/manuals/Independent",
      resolvedRoot: "/manuals/Independent",
    }),
  );
  mocks.initialChat = chat([scope("/manuals/Old")]);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  const pending = deferred<{ readonly chat: Chat }>();
  mocks.updateChatConnectedScopes
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new ApiError("UNAVAILABLE", "Unavailable", 503));
  await act(async () =>
    mocks.workspace?.api.update("files-0", {
      cfg: {
        root: "/manuals/New",
        resolvedRoot: "/manuals/New",
        ...(failedFile === undefined ? {} : { activeFilePath: failedFile }),
      },
    }),
  );
  await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce());
  await act(async () =>
    mocks.workspace?.api.update("chat-window", { cfg: { chatId: "chat-2", projectPath: "/repo" } }),
  );
  expect(chatScopeTransition("chat-1")).toBe("pending");
  await act(async () => {
    const submitted = mocks.updateChatConnectedScopes.mock.calls[0]?.[1]?.at(-1);
    if (submitted === undefined) throw new TypeError("Missing original Files request");
    mocks.serverChat = chat([{ ...submitted, root: canonicalRoot }], 2);
    pending.resolve({ chat: mocks.serverChat });
  });
  expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
  expect(chatScopeTransition("chat-1")).toBe("failed");
}

it("retains a detached hold when canonical compensation fails", async () => {
  await mountDetachedFilesCompensationFailure();
});

it.each([true, false])(
  "revalidates restored roots through canonical persistence (accepted=%s)",
  async (accepted) => {
    const initial = fixture(["/manuals/Old"]);
    mocks.initialChat = chat([scope("/manuals/Old")]);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, initial.conns);
    render(<AppShell />);
    await screen.findByTestId("workspace");
    mocks.updateChatConnectedScopes.mockRejectedValueOnce(
      new ApiError("UNAVAILABLE", "Unavailable", 503),
    );
    await act(async () =>
      mocks.workspace?.api.update("files-0", {
        cfg: { root: "/manuals/New", resolvedRoot: "/manuals/New" },
      }),
    );
    await waitFor(() => expect(chatScopeTransition("chat-1")).toBe("failed"));
    mocks.serverChat = chat([scope("/manuals/New")], 2);
    if (!accepted)
      mocks.updateChatConnectedScopes.mockRejectedValueOnce(
        new ApiError("UNAVAILABLE", "Unavailable", 503),
      );
    await act(async () =>
      mocks.workspace?.api.update("files-0", {
        cfg: { root: "/manuals/Old", resolvedRoot: "/manuals/Old" },
      }),
    );
    expect(chatScopeTransition("chat-1")).toBe(accepted ? undefined : "failed");
    expect(mocks.serverChat.connectedScopes?.map((s) => s.root)).toEqual(
      accepted ? ["/manuals/New", "/manuals/Old"] : ["/manuals/New"],
    );
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
  },
);

it("recovers a settled detached compensation failure after verified same-source rebind", async () => {
  await mountDetachedFilesCompensationFailure();
  await act(async () =>
    mocks.workspace?.api.update("chat-window", { cfg: { chatId: "chat-1", projectPath: "/repo" } }),
  );
  fireEvent.pointerDown(document.body);
  const readsBefore = mocks.fetchChats.mock.calls.length;
  await auditConnect();
  await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(1));
  expect(mocks.fetchChats.mock.calls.length).toBeGreaterThan(readsBefore);
  expect(mocks.serverChat?.connectedScopes?.map((scope) => scope.root)).toEqual(["/manuals/New"]);
  expect(chatScopeTransition("chat-1")).toBeUndefined();
});

function assertDetachedRecoveryResult(recovery: string): void {
  expect(mocks.workspace?.conns).toHaveLength(recovery === "lookup-refused" ? 0 : 1);
  if (recovery === "different-file") {
    expect(mocks.workspace?.conns[0]?.boundScopeKind).toBe("files");
    expect(mocks.serverChat?.connectedScopes?.map((scope) => scope.relativePaths)).toEqual([
      ["first.txt"],
      ["selected.txt"],
    ]);
  }
  expect(chatScopeTransition("chat-1")).toBe("failed");
}

it.each([
  "lookup-refused",
  "different-source",
  "different-root",
  "different-file",
  "different-conversation",
])("retains a detached compensation hold after %s rebind", async (recovery) => {
  await mountDetachedFilesCompensationFailure(
    recovery === "different-file" ? "first.txt" : undefined,
  );
  const chatId = recovery === "different-conversation" ? "chat-2" : "chat-1";
  if (chatId === "chat-2") mocks.serverChat = { ...chat([scope("/manuals/New")], 3), id: chatId };
  await act(async () =>
    mocks.workspace?.api.update("chat-window", { cfg: { chatId, projectPath: "/repo" } }),
  );
  if (recovery === "different-root")
    await act(async () =>
      mocks.workspace?.api.update("files-0", {
        cfg: { root: "/manuals/Different", resolvedRoot: "/manuals/Different" },
      }),
    );
  if (recovery === "different-file")
    await act(async () =>
      mocks.workspace?.api.update("files-0", {
        cfg: { root: "/manuals/New", resolvedRoot: "/manuals/New", activeFilePath: "selected.txt" },
      }),
    );
  fireEvent.pointerDown(document.body);
  if (recovery === "lookup-refused")
    mocks.fetchChats.mockRejectedValueOnce(new ApiError("UNAVAILABLE", "Unavailable", 503));
  await auditConnect(recovery === "different-source" ? "files-1" : "files-0");
  assertDetachedRecoveryResult(recovery);
});

async function assertBlockedDetachedRebind(): Promise<void> {
  await act(async () =>
    mocks.workspace?.api.update("chat-window", { cfg: { chatId: "chat-1", projectPath: "/repo" } }),
  );
  fireEvent.pointerDown(document.body);
  await auditConnect();
  expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
  expect(mocks.workspace?.conns).toHaveLength(0);
  expect(chatScopeTransition("chat-1")).toBe("failed");
}

it("blocks detached recovery until the original compensation settles", async () => {
  const initial = fixture(["/manuals/Old"]);
  mocks.initialChat = chat([scope("/manuals/Old")]);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  const pending = deferred<{ readonly chat: Chat }>();
  const compensation = deferred<{ readonly chat: Chat }>();
  mocks.updateChatConnectedScopes
    .mockReturnValueOnce(pending.promise)
    .mockReturnValueOnce(compensation.promise);
  vi.useFakeTimers();
  try {
    await act(async () =>
      mocks.workspace?.api.update("files-0", {
        cfg: { root: "/manuals/New", resolvedRoot: "/manuals/New" },
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(CHAT_MUTATION_TIMEOUT_MS));
    expect(chatScopeTransition("chat-1")).toBe("failed");
    await act(async () =>
      mocks.workspace?.api.update("chat-window", {
        cfg: { chatId: "chat-2", projectPath: "/repo" },
      }),
    );
    expect(chatScopeTransition("chat-1")).toBe("failed");
    await act(async () => {
      mocks.serverChat = chat([scope("/manuals/New")], 2);
      pending.resolve({ chat: mocks.serverChat });
    });
    expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
    expect(chatScopeTransition("chat-1")).toBe("failed");
    await assertBlockedDetachedRebind();
    await act(async () => {
      mocks.serverChat = chat([scope("/manuals/Old")], 3);
      compensation.resolve({ chat: mocks.serverChat });
    });
    expect(chatScopeTransition("chat-1")).toBe("failed");
    await auditConnect();
    expect(chatScopeTransition("chat-1")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it.each(["/private/manuals/New", "/private/manuals/Retargeted"])(
  "reconciles detached canonical alias recovery only for the confirmed target: %s",
  async (canonicalRoot) => {
    const priorCanonical = "/private/manuals/New";
    await mountDetachedFilesCompensationFailure(undefined, priorCanonical);
    await act(async () =>
      mocks.workspace?.api.update("chat-window", {
        cfg: { chatId: "chat-1", projectPath: "/repo" },
      }),
    );
    fireEvent.pointerDown(document.body);
    mocks.updateChatConnectedScopes.mockImplementation(
      async (_id: string, scopes: readonly ChatConnectedScope[] | null) => {
        const normalized = (scopes ?? []).map((item) =>
          item.root === "/manuals/New" ? { ...item, root: canonicalRoot } : item,
        );
        const unique = normalized.filter(
          (item, index) =>
            normalized.findLastIndex(
              (peer) => connectedScopeFingerprint(peer) === connectedScopeFingerprint(item),
            ) === index,
        );
        mocks.serverChat = chat(unique, 3);
        return { chat: mocks.serverChat };
      },
    );
    const readsBefore = mocks.fetchChats.mock.calls.length;
    await auditConnect();
    await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(1));
    expect(mocks.fetchChats.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(mocks.workspace?.conns[0]?.boundScopeFingerprint).toBe(
      connectedScopeFingerprint(scope(canonicalRoot)),
    );
    expect(mocks.workspace?.wins?.find((win) => win.id === "files-0")?.cfg["root"]).toBe(
      canonicalRoot,
    );
    expect(mocks.serverChat?.connectedScopes?.map((item) => item.root)).toEqual(
      canonicalRoot === priorCanonical ? [priorCanonical] : [priorCanonical, canonicalRoot],
    );
    expect(chatScopeTransition("chat-1")).toBe(
      canonicalRoot === priorCanonical ? undefined : "failed",
    );
  },
);

it("releases a failed unbind hold after its owned edge is removed", async () => {
  const initial = fixture(["/manuals/Old"]);
  mocks.initialChat = chat([scope("/manuals/Old")]);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  mocks.updateChatConnectedScopes.mockRejectedValueOnce(
    new ApiError("UNAVAILABLE", "Unavailable", 503),
  );
  await act(async () => mocks.workspace?.api.removeConn("edge-0"));
  await waitFor(() => expect(chatScopeTransition("chat-1")).toBe("failed"));
  expect(mocks.workspace?.conns.some((edge) => edge.id === "edge-0")).toBe(true);
  await act(async () => mocks.workspace?.api.removeConn("edge-0", { unbind: false }));
  await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(0));
  await waitFor(() => expect(chatScopeTransition("chat-1")).toBeUndefined());
  expect(mocks.serverChat?.connectedScopes).toEqual(mocks.initialChat.connectedScopes);
});

function auditActualFirstSubmittedScope(): ChatConnectedScope {
  const scopes = mocks.updateChatConnectedScopes.mock.calls[0]?.[1] as
    readonly ChatConnectedScope[] | undefined;
  const requested = scopes?.at(-1);
  if (requested === undefined) throw new TypeError("Missing actual submitted Files scope");
  return requested;
}

it("initial source-cap refusal leaves no hold without any persistence attempt", async () => {
  const initial = fixture(["/manuals/New"]);
  initial.conns.length = 0;
  const existing = Array.from(
    { length: DEFAULT_GROUNDING_LIMITS.maxConnectedSources },
    (_, index) => scope(`/manuals/Existing${index}`),
  );
  mocks.initialChat = chat(existing);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  fireEvent.pointerDown(document.body);
  await auditConnect();
  expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
  expect(mocks.workspace?.conns).toHaveLength(0);
  expect(mocks.serverChat?.connectedScopes).toEqual(existing);
  expect(vi.mocked(reportFilesScopeDecision).mock.calls.at(-1)?.[1]).toEqual({
    decision: "released",
  });
  expect(reportFilesScopeDecision).not.toHaveBeenCalledWith(expect.any(String), {
    decision: "intent-applied",
  });
  expect(chatScopeTransition("chat-1")).toBeUndefined();
  expect(refuseChatScopeSend("chat-1")).toBeUndefined();
});

it("failed initial-bind compensation survives a same-key retry with refused lookup", async () => {
  const initial = fixture(["/manuals/New"]);
  initial.conns.length = 0;
  mocks.initialChat = chat([]);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  fireEvent.pointerDown(document.body);
  const pending = deferred<{ readonly chat: Chat }>();
  mocks.updateChatConnectedScopes
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new ApiError("UNAVAILABLE", "Unavailable", 503));
  await auditConnect();
  await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledOnce());
  await act(async () =>
    mocks.workspace?.api.update("chat-window", { cfg: { chatId: "chat-2", projectPath: "/repo" } }),
  );
  await act(async () => {
    mocks.serverChat = chat([{ ...auditActualFirstSubmittedScope(), root: "/manuals/New" }], 2);
    pending.resolve({ chat: mocks.serverChat });
  });
  await waitFor(() => expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2));
  expect(chatScopeTransition("chat-1")).toBe("failed");
  await act(async () =>
    mocks.workspace?.api.update("chat-window", { cfg: { chatId: "chat-1", projectPath: "/repo" } }),
  );
  expect(mocks.workspace?.conns).toHaveLength(0);
  mocks.fetchChats.mockRejectedValueOnce(new ApiError("UNAVAILABLE", "Unavailable", 503));
  await auditConnect();
  expect(mocks.updateChatConnectedScopes).toHaveBeenCalledTimes(2);
  expect(mocks.workspace?.conns).toHaveLength(0);
  expect(chatScopeTransition("chat-1")).toBe("failed");
  expect(refuseChatScopeSend("chat-1")).toBe("failed");
});

it.each(["pending", "failed"] as const)(
  "clean source-cap refusal preserves an unrelated %s hold",
  async (state) => {
    const initial = fixture(["/manuals/New"]);
    initial.conns.length = 0;
    const existing = Array.from({ length: DEFAULT_GROUNDING_LIMITS.maxConnectedSources }, (_, i) =>
      scope(`/manuals/Existing${i}`),
    );
    mocks.initialChat = chat(existing);
    mocks.serverChat = mocks.initialChat;
    persist(initial.wins, initial.conns);
    render(<AppShell />);
    await screen.findByTestId("workspace");
    fireEvent.pointerDown(document.body);
    const unrelated = beginChatScopeTransition("chat-1", "unrelated-accepted-write");
    if (state === "failed") unrelated.settle(false);
    await auditConnect();
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(mocks.workspace?.conns).toHaveLength(0);
    expect(chatScopeSourceTransition("chat-1", "bind:chat-window:files-0")).toBeUndefined();
    expect(chatScopeSourceTransition("chat-1", "unrelated-accepted-write")).toBe(state);
    expect(refuseChatScopeSend("chat-1")).toBe(state);
  },
);

it("clean refusal cannot clear a prior pending same-key bind", async () => {
  const initial = fixture(["/manuals/New"]);
  initial.conns.length = 0;
  const existing = Array.from({ length: DEFAULT_GROUNDING_LIMITS.maxConnectedSources }, (_, i) =>
    scope(`/manuals/Existing${i}`),
  );
  mocks.initialChat = chat(existing);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  fireEvent.pointerDown(document.body);
  beginChatScopeTransition("chat-1", "bind:chat-window:files-0");
  await auditConnect();
  expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
  expect(mocks.workspace?.conns).toHaveLength(0);
  expect(chatScopeSourceTransition("chat-1", "bind:chat-window:files-0")).toBe("failed");
  expect(refuseChatScopeSend("chat-1")).toBe("failed");
});

it("obsolete clean refusal cannot settle a newer same-key pending intent", async () => {
  const initial = fixture(["/manuals/New"]);
  initial.conns.length = 0;
  const existing = Array.from({ length: DEFAULT_GROUNDING_LIMITS.maxConnectedSources }, (_, i) =>
    scope(`/manuals/Existing${i}`),
  );
  mocks.initialChat = chat(existing);
  mocks.serverChat = mocks.initialChat;
  persist(initial.wins, initial.conns);
  render(<AppShell />);
  await screen.findByTestId("workspace");
  fireEvent.pointerDown(document.body);
  const lookup = deferred<{ chats: Chat[] }>();
  mocks.fetchChats.mockReturnValueOnce(lookup.promise);
  await auditConnect();
  expect(chatScopeSourceTransition("chat-1", "bind:chat-window:files-0")).toBe("pending");
  const newer = beginChatScopeTransition("chat-1", "bind:chat-window:files-0");
  const snapshot = mocks.serverChat;
  if (snapshot === undefined) throw new TypeError("Missing canonical chat snapshot");
  await act(async () => lookup.resolve({ chats: [snapshot] }));
  expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
  expect(mocks.workspace?.conns).toHaveLength(0);
  expect(chatScopeSourceTransition("chat-1", "bind:chat-window:files-0")).toBe("pending");
  newer.settle(false);
  expect(refuseChatScopeSend("chat-1")).toBe("failed");
});
