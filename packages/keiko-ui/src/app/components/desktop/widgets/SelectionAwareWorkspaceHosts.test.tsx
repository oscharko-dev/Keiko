import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ReactNode } from "react";
import {
  WORKSPACE_TRUST_SCHEMA_VERSION,
  type WorkspaceManifest,
  type WorkspaceRootDescriptor,
  type WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import type { Chat, ProjectWithAvailability } from "@/lib/types";
import type { WorkspaceManifestView } from "../hooks/useWorkspaceManifest";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import { subText } from "../windows/connectionUtils";
import type { EditorWidgetProps } from "./cards/EditorWidget";
import {
  ChatWindowSessionHost,
  EditorWindowSessionHost,
  FilesWindowSessionHost,
  normalizedChatTitle,
} from "./SelectionAwareWorkspaceHosts";

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

vi.mock("@/lib/api", (): { readonly updateChat: Mock<UpdateChat> } => ({
  updateChat: updateChatMock,
}));

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
  loading: false,
  openChat: vi.fn(async (_chat: Chat): Promise<void> => undefined),
  openNewChat: vi.fn(async (): Promise<Chat | undefined> => undefined),
  replaceChat: vi.fn((_chat: Chat): void => undefined),
}));
const defaultOpenNewChat = chatSessionState.openNewChat;

vi.mock("../context/ChatSessionContext", (): object => ({
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
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve): void => {
    resolvePromise = resolve;
  });
  return {
    promise,
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
  chatSessionState.loading = false;
});

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
    expect(disposeRoot).toHaveBeenCalledWith("/repo-b", "root-disposed", true);
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
    expect(disposeRoot).toHaveBeenCalledWith("/repo-c", "root-disposed", true);
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
    expect(disposeRoot).toHaveBeenCalledWith("/repo-b", "root-disposed", true);
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
    expect(disposeRoot).toHaveBeenCalledWith("/repo-b", "root-disposed", true);
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
    render(
      editorHost(
        { root: "/repo-a", revealLineStart: 7, revealLineEnd: 10, revealRequestId: "reveal-1" },
        context(),
      ),
    );
    await screen.findByTestId("editor-/repo-a");

    expect(revealsFor("/repo-a")).toEqual(["7:10:reveal-1"]);
    // The sibling root is mounted, and it never once saw the request.
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
    render(
      editorHost(
        { root: "/repo-gone", revealLineStart: 7, revealLineEnd: 10, revealRequestId: "reveal-1" },
        context(),
      ),
    );
    await screen.findByTestId("editor-/repo-a");

    expect(revealsFor("/repo-a")).toEqual(["::"]);
    expect(revealsFor("/repo-b")).toEqual(["::"]);
  });
});

