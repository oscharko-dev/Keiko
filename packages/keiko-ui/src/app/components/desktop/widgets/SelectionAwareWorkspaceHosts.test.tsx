import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ReactNode } from "react";
import type {
  WorkspaceManifest,
  WorkspaceRootDescriptor,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import { WORKSPACE_TRUST_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/workspace-trust";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import type { Chat, ProjectWithAvailability } from "@/lib/types";
import type { WorkspaceManifestView } from "../hooks/useWorkspaceManifest";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import type { EditorWidgetProps } from "./cards/EditorWidget";
import {
  ChatWindowSessionHost,
  executeChatCreationRequest,
  EditorWindowSessionHost,
  FilesWindowSessionHost,
  HOST_CHUNK_FALLBACKS,
  normalizedChatTitle,
  useChatCreationCoordinator,
} from "./SelectionAwareWorkspaceHosts";
import { subText } from "../windows/connectionUtils";
import { chatWindowRuntimeTarget } from "../windows/chatWindowActivity";

const reportClientDiagnosticMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-diagnostics")>()),
  reportClientDiagnostic: reportClientDiagnosticMock,
}));

const addRoot = vi.hoisted(() => vi.fn());
const disposeRoot = vi.hoisted(() => vi.fn());
const manifestRef = vi.hoisted(() => ({ current: null as WorkspaceManifest | null }));
const manifestAccessRef = vi.hoisted(
  () =>
    ({
      current: "available",
    }) as {
      current: WorkspaceManifestView["pathReadAuthority"];
    },
);
const refreshManifest = vi.hoisted(() => vi.fn(async () => undefined));
type UpdateChat = (
  id: string,
  patch: { readonly title: string },
) => Promise<{ readonly chat: Chat }>;
const updateChatMock = vi.hoisted((): Mock<UpdateChat> => vi.fn<UpdateChat>());
type FetchChats = (projectPath: string) => Promise<{ readonly chats: readonly Chat[] }>;
const fetchChatsMock = vi.hoisted((): Mock<FetchChats> => vi.fn<FetchChats>());

vi.mock(
  "@/lib/api",
  (): {
    readonly fetchChats: Mock<FetchChats>;
    readonly updateChat: Mock<UpdateChat>;
  } => ({
    fetchChats: fetchChatsMock,
    updateChat: updateChatMock,
  }),
);

// The mock answers the real `WorkspaceManifestView` shape — `issue` is `"load" | "mutation" | null`,
// and a host that reads `issue === null` must not be told `undefined` by its own test double.
vi.mock("../hooks/useWorkspaceManifest", () => ({
  useWorkspaceManifest: (): WorkspaceManifestView => ({
    manifest: manifestRef.current,
    pathReadAuthority: manifestAccessRef.current,
    loading: false,
    issue: null,
    mutating: false,
    refresh: refreshManifest,
    addRoot,
    removeRoot: vi.fn(async () => true),
    reorderRoots: vi.fn(async () => true),
    focusRoot: vi.fn(async () => true),
  }),
}));

vi.mock("@oscharko-dev/keiko-editor", () => ({
  disposeEditorModelRegistryRoot: (...args: unknown[]) => disposeRoot(...args),
}));

// Minimal chat-session double for ChatWindowSessionHost's own branches (target-missing / found).
// Kept separate from the manifest/editor mocks above because those hosts never call this hook.
const chatSessionState = vi.hoisted(() => ({
  activeChat: undefined as Chat | undefined,
  activeProject: undefined as ProjectWithAvailability | undefined,
  chats: [] as Chat[],
  projects: [] as ProjectWithAvailability[],
  loading: false,
  error: undefined as string | undefined,
  memoryEnabled: true,
  openChat: vi.fn(async (_chat: Chat): Promise<void> => undefined),
  openNewChat: vi.fn(async (): Promise<Chat | undefined> => undefined),
  openProject: vi.fn(async (_project: ProjectWithAvailability): Promise<void> => undefined),
  replaceChat: vi.fn((_chat: Chat): void => undefined),
  setMemoryEnabled: vi.fn((_enabled: boolean): void => undefined),
}));
const defaultOpenNewChat = chatSessionState.openNewChat;
const useChatSessionMock = vi.hoisted(() => vi.fn());
const providedChatSessions = vi.hoisted(() => [] as unknown[]);

vi.mock("../hooks/useChatSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useChatSession")>();
  return { ...actual, useChatSession: (): unknown => useChatSessionMock() };
});

vi.mock("../context/ChatSessionContext", (): object => ({
  ChatSessionProvider: ({
    children,
    value,
  }: {
    readonly children: ReactNode;
    readonly value: unknown;
  }): ReactNode => {
    providedChatSessions.push(value);
    return children;
  },
  useChatSessionContext: (): typeof chatSessionState => chatSessionState,
}));

vi.mock("../ChatWindow", (): { readonly ChatWindow: () => ReactNode } => ({
  ChatWindow: (): ReactNode => <div data-testid="chat-window" />,
}));

// Records the root identity and the reveal triple each mounted editor was handed, so a test can see
// who a targeted request actually reached. The multi-root host mounts inactive roots inside a hidden
// `<Activity>`, so the record — not the DOM — is what proves a root was handed nothing.
const editorProps = vi.hoisted(
  () =>
    [] as {
      root: string | undefined;
      reveal: string;
      workspaceTrustUiAvailable: boolean | undefined;
    }[],
);
// The workspace-change callback each mounted editor was given, so a test can drive the same
// re-homing the real widget performs when it changes its own root.
const editorHandlers = vi.hoisted(() => [] as EditorWidgetProps["onWorkspaceChange"][]);

vi.mock("./cards/EditorWidget", () => ({
  EditorWidget: ({
    root,
    revealLineStart,
    revealLineEnd,
    revealRequestId,
    onWorkspaceChange,
    workspaceTrustUiAvailable,
  }: EditorWidgetProps): ReactNode => {
    const reveal = `${String(revealLineStart ?? "")}:${String(revealLineEnd ?? "")}:${revealRequestId ?? ""}`;
    editorProps.push({ root, reveal, workspaceTrustUiAvailable });
    editorHandlers.push(onWorkspaceChange);
    return <div data-testid={`editor-${root ?? "none"}`}>{reveal}</div>;
  },
}));

vi.mock("../workspace-trust/useWorkspaceTrust", () => ({
  useWorkspaceTrust: (projectId: string) => ({
    status: {
      kind: "workspace-trust-status",
      schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
      projectId,
      trust: "trusted",
      decidedBy: "server",
      reason: "human-grant",
      revision: 1,
    },
  }),
}));

// The real Explorer only needs to expose the root-bar affordance for this test; its own navigation
// behaviour is covered by FilesWidget's suite.
vi.mock("./cards/FilesWidget", () => ({
  FilesWidget: ({ onRootChange }: { readonly onRootChange?: (next: string) => void }): ReactNode =>
    onRootChange === undefined ? (
      <div data-testid="files-without-root-bar" />
    ) : (
      <button type="button" onClick={() => onRootChange("/work")}>
        go up
      </button>
    ),
}));

function root(rootRef: string, canonicalRoot: string): WorkspaceRootDescriptor {
  return {
    rootRef: rootRef as WorkspaceRootRef,
    canonicalRoot,
    displayName: canonicalRoot.slice(1),
    identityDigest: "a".repeat(64) as WorkspaceRootDescriptor["identityDigest"],
    sourceDigest: { outcome: "absent" },
  };
}

function manifestOf(
  workspaceId: string,
  roots: readonly WorkspaceRootDescriptor[],
): WorkspaceManifest {
  return {
    kind: "workspace-manifest",
    schemaVersion: 1,
    manifestRef: "manifest-a" as WorkspaceManifest["manifestRef"],
    manifestDigest: "b".repeat(64) as WorkspaceManifest["manifestDigest"],
    workspaceId,
    revision: 1,
    roots,
    focusedRootRef: roots[0]!.rootRef,
  };
}

function singleRootManifest(canonicalRoot: string): WorkspaceManifest {
  return manifestOf("workspace-a", [root("root-a", canonicalRoot)]);
}

const REPO_A = root("root-a", "/repo-a");
const REPO_B = root("root-b", "/repo-b");
const REPO_C = root("root-c", "/repo-c");
const ONE_ROOT = manifestOf("workspace-a", [REPO_A]);
const TWO_ROOTS = manifestOf("workspace-a", [REPO_A, REPO_B]);
const THREE_ROOTS = manifestOf("workspace-a", [REPO_A, REPO_B, REPO_C]);
const OTHER_WORKSPACE = manifestOf("workspace-b", [root("root-x", "/repo-x")]);

function context(overrides: Partial<WindowRenderContext> = {}): WindowRenderContext {
  return {
    windowId: "window-1",
    activeRoot: null,
    activeBinding: null,
    updateCfg: vi.fn(),
    openEditorFile: vi.fn(),
    openWindow: vi.fn(),
    ...overrides,
  } as unknown as WindowRenderContext;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve, reject): void => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject: (reason?: unknown): void => {
      rejectPromise?.(reason);
    },
    resolve: (value: T): void => {
      resolvePromise?.(value);
    },
  };
}

