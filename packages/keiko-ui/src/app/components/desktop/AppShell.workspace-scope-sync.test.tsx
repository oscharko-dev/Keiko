import { useCallback, useMemo, useState, type ReactNode, type RefObject } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const mocks = vi.hoisted(() => ({
  initialChat: undefined as Chat | undefined,
  serverChat: undefined as Chat | undefined,
  workspace: undefined as UseWorkspaceResult | undefined,
  publishChat: undefined as ((chat: Chat) => void) | undefined,
  fetchChats: vi.fn(),
  fetchHealth: vi.fn(),
  updateChatConnectedScopes: vi.fn(),
  recordReadsContextRelationship: vi.fn(),
}));

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
vi.mock("./context/ChatSessionContext", () => ({
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
    return (
      <main ref={wsRef} data-testid="workspace">
        {ws.wins?.length ?? 0}
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

import { AppShell } from "./AppShell";

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

async function mountAmbiguousFiles(): Promise<{ wins: AppWindow[]; conns: Connection[] }> {
  const initial = fixture(["/manuals/New"]);
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
  resetClientDiagnosticWriter();
  Reflect.deleteProperty(navigator, "webdriver");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppShell canonical workspace scope synchronization", () => {
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
    expect(mocks.fetchChats).not.toHaveBeenCalled();
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
    await act(async () => mocks.workspace?.api.removeConn("edge-0"));
    await waitFor(() =>
      expect(reportClientDiagnostic).toHaveBeenCalledWith(
        expect.stringContaining("Files scope ownership unavailable"),
        undefined,
      ),
    );
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
  });

  it("lets the user forget an ambiguous connection without changing chat sources", async () => {
    await mountAmbiguousFiles();
    const canonical = mocks.serverChat;
    await act(async () => mocks.workspace?.api.removeConn("edge-0"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove connection only; keep chat sources" }),
    );
    await waitFor(() => expect(mocks.workspace?.conns).toHaveLength(0));
    expect(mocks.updateChatConnectedScopes).not.toHaveBeenCalled();
    expect(mocks.serverChat).toEqual(canonical);
    expect(reportFilesScopeDecision).toHaveBeenCalledWith(expect.any(String), {
      decision: "released",
    });
    expect(screen.queryByText(/cannot be restored uniquely/u)).not.toBeInTheDocument();
  });

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
