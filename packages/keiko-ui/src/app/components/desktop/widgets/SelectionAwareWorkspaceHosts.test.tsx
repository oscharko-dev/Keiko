import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  WORKSPACE_TRUST_SCHEMA_VERSION,
  type WorkspaceManifest,
  type WorkspaceRootDescriptor,
  type WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import type { WorkspaceManifestView } from "../hooks/useWorkspaceManifest";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import type { EditorWidgetProps } from "./cards/EditorWidget";
import { EditorWindowSessionHost, FilesWindowSessionHost } from "./SelectionAwareWorkspaceHosts";

const addRoot = vi.hoisted(() => vi.fn());
const disposeRoot = vi.hoisted(() => vi.fn());
const manifestRef = vi.hoisted(() => ({ current: null as WorkspaceManifest | null }));

// The mock answers the real `WorkspaceManifestView` shape — `issue` is `"load" | "mutation" | null`,
// and a host that reads `issue === null` must not be told `undefined` by its own test double.
vi.mock("../hooks/useWorkspaceManifest", () => ({
  useWorkspaceManifest: (): WorkspaceManifestView => ({
    manifest: manifestRef.current,
    loading: false,
    issue: null,
    mutating: false,
    refresh: vi.fn(async () => undefined),
    addRoot,
    removeRoot: vi.fn(async () => true),
    reorderRoots: vi.fn(async () => true),
    focusRoot: vi.fn(async () => true),
  }),
}));

vi.mock("@oscharko-dev/keiko-editor", () => ({
  disposeEditorModelRegistryRoot: (...args: unknown[]) => disposeRoot(...args),
}));

// Records the root identity and the reveal triple each mounted editor was handed, so a test can see
// who a targeted request actually reached. The multi-root host mounts inactive roots inside a hidden
// `<Activity>`, so the record — not the DOM — is what proves a root was handed nothing.
const editorProps = vi.hoisted(() => [] as { root: string | undefined; reveal: string }[]);
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
  }: EditorWidgetProps): ReactNode => {
    const reveal = `${String(revealLineStart ?? "")}:${String(revealLineEnd ?? "")}:${revealRequestId ?? ""}`;
    editorProps.push({ root, reveal });
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
  FilesWidget: ({ onRootChange }: { readonly onRootChange?: (next: string) => void }) => (
    <button type="button" onClick={() => onRootChange?.("/work")}>
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

function context(): WindowRenderContext {
  return {
    updateCfg: vi.fn(),
    openEditorFile: vi.fn(),
    openWindow: vi.fn(),
  } as unknown as WindowRenderContext;
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

afterEach(() => {
  vi.clearAllMocks();
  editorProps.length = 0;
  editorHandlers.length = 0;
  manifestRef.current = null;
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

    const patch = vi.mocked(ctx.updateCfg).mock.calls.at(-1)?.[0] as
      Record<string, unknown> | undefined;
    expect(patch?.["root"]).toBe("/repo-b");
    expect(Object.keys(patch ?? {})).toEqual(
      expect.arrayContaining(["revealLineStart", "revealLineEnd", "revealRequestId"]),
    );
    expect(patch?.["revealRequestId"]).toBeUndefined();
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

    const patch = vi.mocked(ctx.updateCfg).mock.calls.at(-1)?.[0] as
      Record<string, unknown> | undefined;
    // The addressee did not change, so the request is still this editor's to act on.
    expect(Object.keys(patch ?? {})).not.toContain("revealRequestId");
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

describe("FilesWindowSessionHost", () => {
  it("navigates the window instead of mutating the workspace when the root bar changes", async () => {
    // Regression: the root-bar handler called workspace.addRoot for any root that was a manifest
    // member, so "go up" tried to add the parent directory as a second root. Manifest validation
    // rejects overlapping roots, so upward navigation simply stopped working in a single-root
    // workspace. Adding a root stays an explicit action in the multi-root Explorer's toolbar.
    manifestRef.current = singleRootManifest("/work/keiko");
    const ctx = context();

    render(
      <I18nProvider>
        <FilesWindowSessionHost cfg={{}} ctx={ctx} root="/work/keiko" />
      </I18nProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "go up" }));

    expect(addRoot).not.toHaveBeenCalled();
    expect(ctx.updateCfg).toHaveBeenCalledWith({
      root: "/work",
      activeFilePath: undefined,
      activeDirectoryPath: undefined,
      resolvedRoot: undefined,
    });
  });
});