function chatFixture(id: string, title: string, timestamp: number): Chat {
  return {
    id,
    projectPath: "/repo",
    title,
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

// `boundRoot` is what `resolveBoundRoot` hands the host: the ACTIVE task workspace overrides the
// window's own cfg root (ADR-0090 D4), so the two differ exactly while a binding is in effect.
function editorHost(
  cfg: Record<string, unknown>,
  ctx: WindowRenderContext,
  boundRoot?: string,
): ReactNode {
  const configuredRoot = typeof cfg["root"] === "string" ? cfg["root"] : undefined;
  return (
    <I18nProvider>
      <EditorWindowSessionHost cfg={cfg} ctx={ctx} root={boundRoot ?? configuredRoot} />
    </I18nProvider>
  );
}

// Every distinct reveal triple a root's editor was handed across the whole test, so an assertion can
// say "this root never once saw the request" rather than only "it does not see it right now".
function revealsFor(targetRoot: string): readonly string[] {
  return [
    ...new Set(
      editorProps.filter((entry) => entry.root === targetRoot).map((entry) => entry.reveal),
    ),
  ];
}

// A cfg patch read back from the spy, narrowed rather than asserted: a test that silently reads
// `undefined` off a call that never happened would pass every "is undefined" expectation below.
function lastCfgPatch(ctx: WindowRenderContext): Record<string, unknown> {
  const patch: unknown = vi.mocked(ctx.updateCfg).mock.calls.at(-1)?.[0];
  if (typeof patch !== "object" || patch === null) {
    throw new Error("expected updateCfg to have been called with a patch object");
  }
  return patch as Record<string, unknown>;
}

function cfgPatches(ctx: WindowRenderContext): readonly Record<string, unknown>[] {
  return vi.mocked(ctx.updateCfg).mock.calls.map(([patch]) => patch);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  editorProps.length = 0;
  editorHandlers.length = 0;
  manifestRef.current = null;
  manifestAccessRef.current = "available";
  chatSessionState.openNewChat = defaultOpenNewChat;
  chatSessionState.activeChat = undefined;
  chatSessionState.activeProject = undefined;
  chatSessionState.chats = [];
  chatSessionState.projects = [];
  chatSessionState.loading = false;
  chatSessionState.error = undefined;
  chatSessionState.memoryEnabled = true;
  useChatSessionMock.mockReset();
  useChatSessionMock.mockImplementation(() => chatSessionState);
  providedChatSessions.length = 0;
  fetchChatsMock.mockReset();
  fetchChatsMock.mockResolvedValue({ chats: [] });
});

useChatSessionMock.mockImplementation(() => chatSessionState);
fetchChatsMock.mockResolvedValue({ chats: [] });

describe("EditorWindowSessionHost managed task workspace access", () => {
  it("suppresses workspace-trust presentation for the active managed task root", async () => {
    const activeRoot = "/managed/task";
    const ctx = context({
      activeRoot,
      activeBinding: {
        schemaVersion: "1",
        workspaceId: "ws-managed",
        taskId: "task-managed",
        activeRoot,
        boundSurfaces: ["editor"],
        gitDeliveryRoot: activeRoot,
        editorProjectRoot: activeRoot,
      },
    });

    render(editorHost({ root: "/repo" }, ctx, activeRoot));

    expect(await screen.findByTestId(`editor-${activeRoot}`)).toBeInTheDocument();
    expect(editorProps.at(-1)).toMatchObject({
      root: activeRoot,
      workspaceTrustUiAvailable: false,
    });
  });

  it("renders one calm note and does not mount the editor while the browser is unpaired", () => {
    const activeRoot = "/managed/task";
    manifestAccessRef.current = "unpaired";
    const ctx = context({
      activeRoot,
      activeBinding: {
        schemaVersion: "1",
        workspaceId: "ws-managed",
        taskId: "task-managed",
        activeRoot,
        boundSurfaces: ["editor"],
        gitDeliveryRoot: activeRoot,
        editorProjectRoot: activeRoot,
      },
    });

    render(editorHost({ root: "/repo" }, ctx, activeRoot));

    expect(
      screen.getByRole("note", { name: "Task workspace unavailable in this browser" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId(`editor-${activeRoot}`)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a normal folder usable when only managed workspace authority is unpaired", async () => {
    manifestAccessRef.current = "unpaired";
    render(editorHost({ root: "/repo" }, context()));

    expect(await screen.findByTestId("editor-/repo")).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("offers an explicit retry without clearing the active task workspace", async () => {
    const activeRoot = "/managed/task";
    manifestAccessRef.current = "unavailable";
    const ctx = context({
      activeRoot,
      activeBinding: {
        schemaVersion: "1",
        workspaceId: "ws-managed",
        taskId: "task-managed",
        activeRoot,
        boundSurfaces: ["editor"],
        gitDeliveryRoot: activeRoot,
        editorProjectRoot: activeRoot,
      },
    });
    render(editorHost({}, ctx, activeRoot));

    await userEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(refreshManifest).toHaveBeenCalledOnce();
    expect(ctx.updateCfg).not.toHaveBeenCalled();
  });

  it("renders natural German copy when German is selected", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    const activeRoot = "/managed/task";
    manifestAccessRef.current = "unpaired";
    const ctx = context({
      activeRoot,
      activeBinding: {
        schemaVersion: "1",
        workspaceId: "ws-managed",
        taskId: "task-managed",
        activeRoot,
        boundSurfaces: ["editor"],
        gitDeliveryRoot: activeRoot,
        editorProjectRoot: activeRoot,
      },
    });

    render(editorHost({}, ctx, activeRoot));

    expect(
      screen.getByRole("note", {
        name: "Der Aufgabenarbeitsbereich ist in diesem Browser nicht verfügbar",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Starte Keiko über das Startprogramm neu. Alternativ kannst du oben im Arbeitskontext einen Ordner oder ein Repository auswählen.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut prüfen" })).toBeInTheDocument();
  });
});

// Release-audit F-08: the Files window shares the editor's managed-access gate. Without it, an
// unpaired window targeting the bound managed task-workspace root rendered the raw denials
// ("Git unavailable", "The requested path is excluded from the read surface.") instead of naming
// the real condition — the browser window is not paired (ADR-0141).
describe("FilesWindowSessionHost managed task workspace access (F-08)", () => {
  function filesHost(
    cfg: Record<string, unknown>,
    ctx: WindowRenderContext,
    boundRoot?: string,
  ): ReactNode {
    const configuredRoot = typeof cfg["root"] === "string" ? cfg["root"] : undefined;
    return (
      <I18nProvider>
        <FilesWindowSessionHost cfg={cfg} ctx={ctx} root={boundRoot ?? configuredRoot} />
      </I18nProvider>
    );
  }

  function managedContext(activeRoot: string): WindowRenderContext {
    return context({
      activeRoot,
      activeBinding: {
        schemaVersion: "1",
        workspaceId: "ws-managed",
        taskId: "task-managed",
        activeRoot,
        boundSurfaces: ["editor"],
        gitDeliveryRoot: activeRoot,
        editorProjectRoot: activeRoot,
      },
    });
  }

  it("renders the paired-session note instead of the raw denials while unpaired", () => {
    const activeRoot = "/managed/task";
    manifestAccessRef.current = "unpaired";

    render(filesHost({ root: "/repo" }, managedContext(activeRoot), activeRoot));

    expect(
      screen.getByRole("note", { name: "Task workspace unavailable in this browser" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("files-without-root-bar")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a normal folder's Files window usable while only managed authority is unpaired", async () => {
    manifestAccessRef.current = "unpaired";

    render(filesHost({ root: "/repo" }, context()));

    expect(await screen.findByTestId("files-without-root-bar")).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("offers an explicit recheck of managed access without clearing the window", async () => {
    const activeRoot = "/managed/task";
    manifestAccessRef.current = "unavailable";
    const ctx = managedContext(activeRoot);

    render(filesHost({}, ctx, activeRoot));
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(refreshManifest).toHaveBeenCalledOnce();
    expect(ctx.updateCfg).not.toHaveBeenCalled();
  });
});

// Issue #2621 — the removed-root disposal and the reveal both belong to this host, because it is the
// one layer that is mounted for a single-root AND a multi-root workspace and therefore sees every
// transition between them.
describe("EditorWindowSessionHost removed-root model disposal (#2621)", () => {
  it("disposes the removed root's models when a two-root workspace drops to one", async () => {
    // Regression: the diff lived inside MultiRootEditorHost, whose own branch condition is
    // `roots.length > 1`. Removing one root of two therefore unmounted the component that owned the
    // disposal on the very transition that had to fire it, so the effect never ran against a
    // manifest the removed root was missing from and /repo-b's Monaco models stayed retained.
    const ctx = context();
    manifestRef.current = TWO_ROOTS;
    const view = render(editorHost({ root: "/repo-a" }, ctx));
    await screen.findByTestId("editor-/repo-a");
    expect(disposeRoot).not.toHaveBeenCalled();

    manifestRef.current = ONE_ROOT;
    view.rerender(editorHost({ root: "/repo-a" }, ctx));

    expect(disposeRoot).toHaveBeenCalledTimes(1);
    expect(disposeRoot).toHaveBeenCalledWith("/repo-b", true);
  });

  it("disposes exactly the removed root when a three-root workspace loses one", async () => {
    const ctx = context();
    manifestRef.current = THREE_ROOTS;
    const view = render(editorHost({ root: "/repo-a" }, ctx));
    await screen.findByTestId("editor-/repo-a");

    manifestRef.current = TWO_ROOTS;
    view.rerender(editorHost({ root: "/repo-a" }, ctx));

    // Exactly the departed root — the two survivors keep every model they had open.
    expect(disposeRoot).toHaveBeenCalledTimes(1);
    expect(disposeRoot).toHaveBeenCalledWith("/repo-c", true);
  });

  it("treats the first workspace it ever sees as a baseline, not as a removal", async () => {
    // The production first render has no manifest yet (useWorkspaceManifest starts at null and
    // fetches), so this is the state every real session begins in — and the one every other test
    // here skips by seeding a manifest up front.
    const ctx = context();
    manifestRef.current = null;
    const view = render(editorHost({ root: "/repo-a" }, ctx));
    await screen.findByTestId("editor-/repo-a");

    manifestRef.current = TWO_ROOTS;
    view.rerender(editorHost({ root: "/repo-a" }, ctx));
    expect(disposeRoot).not.toHaveBeenCalled();

    manifestRef.current = ONE_ROOT;
    view.rerender(editorHost({ root: "/repo-a" }, ctx));
    expect(disposeRoot).toHaveBeenCalledTimes(1);
    expect(disposeRoot).toHaveBeenCalledWith("/repo-b", true);
  });

  it("never disposes without proof that a root left the same workspace", async () => {
    // Forced disposal destroys dirty buffers in every window that shares the root, so it needs two
    // manifests of one workspace to compare. Each phase below is a state that looks like a removal
    // from the inside of the diff but is not one.
    const ctx = context();
    manifestRef.current = TWO_ROOTS;
    const view = render(editorHost({ root: "/repo-a" }, ctx));
    await screen.findByTestId("editor-/repo-a");

    // Same manifest again: a re-render is not a removal.
    view.rerender(editorHost({ root: "/repo-a" }, ctx));
    expect(disposeRoot).not.toHaveBeenCalled();

    // A different workspace is navigation, not removal — /repo-a and /repo-b are still open
    // elsewhere and must keep their models. Crossing back is not a removal either.
    manifestRef.current = OTHER_WORKSPACE;
    view.rerender(editorHost({ root: "/repo-x" }, ctx));
    manifestRef.current = TWO_ROOTS;
    view.rerender(editorHost({ root: "/repo-a" }, ctx));
    expect(disposeRoot).not.toHaveBeenCalled();

    // No manifest: loading, a failed load, or a V1 root is absence of evidence, not evidence a root
    // was removed.
    manifestRef.current = null;
    view.rerender(editorHost({ root: "/repo-a" }, ctx));
    expect(disposeRoot).not.toHaveBeenCalled();

    // The last workspace actually observed survives that gap as the baseline, so the removal that
    // becomes visible afterwards is still recognised as one.
    manifestRef.current = ONE_ROOT;
    view.rerender(editorHost({ root: "/repo-a" }, ctx));
    expect(disposeRoot).toHaveBeenCalledTimes(1);
    expect(disposeRoot).toHaveBeenCalledWith("/repo-b", true);
  });
});

describe("EditorWindowSessionHost departed-root retarget (#2747)", (): void => {
  it("retargets a window whose configured root left the workspace", async (): Promise<void> => {
    // The window keeps its root from cfg, not from the manifest, so removing that root left it
    // rendering a root the workspace no longer has — while #2621's disposal force-disposed exactly
    // that root's models underneath it, leaving Monaco bound to a disposed model.
    const ctx = context();
    manifestRef.current = TWO_ROOTS;
    const view = render(
      editorHost(
        {
          root: "/repo-b",
          file: "src/gone.ts",
          revealLineStart: 10,
          revealLineEnd: 12,
          revealRequestId: "reveal-1",
        },
        ctx,
      ),
    );
    await screen.findByTestId("editor-/repo-b");
    expect(ctx.updateCfg).not.toHaveBeenCalled();

    manifestRef.current = ONE_ROOT;
    view.rerender(editorHost({ root: "/repo-b", file: "src/gone.ts" }, ctx));

    const patch = lastCfgPatch(ctx);
    // The focused survivor, and nothing that described the root that left.
    expect(patch["root"]).toBe("/repo-a");
    expect(patch["file"]).toBeUndefined();
    expect(patch["layoutJson"]).toBeUndefined();
    // Both boundaries, not just the id: dropping either one would leave a stale half-range behind.
    expect(patch["revealLineStart"]).toBeUndefined();
    expect(patch["revealLineEnd"]).toBeUndefined();
    expect(patch["revealRequestId"]).toBeUndefined();
    expect(Object.keys(patch)).toEqual(
      expect.arrayContaining([
        "file",
        "openFiles",
        "layoutJson",
        "revealLineStart",
        "revealLineEnd",
        "revealRequestId",
      ]),
    );
  });

  it("leaves cfg alone while an active task-workspace binding overrides it", async (): Promise<void> => {
    // ADR-0090 D4: the bound root wins over cfg, so cfg is dormant and is not what the user sees.
    // The manifest here has already lost `/repo-b`, which is exactly the state the retarget reacts
    // to — rewriting cfg would fight the binding over a root this window is not displaying.
    const ctx = context();
    manifestRef.current = ONE_ROOT;
    render(editorHost({ root: "/repo-b" }, ctx, "/wt/active"));
    await screen.findByTestId("editor-/wt/active");

    expect(ctx.updateCfg).not.toHaveBeenCalled();
  });

  it("falls back to the first root when focus still names the departed one", async (): Promise<void> => {
    // The removed root is often the focused one, and the manifest can still carry that stale focus
    // reference. Retargeting to a root that is not there either would leave the window exactly as
    // broken as before, so the ordered first member is the fallback.
    const ctx = context();
    manifestRef.current = TWO_ROOTS;
    const view = render(editorHost({ root: "/repo-b" }, ctx));
    await screen.findByTestId("editor-/repo-b");

    manifestRef.current = { ...ONE_ROOT, focusedRootRef: REPO_B.rootRef };
    view.rerender(editorHost({ root: "/repo-b" }, ctx));

    const patch = lastCfgPatch(ctx);
    expect(patch["root"]).toBe("/repo-a");
  });

  it("writes nothing when the workspace has no root left to retarget to", async (): Promise<void> => {
    const ctx = context();
    manifestRef.current = TWO_ROOTS;
    const view = render(editorHost({ root: "/repo-b" }, ctx));
    await screen.findByTestId("editor-/repo-b");

    manifestRef.current = { ...ONE_ROOT, roots: [] };
    view.rerender(editorHost({ root: "/repo-b" }, ctx));

    expect(ctx.updateCfg).not.toHaveBeenCalled();
  });

  it("leaves a configured root that is still a member alone", async (): Promise<void> => {
    const ctx = context();
    manifestRef.current = TWO_ROOTS;
    const view = render(editorHost({ root: "/repo-a" }, ctx));
    await screen.findByTestId("editor-/repo-a");

    manifestRef.current = ONE_ROOT;
    view.rerender(editorHost({ root: "/repo-a" }, ctx));

    expect(ctx.updateCfg).not.toHaveBeenCalled();
  });
});

describe("EditorWindowSessionHost reveal targeting (#2621)", () => {
  it("hands a reveal request to the addressed root only", async () => {
    // Regression: the reveal triple was copied into the props EVERY root's editor receives, so a
    // jump-to-line meant for /repo-a was handed to /repo-b as well. Whether that moved a cursor
    // depended on an unrelated render gate; the request must not reach the root in the first place.
    manifestRef.current = TWO_ROOTS;
    const cfg = {
      root: "/repo-a",
      revealLineStart: 7,
      revealLineEnd: 10,
      revealRequestId: "reveal-1",
    };
    const ctx = context();
    const view = render(editorHost(cfg, ctx));
    await screen.findByTestId("editor-/repo-a");
    // The INACTIVE root is mounted inside a hidden `<Activity>`, whose children React prerenders in
    // a deferred pass that is not part of the commit the await above settles on. Nothing here makes
    // React run that pass on its own — a full second of `waitFor` polling does not, and the sibling
    // stayed absent — but it does land on the tree's next render pass. So drive one with the SAME
    // cfg, ctx and manifest (a scenario-preserving repeat render, not a new situation) and await the
    // sibling, making its mount a fact this test establishes instead of one it inherits from however
    // far the scheduler happened to get. Before this, the assertion below failed with `[]` on every
    // shuffle order that ran this test first (#2871).
    view.rerender(editorHost(cfg, ctx));
    await screen.findByTestId("editor-/repo-b");

    expect(revealsFor("/repo-a")).toEqual(["7:10:reveal-1"]);
    // The sibling root is mounted, and it never once saw the request. This stays a proof that the
    // reveal was WITHHELD rather than merely not-yet-rendered, because `revealsFor` returns the
    // root's whole recorded prop history and the two outcomes are different values: a root that
    // never mounted yields `[]` and still fails here; only a root that mounted and was handed an
    // empty triple yields exactly `["::"]`. A root handed the request would yield the triple.
    expect(revealsFor("/repo-b")).toEqual(["::"]);
  });

  it("keeps the reveal on the single editor of a single-root workspace", async () => {
    manifestRef.current = singleRootManifest("/repo-a");
    render(
      editorHost(
        { root: "/repo-a", revealLineStart: 7, revealLineEnd: 10, revealRequestId: "reveal-1" },
        context(),
      ),
    );
    await screen.findByTestId("editor-/repo-a");

    expect(revealsFor("/repo-a")).toEqual(["7:10:reveal-1"]);
  });

  it("withholds a reveal from a bound root that is not its addressee", async () => {
    // The last carrier of the stale-reveal class, and the one an active task workspace opens without
    // any cfg write at all: `ctx.activeRoot` overrides `cfg.root` (ADR-0090 D4), the single-root
    // editor is keyed by that effective root, so switching workspaces remounts it — and the reveal
    // is applied from the Monaco mount wiring, not only when the request id changes. An unaddressed
    // editor therefore replayed a jump-to-line in a different worktree's file.
    const ctx = context();
    manifestRef.current = null;
    const reveal = { revealLineStart: 7, revealLineEnd: 10, revealRequestId: "reveal-1" };
    const view = render(editorHost({ root: "/repo-a", ...reveal }, ctx));
    await screen.findByTestId("editor-/repo-a");
    expect(revealsFor("/repo-a")).toEqual(["7:10:reveal-1"]);

    view.rerender(editorHost({ root: "/repo-a", ...reveal }, ctx, "/wt/b"));
    await screen.findByTestId("editor-/wt/b");

    // The bound root is not what the request was written for, so it never sees it.
    expect(revealsFor("/wt/b")).toEqual(["::"]);
    // And the addressee's own delivery is untouched by the rule.
    expect(revealsFor("/repo-a")).toEqual(["7:10:reveal-1"]);
  });

  it("drops a stale reveal when the single-root editor is re-homed to another root", async () => {
    // The editor applies a reveal from its Monaco mount wiring, and a root change remounts this
    // branch's editor (ADR-0090 D4). Leaving the triple in cfg therefore replayed the line jump in
    // the new root's file, and re-addressed the request to that root — which is exactly the
    // targeting the multi-root branch trusts, so the class had to close where cfg.root is rewritten.
    const ctx = context();
    manifestRef.current = singleRootManifest("/repo-a");
    render(
      editorHost(
        { root: "/repo-a", revealLineStart: 7, revealLineEnd: 10, revealRequestId: "reveal-1" },
        ctx,
      ),
    );
    await screen.findByTestId("editor-/repo-a");

    const onWorkspaceChange = editorHandlers.at(-1);
    expect(onWorkspaceChange).toBeDefined();
    onWorkspaceChange?.({ root: "/repo-b", file: "src/other.ts" });

    const patch = lastCfgPatch(ctx);
    expect(patch["root"]).toBe("/repo-b");
    expect(Object.keys(patch)).toEqual(
      expect.arrayContaining(["revealLineStart", "revealLineEnd", "revealRequestId"]),
    );
    expect(patch["revealRequestId"]).toBeUndefined();
  });

  it("keeps an in-flight reveal across a layout commit that does not change the root", async () => {
    const ctx = context();
    manifestRef.current = singleRootManifest("/repo-a");
    render(
      editorHost(
        { root: "/repo-a", revealLineStart: 7, revealLineEnd: 10, revealRequestId: "reveal-1" },
        ctx,
      ),
    );
    await screen.findByTestId("editor-/repo-a");

    editorHandlers.at(-1)?.({ root: "/repo-a", layoutJson: '{"version":2}' });

    const patch = lastCfgPatch(ctx);
    // The addressee did not change, so the request is still this editor's to act on.
    expect(Object.keys(patch)).not.toContain("revealRequestId");
  });

  it("withholds a reveal whose target root is not a member of the workspace", async () => {
    // `selectedRoot()` falls back to the focused root when cfg names an unknown root. The fallback
    // decides which tab is visible; it must not make that tab the addressee of someone else's jump.
    manifestRef.current = TWO_ROOTS;
    const cfg = {
      root: "/repo-gone",
      revealLineStart: 7,
      revealLineEnd: 10,
      revealRequestId: "reveal-1",
    };
    const ctx = context();
    const view = render(editorHost(cfg, ctx));
    await screen.findByTestId("editor-/repo-a");
    // Same deferred hidden-`<Activity>` prerender as the addressed-root case above: the inactive
    // sibling only mounts on the tree's next render pass, so drive one with unchanged cfg and await
    // it rather than reading whatever the scheduler has done. The assertion below keeps its full
    // strength — `[]` (never mounted) and `["::"]` (mounted, handed nothing) are distinct values, so
    // it still proves the reveal was withheld and not merely undelivered so far.
    view.rerender(editorHost(cfg, ctx));
    await screen.findByTestId("editor-/repo-b");

    expect(revealsFor("/repo-a")).toEqual(["::"]);
    expect(revealsFor("/repo-b")).toEqual(["::"]);
  });
});

describe("ChatWindowSessionHost target missing", () => {
  it("allocates an isolated session for every mounted chat window", async (): Promise<void> => {
    const chatA = chatFixture("chat-a", "Private", 1);
    const chatB = chatFixture("chat-b", "Business", 2);
    const sessionA = {
      ...chatSessionState,
      activeChat: chatA,
      chats: [chatA, chatB],
      openChat: vi.fn(async (): Promise<void> => undefined),
    };
    const sessionB = {
      ...chatSessionState,
      activeChat: chatB,
      chats: [chatA, chatB],
      openChat: vi.fn(async (): Promise<void> => undefined),
    };
    useChatSessionMock.mockReturnValueOnce(sessionA).mockReturnValueOnce(sessionB);

    render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: chatA.id, title: chatA.title }} ctx={context()} />
        <ChatWindowSessionHost cfg={{ chatId: chatB.id, title: chatB.title }} ctx={context()} />
      </I18nProvider>,
    );

    expect(await screen.findAllByTestId("chat-window")).toHaveLength(2);
    expect(useChatSessionMock).toHaveBeenCalledTimes(2);
    expect(providedChatSessions.slice(-2)).toEqual([
      expect.objectContaining({ activeChat: chatA }),
      expect.objectContaining({ activeChat: chatB }),
    ]);
    expect(sessionA.openChat).not.toHaveBeenCalled();
    expect(sessionB.openChat).not.toHaveBeenCalled();
  });

  // The bind is asynchronous, and until this state was named it rendered an unlabeled "Loading…"
  // that a screen reader, an operator and a journey could not tell from a bound chat with an empty
  // transcript. A grounded-ask e2e journey reported a missing composer because of exactly that.
  it("names the binding state instead of rendering an anonymous placeholder", async (): Promise<void> => {
    useChatSessionMock.mockReturnValueOnce({ ...chatSessionState, loading: true });

    render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: "chat-a", title: "Pending" }} ctx={context()} />
      </I18nProvider>,
    );

    const pending = await screen.findByRole("status");
    expect(pending).toHaveAttribute("data-chat-bind", "opening");
    expect(screen.queryByTestId("chat-window")).toBeNull();
  });

  // The DOM marker is live-locator state only. What a customer's support export can reconstruct is
  // the client diagnostic sink, so the binding stage leaves a body-free start line when it appears
  // and a settled line, with the elapsed time and nothing else, when it goes away (#3376 review).
  it("leaves body-free start and settled evidence for the binding stage on the diagnostic sink", async (): Promise<void> => {
    // Pending for the whole test (not only the first render) with the target chat known, so the
    // settlement observed below is the unmount and nothing else — neither a bound window nor a
    // not-found body; the suite-level beforeEach reinstalls the default session.
    const pending = chatFixture("chat-a", "Pending", 1);
    useChatSessionMock.mockImplementation(() => ({
      ...chatSessionState,
      loading: true,
      activeChat: pending,
      chats: [pending],
    }));
    // The previous test's tree is unmounted by the library's own cleanup AFTER the suite's
    // afterEach cleared the mocks, so its settlement line would otherwise be counted here.
    reportClientDiagnosticMock.mockClear();

    const { unmount } = render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: "chat-a", title: "Pending" }} ctx={context()} />
      </I18nProvider>,
    );

    await screen.findByRole("status");
    expect(reportClientDiagnosticMock).toHaveBeenCalledWith(
      expect.stringMatching(/^desktop chat bind #\d+: started$/),
    );
    const settledBefore = reportClientDiagnosticMock.mock.calls.filter(([message]) =>
      /^desktop chat bind #\d+: settled/.test(String(message)),
    );
    expect(settledBefore).toHaveLength(0);

    unmount();

    const messages = reportClientDiagnosticMock.mock.calls.map(([message]) => String(message));
    expect(messages).toContainEqual(
      expect.stringMatching(/^desktop chat bind #\d+: settled after \d+ms$/),
    );
    for (const message of messages) {
      expect(message).not.toContain("chat-a");
      expect(message).not.toContain("Pending");
    }
  });

  // The other side of the boundary: a bound chat with an EMPTY transcript is exactly the state the
  // unlabeled placeholder used to be indistinguishable from, so it must render the window and no
  // binding marker at all.
  it("renders the bound window and no binding placeholder for an empty transcript", async (): Promise<void> => {
    const bound = chatFixture("chat-a", "Bound", 1);
    useChatSessionMock.mockImplementation(() => ({
      ...chatSessionState,
      activeChat: bound,
      chats: [bound],
    }));

    render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: "chat-a", title: "Bound" }} ctx={context()} />
      </I18nProvider>,
    );

    expect(await screen.findByTestId("chat-window")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector("[data-chat-bind]")).toBeNull();
  });

  // The three lazy chunks behind the hosts must each report THEIR stage from the wiring itself: the
  // test renders exactly the fallback component each `dynamic()` call is given and reads the source
  // to prove those are the ones wired — a swap between the editor and files labels, or a fallback
  // reverted to a shared one, is invisible to the factory's own test (#3376 review).
  it("wires each lazy chunk to a fallback that reports the chunk's own stage", () => {
    const expected = {
      chatWindow: "desktop chat window chunk",
      editorWidget: "desktop editor widget chunk",
      filesWidget: "desktop files widget chunk",
    } as const;
    for (const [key, Fallback] of Object.entries(HOST_CHUNK_FALLBACKS) as [
      keyof typeof HOST_CHUNK_FALLBACKS,
      () => ReactNode,
    ][]) {
      reportClientDiagnosticMock.mockClear();
      const view = render(
        <I18nProvider>
          <Fallback />
        </I18nProvider>,
      );
      expect(reportClientDiagnosticMock).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^${expected[key]} #\\d+: started$`)),
      );
      view.unmount();
    }
    // The workspace lane runs from packages/keiko-ui, the root lane from the repository root.
    const relative = "src/app/components/desktop/widgets/SelectionAwareWorkspaceHosts.tsx";
    const candidate = resolve(process.cwd(), relative);
    const source = readFileSync(
      existsSync(candidate) ? candidate : resolve(process.cwd(), "packages/keiko-ui", relative),
      "utf8",
    );
    expect(source).toMatch(
      /import\("\.\.\/ChatWindow"\)[^;]*loading: HOST_CHUNK_FALLBACKS\.chatWindow/s,
    );
    expect(source).toMatch(
      /import\("\.\/cards\/EditorWidget"\)[^;]*loading: HOST_CHUNK_FALLBACKS\.editorWidget/s,
    );
    expect(source).toMatch(
      /import\("\.\/cards\/FilesWidget"\)[^;]*loading: HOST_CHUNK_FALLBACKS\.filesWidget/s,
    );
  });

  it("rejects empty and whitespace-only titles at the owning normalization boundary", (): void => {
    expect(normalizedChatTitle("")).toBeUndefined();
    expect(normalizedChatTitle(" \t\n ")).toBeUndefined();
  });

  it("keeps a replacement creation after a detached same-key request settles (#3210)", async (): Promise<void> => {
    const original = deferred<Chat | undefined>();
    const replacement = deferred<Chat | undefined>();
    const originalChat = chatFixture("chat-original", "Original", 1);
    const replacementChat = chatFixture("chat-replacement", "Replacement", 2);
    const openNewChat = vi
      .fn()
      .mockReturnValueOnce(original.promise)
      .mockReturnValueOnce(replacement.promise);
    const replaceChat = vi.fn((_chat: Chat): void => undefined);
    const { result } = renderHook(() => useChatCreationCoordinator(openNewChat, replaceChat));
    const owner = { kind: "window", id: "initial-unbound-chat-0\u0000" } as const;

    const originalResult = executeChatCreationRequest({
      activeProject: undefined,
      coordinator: result.current,
      isCurrent: (): boolean => false,
      owner,
      requestKey: owner.id,
      setError: vi.fn(),
      title: undefined,
      updateCfg: vi.fn(),
    });
    result.current.release(owner);
    const replacementResult = result.current.request(owner);
    expect(openNewChat).toHaveBeenCalledTimes(2);

    await act(async (): Promise<void> => {
      original.resolve(originalChat);
      await originalResult;
    });

    const coalescedReplacement = result.current.request(owner);
    expect(openNewChat).toHaveBeenCalledTimes(2);
    expect(coalescedReplacement).toBe(replacementResult);

    await act(async (): Promise<void> => {
      replacement.resolve(replacementChat);
      await replacementResult;
    });
  });

  it("releases a detached host request before re-requesting after its rejection (#3210)", async (): Promise<void> => {
    vi.stubGlobal("reportError", vi.fn());
    const rejected = deferred<Chat | undefined>();
    const replacement = deferred<Chat | undefined>();
    const replacementChat = chatFixture("chat-replacement", "Replacement", 2);
    chatSessionState.openNewChat = vi
      .fn()
      .mockReturnValueOnce(rejected.promise)
      .mockReturnValueOnce(replacement.promise);
    const ctx = context();
    const view = render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ newChatRequestId: "request-a" }} ctx={ctx} />
      </I18nProvider>,
    );
    await waitFor((): void => {
      expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(1);
    });

    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: "already-open" }} ctx={ctx} />
      </I18nProvider>,
    );
    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ newChatRequestId: "request-a" }} ctx={ctx} />
      </I18nProvider>,
    );
    await waitFor((): void => {
      expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(2);
    });

    await act(async (): Promise<void> => {
      rejected.reject(new Error("transport rejected the detached request"));
      await Promise.resolve();
    });
    expect(ctx.updateCfg).not.toHaveBeenCalled();

    await act(async (): Promise<void> => {
      replacement.resolve(replacementChat);
      await Promise.resolve();
    });
    await waitFor((): void => {
      expect(ctx.updateCfg).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: replacementChat.id, newChatRequestId: undefined }),
      );
    });
  });

  it("reports a content-free diagnostic when chat creation rejects", async (): Promise<void> => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    chatSessionState.openNewChat.mockRejectedValueOnce(new Error("customer-chat-creation-detail"));
    render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: "Sensitive title", newChatRequestId: "request-failure" }}
          ctx={context()}
        />
      </I18nProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open chat.");
    expect(reportError).toHaveBeenCalledOnce();
    const reported = reportError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toMatch(
      /^Chat creation request failed\. Correlation ID: [A-Za-z0-9._-]{8,128}$/,
    );
    expect((reported as Error).message).not.toContain("customer-chat-creation-detail");
    expect((reported as Error).message).not.toContain("Sensitive title");
  });

  it("creates an unbound chat in its configured project before routing settles", async () => {
    const projectA: ProjectWithAvailability = {
      path: "/repo-a",
      name: "Repo A",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
    };
    const projectB: ProjectWithAvailability = { ...projectA, path: "/repo-b", name: "Repo B" };
    const created = {
      ...chatFixture("chat-created-in-b", "Project B chat", 2),
      projectPath: projectB.path,
    };
    chatSessionState.activeProject = projectA;
    chatSessionState.projects = [projectA, projectB];
    chatSessionState.openNewChat.mockResolvedValueOnce(created);
    const ctx = context();

    render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{
            projectPath: projectB.path,
            title: created.title,
            newChatRequestId: "configured-project-request",
          }}
          ctx={ctx}
        />
      </I18nProvider>,
    );

    await waitFor((): void =>
      expect(chatSessionState.openNewChat).toHaveBeenCalledWith(projectB, created.title),
    );
    expect(chatSessionState.openNewChat).not.toHaveBeenCalledWith(projectA, created.title);
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: created.id,
      projectPath: projectB.path,
      title: created.title,
      newChatRequestId: undefined,
    });
  });

  it("correlates a redacted title-update diagnostic", async (): Promise<void> => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const created = chatFixture("chat-created", "New chat", 2);
    chatSessionState.openNewChat.mockResolvedValueOnce(created);
    updateChatMock.mockRejectedValueOnce(new Error("customer-title-detail"));
    const ctx = context();

    render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: "Sensitive title", newChatRequestId: "request-title-failure" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );

    await waitFor((): void => expect(reportError).toHaveBeenCalledOnce());
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: created.id,
      projectPath: created.projectPath,
      title: created.title,
      newChatRequestId: undefined,
    });
    const reported = reportError.mock.calls[0]?.[0];
    expect((reported as Error).message).toMatch(
      /^Chat title update failed\. Correlation ID: [A-Za-z0-9._-]{8,128}$/,
    );
    expect((reported as Error).message).not.toContain("customer-title-detail");
    expect((reported as Error).message).not.toContain("Sensitive title");
  });

  it("retries an initial unbound chat when creation capability recovers", async (): Promise<void> => {
    const created = chatFixture("chat-recovered", "Recovered chat", 2);
    defaultOpenNewChat.mockResolvedValueOnce(undefined);
    const ctx = context();
    const view = render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{}} ctx={ctx} />
      </I18nProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open chat.");
    expect(defaultOpenNewChat).toHaveBeenCalledOnce();

    const recoveredOpenNewChat = vi.fn(async (): Promise<Chat | undefined> => created);
    chatSessionState.openNewChat = recoveredOpenNewChat;
    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{}} ctx={ctx} />
      </I18nProvider>,
    );

    await waitFor((): void => expect(recoveredOpenNewChat).toHaveBeenCalledOnce());
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: created.id,
      projectPath: created.projectPath,
      title: created.title,
      newChatRequestId: undefined,
    });
  });

  it("creates and binds one canonical chat while the old composer stays unavailable", async (): Promise<void> => {
    const existing = chatFixture("chat-existing", "Existing chat", 1);
    const created = chatFixture("chat-created", "Release grounding review", 2);
    const creation = deferred<Chat>();
    chatSessionState.activeChat = existing;
    chatSessionState.chats = [existing];
    chatSessionState.openNewChat.mockReturnValueOnce(creation.promise);
    const ctx = context();
    const view = render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: created.title, newChatRequestId: "request-1" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );

    await waitFor((): void => {
      expect(chatSessionState.openNewChat).toHaveBeenCalledWith(undefined, created.title);
    });
    expect(screen.getByText("Opening chat...")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-window")).not.toBeInTheDocument();
    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: created.title, newChatRequestId: "request-1" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    expect(chatSessionState.openNewChat).toHaveBeenCalledOnce();

    await act(async (): Promise<void> => {
      creation.resolve(created);
      await creation.promise;
    });
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: created.id,
      projectPath: created.projectPath,
      title: created.title,
      newChatRequestId: undefined,
    });
  });

  it("fails visibly when a new-chat snapshot targets a project that no longer exists", async () => {
    const ctx = context();
    chatSessionState.projects = [];
    chatSessionState.activeProject = undefined;
    chatSessionState.loading = false;

    render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{
            title: "Removed project chat",
            newChatRequestId: "request-removed-project",
            projectPath: "/removed-project",
          }}
          ctx={ctx}
        />
      </I18nProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open chat.");
    expect(screen.queryByTestId("chat-window")).not.toBeInTheDocument();
    expect(screen.queryByText("Opening chat...")).not.toBeInTheDocument();
    expect(chatSessionState.openNewChat).not.toHaveBeenCalled();
  });

  it("retries a failed same-title request under a new confirmation identity", async (): Promise<void> => {
    const first = deferred<Chat | undefined>();
    const second = deferred<Chat | undefined>();
    const created = chatFixture("chat-retry", "Same title", 3);
    const existing = chatFixture("chat-existing", "Existing chat", 1);
    chatSessionState.activeChat = existing;
    chatSessionState.chats = [existing];
    chatSessionState.openNewChat
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const ctx = context();
    const view = render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: created.title, newChatRequestId: "request-1" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await waitFor((): void => {
      expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(1);
    });

    await act(async (): Promise<void> => {
      first.resolve(undefined);
      await first.promise;
    });
    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: created.title, newChatRequestId: "request-2" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await waitFor((): void => {
      expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(2);
    });

    await act(async (): Promise<void> => {
      second.resolve(created);
      await second.promise;
    });
    expect(ctx.updateCfg).toHaveBeenCalledOnce();
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: created.id,
      projectPath: created.projectPath,
      title: created.title,
      newChatRequestId: undefined,
    });
  });

  it("does not adopt a settled creation into a later fresh request", async (): Promise<void> => {
    const creation = deferred<Chat | undefined>();
    const replacement = deferred<Chat | undefined>();
    const created = chatFixture("chat-created", "First title", 2);
    const latest = chatFixture("chat-created-latest", "Second title", 3);
    chatSessionState.activeChat = undefined;
    chatSessionState.activeProject = undefined;
    chatSessionState.chats = [];
    chatSessionState.openNewChat
      .mockReturnValueOnce(creation.promise)
      .mockReturnValueOnce(replacement.promise);
    const ctx = context();
    const view = render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: created.title, newChatRequestId: "request-1" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await waitFor((): void => {
      expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(1);
    });

    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: latest.title, newChatRequestId: "request-2" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await waitFor((): void => expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(2));
    await act(async (): Promise<void> => {
      creation.resolve(created);
      await creation.promise;
    });
    expect(ctx.updateCfg).not.toHaveBeenCalled();

    await act(async (): Promise<void> => {
      replacement.resolve(latest);
      await replacement.promise;
    });
    await waitFor((): void => expect(ctx.updateCfg).toHaveBeenCalledOnce());
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: latest.id,
      projectPath: latest.projectPath,
      title: latest.title,
      newChatRequestId: undefined,
    });
  });

  it("does not persist an empty normalized title", async (): Promise<void> => {
    const creation = deferred<Chat | undefined>();
    const created = chatFixture("chat-created", "New chat", 2);
    chatSessionState.activeChat = undefined;
    chatSessionState.activeProject = undefined;
    chatSessionState.chats = [];
    chatSessionState.openNewChat.mockReturnValueOnce(creation.promise);
    const ctx = context();
    render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: "   ", newChatRequestId: "request-empty-title" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await waitFor((): void => expect(chatSessionState.openNewChat).toHaveBeenCalledOnce());

    await act(async (): Promise<void> => {
      creation.resolve(created);
      await creation.promise;
    });

    await waitFor((): void =>
      expect(ctx.updateCfg).toHaveBeenCalledWith({
        chatId: created.id,
        projectPath: created.projectPath,
        title: created.title,
        newChatRequestId: undefined,
      }),
    );
    expect(updateChatMock).not.toHaveBeenCalled();
  });

  it("does not redeliver a settled project creation when navigation returns", async (): Promise<void> => {
    const projectA: ProjectWithAvailability = {
      path: "/repo-a",
      name: "Repo A",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
    };
    const projectB: ProjectWithAvailability = {
      path: "/repo-b",
      name: "Repo B",
      favorite: false,
      createdAt: 2,
      lastOpenedAt: 2,
      available: true,
    };
    const creationA = deferred<Chat | undefined>();
    const creationB = deferred<Chat | undefined>();
    const creationAAgain = deferred<Chat | undefined>();
    const chatA = { ...chatFixture("chat-a", "Project A", 1), projectPath: projectA.path };
    const chatB = { ...chatFixture("chat-b", "Project B", 2), projectPath: projectB.path };
    chatSessionState.activeChat = undefined;
    chatSessionState.activeProject = projectA;
    chatSessionState.chats = [];
    chatSessionState.openNewChat
      .mockReturnValueOnce(creationA.promise)
      .mockReturnValueOnce(creationB.promise)
      .mockReturnValueOnce(creationAAgain.promise);
    const ctx = context();
    const view = render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: chatA.title, newChatRequestId: "project-request" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await waitFor((): void => expect(chatSessionState.openNewChat).toHaveBeenCalledOnce());

    chatSessionState.activeProject = projectB;
    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: chatB.title, newChatRequestId: "project-request" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await waitFor((): void => expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(2));
    expect(chatSessionState.openNewChat).toHaveBeenNthCalledWith(1, projectA, chatA.title);
    expect(chatSessionState.openNewChat).toHaveBeenNthCalledWith(2, projectB, chatB.title);

    await act(async (): Promise<void> => {
      creationA.resolve(chatA);
      await creationA.promise;
    });
    expect(ctx.updateCfg).not.toHaveBeenCalled();

    await act(async (): Promise<void> => {
      creationB.resolve(chatB);
      await creationB.promise;
    });
    await waitFor((): void => expect(ctx.updateCfg).toHaveBeenCalledOnce());
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: chatB.id,
      projectPath: chatB.projectPath,
      title: chatB.title,
      newChatRequestId: undefined,
    });

    chatSessionState.activeProject = projectA;
    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: chatA.title, newChatRequestId: "project-request" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await waitFor((): void => expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(3));
    await act(async (): Promise<void> => {
      creationAAgain.resolve(chatA);
      await creationAAgain.promise;
    });
    await waitFor((): void => expect(ctx.updateCfg).toHaveBeenCalledTimes(2));
    expect(ctx.updateCfg).toHaveBeenLastCalledWith({
      chatId: chatA.id,
      projectPath: chatA.projectPath,
      title: chatA.title,
      newChatRequestId: undefined,
    });
  });

  it("reuses the compatible project creation when navigation returns before it settles", async (): Promise<void> => {
    const projectA: ProjectWithAvailability = {
      path: "/repo-a",
      name: "Repo A",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
    };
    const projectB: ProjectWithAvailability = {
      path: "/repo-b",
      name: "Repo B",
      favorite: false,
      createdAt: 2,
      lastOpenedAt: 2,
      available: true,
    };
    const creationA = deferred<Chat | undefined>();
    const creationB = deferred<Chat | undefined>();
    const chatA = { ...chatFixture("chat-a", "Project A", 1), projectPath: projectA.path };
    const chatB = { ...chatFixture("chat-b", "Project B", 2), projectPath: projectB.path };
    chatSessionState.activeChat = undefined;
    chatSessionState.activeProject = projectA;
    chatSessionState.chats = [];
    chatSessionState.openNewChat
      .mockReturnValueOnce(creationA.promise)
      .mockReturnValueOnce(creationB.promise);
    const ctx = context();
    const view = render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: chatA.title, newChatRequestId: "project-request" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await waitFor((): void => expect(chatSessionState.openNewChat).toHaveBeenCalledOnce());

    chatSessionState.activeProject = projectB;
    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: chatB.title, newChatRequestId: "project-request" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await waitFor((): void => expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(2));
    chatSessionState.activeProject = projectA;
    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: chatA.title, newChatRequestId: "project-request" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await act(async (): Promise<void> => {
      creationB.resolve(chatB);
      await creationB.promise;
    });
    expect(ctx.updateCfg).not.toHaveBeenCalled();
    expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(2);

    await act(async (): Promise<void> => {
      creationA.resolve(chatA);
      await creationA.promise;
    });
    await waitFor((): void => expect(ctx.updateCfg).toHaveBeenCalledOnce());
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: chatA.id,
      projectPath: chatA.projectPath,
      title: chatA.title,
      newChatRequestId: undefined,
    });
  });

  it("renders a not-found message when the configured chat has no live match", async (): Promise<void> => {
    // targetMissing requires: no selectionHandoffId, a configured chatId, session not loading,
    // the active chat not already that id, and no open (non-closed) chat with that id either.
    chatSessionState.activeChat = undefined;
    chatSessionState.chats = [];
    chatSessionState.loading = false;

    render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: "chat-missing" }} ctx={context()} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Chat not found")).toBeInTheDocument();
    expect(
      screen.getByText("This conversation was deleted or is no longer available."),
    ).toBeInTheDocument();
  });

  it("never retargets a missing binding onto a sibling conversation", async (): Promise<void> => {
    const switched = chatFixture("chat-other-project", "Other project chat", 7);
    chatSessionState.activeChat = switched;
    chatSessionState.chats = [switched];
    chatSessionState.loading = false;
    const ctx = context();

    render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: "chat-previous-project" }} ctx={ctx} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Chat not found")).toBeInTheDocument();
    expect(ctx.updateCfg).not.toHaveBeenCalled();
  });

  it("recovers the owning project for a legacy chat window without project metadata", async () => {
    const projectA: ProjectWithAvailability = {
      path: "/repo-a",
      name: "Repo A",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
    };
    const projectB: ProjectWithAvailability = { ...projectA, path: "/repo-b", name: "Repo B" };
    const chatA = { ...chatFixture("chat-a", "Legacy chat", 1), projectPath: projectA.path };
    const chatB = { ...chatFixture("chat-b", "Current chat", 2), projectPath: projectB.path };
    chatSessionState.activeProject = projectB;
    chatSessionState.activeChat = chatB;
    chatSessionState.projects = [projectA, projectB];
    chatSessionState.chats = [chatB];
    fetchChatsMock.mockImplementation(async (path): Promise<{ readonly chats: readonly Chat[] }> =>
      path === projectA.path ? { chats: [chatA] } : { chats: [chatB] },
    );
    const ctx = context();

    render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: chatA.id, title: chatA.title }} ctx={ctx} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Opening chat...")).toBeInTheDocument();
    await waitFor((): void =>
      expect(ctx.updateCfg).toHaveBeenCalledWith({ projectPath: "/repo-a" }),
    );
    expect(chatSessionState.openProject).toHaveBeenCalledWith(projectA);
    expect(screen.queryByText("Chat not found")).not.toBeInTheDocument();
  });

  it("shares concurrent legacy project scans across restored chat windows", async () => {
    const projectA: ProjectWithAvailability = {
      path: "/repo-a",
      name: "Repo A",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
    };
    const projectB: ProjectWithAvailability = { ...projectA, path: "/repo-b", name: "Repo B" };
    chatSessionState.activeProject = projectB;
    chatSessionState.activeChat = undefined;
    chatSessionState.projects = [projectA, projectB];
    chatSessionState.chats = [];
    const projectAChats = deferred<{ readonly chats: readonly Chat[] }>();
    const projectBChats = deferred<{ readonly chats: readonly Chat[] }>();
    fetchChatsMock.mockImplementation((path) =>
      path === projectA.path ? projectAChats.promise : projectBChats.promise,
    );

    render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ chatId: "legacy-chat-a" }}
          ctx={context({ windowId: "chat-window-a" })}
        />
        <ChatWindowSessionHost
          cfg={{ chatId: "legacy-chat-b" }}
          ctx={context({ windowId: "chat-window-b" })}
        />
      </I18nProvider>,
    );

    await waitFor((): void => expect(fetchChatsMock).toHaveBeenCalledTimes(2));
    expect(fetchChatsMock).toHaveBeenCalledWith(projectA.path);
    expect(fetchChatsMock).toHaveBeenCalledWith(projectB.path);
    await act(async (): Promise<void> => {
      projectAChats.resolve({ chats: [] });
      projectBChats.resolve({ chats: [] });
      await Promise.all([projectAChats.promise, projectBChats.promise]);
    });
    await waitFor((): void => expect(screen.getAllByText("Chat not found")).toHaveLength(2));
    expect(fetchChatsMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a legacy project lookup failure without caching it as deletion", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const projectA: ProjectWithAvailability = {
      path: "/repo-a",
      name: "Repo A",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
    };
    const projectB: ProjectWithAvailability = { ...projectA, path: "/repo-b", name: "Repo B" };
    const current = { ...chatFixture("chat-b", "Current chat", 2), projectPath: projectB.path };
    chatSessionState.activeProject = projectB;
    chatSessionState.activeChat = current;
    chatSessionState.projects = [projectA, projectB];
    chatSessionState.chats = [current];
    fetchChatsMock.mockImplementation(async (path) => {
      if (path === projectA.path) throw new TypeError("temporary lookup failure");
      return { chats: [current] };
    });

    render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: "legacy-chat" }} ctx={context()} />
      </I18nProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open chat.");
    expect(screen.queryByText("Chat not found")).not.toBeInTheDocument();
    expect(chatSessionState.openProject).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledOnce();
    const reported = reportError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toMatch(
      /^Chat project lookup failed\. Correlation ID: [A-Za-z0-9._-]{8,128}$/u,
    );
    expect((reported as Error).message).not.toContain("temporary lookup failure");
  });

  it("surfaces a failed empty project catalog without claiming deletion", async () => {
    chatSessionState.activeProject = undefined;
    chatSessionState.activeChat = undefined;
    chatSessionState.projects = [];
    chatSessionState.chats = [];
    chatSessionState.loading = false;
    chatSessionState.error = "temporary bootstrap failure";

    render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: "legacy-chat" }} ctx={context()} />
      </I18nProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open chat.");
    expect(screen.queryByText("Chat not found")).not.toBeInTheDocument();
  });

  it("restores a persisted chat from its owning project without replacing its binding", async () => {
    const projectA: ProjectWithAvailability = {
      path: "/repo-a",
      name: "Repo A",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
    };
    const projectB: ProjectWithAvailability = { ...projectA, path: "/repo-b", name: "Repo B" };
    const chatA = { ...chatFixture("chat-a", "Chat A", 1), projectPath: projectA.path };
    const chatB = { ...chatFixture("chat-b", "Chat B", 2), projectPath: projectB.path };
    chatSessionState.activeProject = projectB;
    chatSessionState.activeChat = chatB;
    chatSessionState.projects = [projectA, projectB];
    chatSessionState.chats = [chatB];
    const cfg = { chatId: chatA.id, projectPath: projectA.path, title: chatA.title };
    const ctx = context();
    const view = render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={cfg} ctx={ctx} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Opening chat...")).toBeInTheDocument();
    expect(chatSessionState.openProject).toHaveBeenCalledWith(projectA);

    chatSessionState.activeProject = projectA;
    chatSessionState.loading = true;
    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost cfg={cfg} ctx={ctx} />
      </I18nProvider>,
    );

    expect(screen.getByText("Opening chat...")).toBeInTheDocument();
    expect(screen.queryByText("Chat not found")).not.toBeInTheDocument();

    chatSessionState.loading = false;
    chatSessionState.activeChat = chatA;
    chatSessionState.chats = [chatA];
    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost cfg={cfg} ctx={ctx} />
      </I18nProvider>,
    );

    expect(await screen.findByTestId("chat-window")).toBeInTheDocument();
    expect(ctx.updateCfg).not.toHaveBeenCalledWith(expect.objectContaining({ chatId: chatB.id }));
  });

  it("reserves a persisted chat runtime while its owning project is restoring", async () => {
    const projectA: ProjectWithAvailability = {
      path: "/repo-a",
      name: "Repo A",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
    };
    const projectB: ProjectWithAvailability = { ...projectA, path: "/repo-b", name: "Repo B" };
    const chatB = { ...chatFixture("chat-b", "Chat B", 2), projectPath: projectB.path };
    chatSessionState.activeProject = projectB;
    chatSessionState.activeChat = chatB;
    chatSessionState.projects = [projectA, projectB];
    chatSessionState.chats = [chatB];

    render(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ chatId: "chat-a", projectPath: projectA.path, title: "Chat A" }}
          ctx={context({ windowId: "restoring-chat-window" })}
        />
      </I18nProvider>,
    );

    await waitFor((): void =>
      expect(chatWindowRuntimeTarget("restoring-chat-window")).toEqual({
        conversationId: "chat-a",
        projectPath: projectA.path,
      }),
    );
  });

  it("surfaces a configured project restoration failure without reporting deletion", async () => {
    const projectA: ProjectWithAvailability = {
      path: "/repo-a",
      name: "Repo A",
      favorite: false,
      createdAt: 1,
      lastOpenedAt: 1,
      available: true,
    };
    const projectB: ProjectWithAvailability = { ...projectA, path: "/repo-b", name: "Repo B" };
    const chatB = { ...chatFixture("chat-b", "Chat B", 2), projectPath: projectB.path };
    const cfg = { chatId: "chat-a", projectPath: projectA.path, title: "Chat A" };
    chatSessionState.activeProject = projectA;
    chatSessionState.activeChat = chatB;
    chatSessionState.projects = [projectA, projectB];
    chatSessionState.chats = [chatB];
    chatSessionState.error = "temporary project restoration failure";

    render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={cfg} ctx={context()} />
      </I18nProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open chat.");
    expect(screen.queryByText("Chat not found")).not.toBeInTheDocument();
  });

  it("attempts a bound chat restoration once while the logical session remains unchanged", async () => {
    const current = chatFixture("chat-current", "Current", 1);
    const target = chatFixture("chat-target", "Target", 2);
    chatSessionState.activeChat = current;
    chatSessionState.chats = [current, target];
    chatSessionState.loading = false;
    useChatSessionMock.mockImplementation(() => ({ ...chatSessionState }));
    const ctx = context();
    const view = render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: target.id }} ctx={ctx} />
      </I18nProvider>,
    );

    await waitFor((): void =>
      expect(chatSessionState.openChat).toHaveBeenCalledExactlyOnceWith(target),
    );

    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: target.id }} ctx={ctx} />
      </I18nProvider>,
    );

    await waitFor((): void => expect(chatSessionState.openChat).toHaveBeenCalledTimes(1));
  });

  // The honest case stays honest: a conversation trashed from Chat History remains in the list
  // with status "closed", which is the only proof the window has that it really is gone.
  it("still reports a trashed conversation as deleted rather than retargeting", async (): Promise<void> => {
    const trashed: Chat = { ...chatFixture("chat-trashed", "Trashed", 3), status: "closed" };
    const other = chatFixture("chat-live", "Live", 9);
    chatSessionState.activeChat = other;
    chatSessionState.chats = [trashed, other];
    chatSessionState.loading = false;
    const ctx = context();

    render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ chatId: trashed.id }} ctx={ctx} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Chat not found")).toBeInTheDocument();
    expect(ctx.updateCfg).not.toHaveBeenCalled();
  });

  // ─── 0.3.0 release audit — the structural "still untitled" marker ─────────────────────────────
  // The workspace decides whether to repeat a chat's title as a subtitle from a cfg marker rather
  // than from a comparison against display copy (which missed under `de`). This host owns the only
  // post-creation write of `cfg.title`, so it also owns keeping that marker honest.
  describe("untitled marker upkeep", () => {
    function renderBoundChat(cfg: Record<string, unknown>, ctx: WindowRenderContext): void {
      render(
        <I18nProvider>
          <ChatWindowSessionHost cfg={cfg} ctx={ctx} />
        </I18nProvider>,
      );
    }

    it("keeps the marker while materialising the record's title for the first time", async () => {
      const chat = chatFixture("chat-untitled", "New chat", 1);
      chatSessionState.activeChat = chat;
      chatSessionState.chats = [chat];
      chatSessionState.loading = false;
      const ctx = context();

      renderBoundChat({ chatId: chat.id, titleIsDefault: true }, ctx);

      await waitFor((): void => expect(cfgPatches(ctx)).toContainEqual({ title: chat.title }));
      expect(
        subText("chat", { chatId: chat.id, titleIsDefault: true, ...lastCfgPatch(ctx) }),
      ).toBeNull();
    });

    it("clears the marker when the record is renamed or auto-titled from the first turn", async () => {
      const chat = chatFixture("chat-titled", "Wie richte ich das Gateway ein?", 2);
      chatSessionState.activeChat = chat;
      chatSessionState.chats = [chat];
      chatSessionState.loading = false;
      const ctx = context();

      renderBoundChat({ chatId: chat.id, title: "Neuer Chat", titleIsDefault: true }, ctx);

      await waitFor((): void =>
        expect(cfgPatches(ctx)).toContainEqual({ title: chat.title, titleIsDefault: false }),
      );
      const patch = cfgPatches(ctx).find((candidate) => "title" in candidate);
      expect(patch).toEqual({ title: chat.title, titleIsDefault: false });
      expect(subText("chat", { chatId: chat.id, ...patch })).toBe(chat.title);
    });

    it("leaves a window whose title already matches the record untouched", async () => {
      const chat = chatFixture("chat-stable", "Release QA", 3);
      chatSessionState.activeChat = chat;
      chatSessionState.chats = [chat];
      chatSessionState.loading = false;
      const ctx = context();

      renderBoundChat({ chatId: chat.id, title: chat.title }, ctx);

      await waitFor((): void => expect(chatSessionState.openChat).not.toHaveBeenCalled());
      expect(cfgPatches(ctx).some((patch) => "title" in patch)).toBe(false);
      expect(cfgPatches(ctx)).toContainEqual({ projectPath: chat.projectPath });
    });

    it("applies a persisted memory preference change without requiring a chat switch", async () => {
      const chat = chatFixture("chat-memory", "Private", 4);
      chatSessionState.activeChat = chat;
      chatSessionState.chats = [chat];
      chatSessionState.loading = false;
      chatSessionState.memoryEnabled = false;
      const ctx = context();
      const view = render(
        <I18nProvider>
          <ChatWindowSessionHost
            cfg={{ chatId: chat.id, projectPath: chat.projectPath, memoryEnabled: false }}
            ctx={ctx}
          />
        </I18nProvider>,
      );

      view.rerender(
        <I18nProvider>
          <ChatWindowSessionHost
            cfg={{ chatId: chat.id, projectPath: chat.projectPath, memoryEnabled: true }}
            ctx={ctx}
          />
        </I18nProvider>,
      );

      await waitFor((): void =>
        expect(chatSessionState.setMemoryEnabled).toHaveBeenCalledWith(true),
      );
    });
  });
});

describe("FilesWindowSessionHost", () => {
  it("does not expose a second root authority when the global workspace root is bound", async () => {
    manifestRef.current = singleRootManifest("/work/keiko");
    const ctx = context();

    render(
      <I18nProvider>
        <FilesWindowSessionHost cfg={{}} ctx={ctx} root="/work/keiko" />
      </I18nProvider>,
    );

    expect(await screen.findByTestId("files-without-root-bar")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "go up" })).toBeNull();
    expect(addRoot).not.toHaveBeenCalled();
    expect(ctx.updateCfg).not.toHaveBeenCalled();
  });

  it("retains local root navigation when no global workspace root is bound", async () => {
    manifestRef.current = null;
    const ctx = context();

    render(
      <I18nProvider>
        <FilesWindowSessionHost cfg={{}} ctx={ctx} root={undefined} />
      </I18nProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "go up" }));

    expect(ctx.updateCfg).toHaveBeenCalledWith({
      root: "/work",
      activeFilePath: undefined,
      activeDirectoryPath: undefined,
      resolvedRoot: undefined,
    });
  });
});