describe("ChatWindowSessionHost target missing", () => {
  it("rejects empty and whitespace-only titles at the owning normalization boundary", (): void => {
    expect(normalizedChatTitle("")).toBeUndefined();
    expect(normalizedChatTitle(" \t\n ")).toBeUndefined();
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
      title: created.title,
      newChatRequestId: undefined,
    });
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
      title: created.title,
      newChatRequestId: undefined,
    });
  });

  it("adopts a replacement request and binds only its latest title", async (): Promise<void> => {
    const creation = deferred<Chat | undefined>();
    const created = chatFixture("chat-created", "First title", 2);
    const latest = chatFixture(created.id, "Second title", 3);
    chatSessionState.activeChat = undefined;
    chatSessionState.activeProject = undefined;
    chatSessionState.chats = [];
    chatSessionState.openNewChat.mockReturnValueOnce(creation.promise);
    updateChatMock.mockResolvedValueOnce({ chat: latest });
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
    expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(1);
    await act(async (): Promise<void> => {
      creation.resolve(created);
      await creation.promise;
    });
    await waitFor((): void => {
      expect(ctx.updateCfg).toHaveBeenCalledOnce();
    });

    expect(chatSessionState.openNewChat).toHaveBeenCalledOnce();
    expect(updateChatMock).toHaveBeenCalledOnce();
    expect(updateChatMock).toHaveBeenCalledWith(created.id, { title: latest.title });
    expect(chatSessionState.replaceChat).toHaveBeenCalledOnce();
    expect(chatSessionState.replaceChat).toHaveBeenCalledWith(latest);
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: latest.id,
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
        title: created.title,
        newChatRequestId: undefined,
      }),
    );
    expect(updateChatMock).not.toHaveBeenCalled();
  });

  it("adopts a persisted project creation when navigation returns after it settles", async (): Promise<void> => {
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
    await waitFor((): void => expect(ctx.updateCfg).toHaveBeenCalledTimes(2));
    expect(chatSessionState.openNewChat).toHaveBeenCalledTimes(2);
    expect(ctx.updateCfg).toHaveBeenLastCalledWith({
      chatId: chatA.id,
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
      title: chatA.title,
      newChatRequestId: undefined,
    });
  });

  it("serializes adopted title updates so only the latest response reaches the session", async (): Promise<void> => {
    const creation = deferred<Chat | undefined>();
    const secondUpdate = deferred<{ readonly chat: Chat }>();
    const thirdUpdate = deferred<{ readonly chat: Chat }>();
    const created = chatFixture("chat-created", "Original", 1);
    const second = chatFixture(created.id, "Second", 2);
    const third = chatFixture(created.id, "Third", 3);
    chatSessionState.activeChat = undefined;
    chatSessionState.activeProject = undefined;
    chatSessionState.chats = [];
    chatSessionState.openNewChat.mockReturnValueOnce(creation.promise);
    updateChatMock
      .mockReturnValueOnce(secondUpdate.promise)
      .mockReturnValueOnce(thirdUpdate.promise);
    const ctx = context();
    const view = render(
      <I18nProvider>
        <ChatWindowSessionHost cfg={{ title: "First", newChatRequestId: "request-1" }} ctx={ctx} />
      </I18nProvider>,
    );
    await waitFor((): void => expect(chatSessionState.openNewChat).toHaveBeenCalledOnce());

    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: second.title, newChatRequestId: "request-2" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await act(async (): Promise<void> => {
      creation.resolve(created);
      await creation.promise;
    });
    await waitFor((): void => {
      expect(updateChatMock).toHaveBeenCalledWith(created.id, { title: second.title });
    });

    view.rerender(
      <I18nProvider>
        <ChatWindowSessionHost
          cfg={{ title: third.title, newChatRequestId: "request-3" }}
          ctx={ctx}
        />
      </I18nProvider>,
    );
    await act(async (): Promise<void> => {
      secondUpdate.resolve({ chat: second });
      await secondUpdate.promise;
    });
    await waitFor((): void => {
      expect(updateChatMock).toHaveBeenNthCalledWith(2, created.id, { title: third.title });
    });
    expect(chatSessionState.replaceChat).not.toHaveBeenCalled();
    expect(ctx.updateCfg).not.toHaveBeenCalled();

    await act(async (): Promise<void> => {
      thirdUpdate.resolve({ chat: third });
      await thirdUpdate.promise;
    });
    await waitFor((): void => expect(ctx.updateCfg).toHaveBeenCalledOnce());
    expect(chatSessionState.replaceChat).toHaveBeenCalledOnce();
    expect(chatSessionState.replaceChat).toHaveBeenCalledWith(third);
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      chatId: third.id,
      title: third.title,
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

      await waitFor((): void => expect(ctx.updateCfg).toHaveBeenCalledOnce());
      expect(lastCfgPatch(ctx)).toEqual({ title: chat.title });
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

      await waitFor((): void => expect(ctx.updateCfg).toHaveBeenCalledOnce());
      const patch = lastCfgPatch(ctx);
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
      expect(ctx.updateCfg).not.toHaveBeenCalled();
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
