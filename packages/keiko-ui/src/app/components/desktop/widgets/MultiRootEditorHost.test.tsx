import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceManifest,
  WorkspaceRootDescriptor,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import type { WorkspaceManifestView } from "../hooks/useWorkspaceManifest";
import type { EditorWidgetProps } from "./cards/EditorWidget";
import { MultiRootEditorHost } from "./MultiRootEditorHost";

const disposeRoot = vi.fn();
vi.mock("@oscharko-dev/keiko-editor", () => ({
  disposeEditorModelRegistryRoot: (...args: unknown[]) => disposeRoot(...args),
}));

// Issue #2619 — every mounted editor instance records the root identity it was handed, so a test can
// prove the host binds each root explicitly instead of leaning on the focused one.
const mountedBindings: { root: string | undefined; rootRef: string | undefined }[] = [];

vi.mock("next/dynamic", () => ({
  default: () => {
    function EditorProbe(props: EditorWidgetProps): ReactNode {
      const [dirty, setDirty] = useState(false);
      const { layoutJson, onWorkspaceChange, root, sessionActive } = props;
      mountedBindings.push({ root, rootRef: props.agentRootBinding?.rootRef });
      useEffect(() => {
        if (sessionActive === false) return;
        onWorkspaceChange?.({
          root,
          layoutJson: layoutJson ?? `layout:${root ?? "none"}:initial`,
        });
      }, [layoutJson, onWorkspaceChange, root, sessionActive]);
      if (sessionActive === false) return null;
      return (
        <div data-testid={`editor-${root ?? "none"}`}>
          <span>{layoutJson ?? "empty"}</span>
          <span>{dirty ? "Dirty buffer" : "Clean buffer"}</span>
          <button type="button" onClick={() => setDirty(true)}>
            Edit buffer
          </button>
          <button
            type="button"
            onClick={() =>
              onWorkspaceChange?.({
                root,
                file: "src/changed.ts",
                openFiles: ["src/changed.ts"],
                layoutJson: `layout:${root ?? "none"}:changed`,
              })
            }
          >
            Change layout
          </button>
        </div>
      );
    }
    return EditorProbe;
  },
}));

vi.mock("../workspace-trust/useWorkspaceTrust", () => ({
  useWorkspaceTrust: () => ({ status: undefined }),
}));

function root(
  rootRef: string,
  canonicalRoot: string,
  displayName: string,
): WorkspaceRootDescriptor {
  return {
    rootRef: rootRef as WorkspaceRootRef,
    canonicalRoot,
    displayName,
    identityDigest: "a".repeat(64) as WorkspaceRootDescriptor["identityDigest"],
    sourceDigest: { outcome: "absent" },
  };
}

function manifest(roots?: readonly WorkspaceRootDescriptor[]): WorkspaceManifest {
  const currentRoots = roots ?? [
    root("root-a", "/repo-a", "Repo A"),
    root("root-b", "/repo-b", "Repo B"),
  ];
  return {
    kind: "workspace-manifest",
    schemaVersion: 1,
    manifestRef: "manifest-a" as WorkspaceManifest["manifestRef"],
    manifestDigest: "b".repeat(64) as WorkspaceManifest["manifestDigest"],
    workspaceId: "workspace-a",
    revision: 1,
    roots: currentRoots,
    focusedRootRef: currentRoots[0]!.rootRef,
  };
}

function workspace(current: WorkspaceManifest): WorkspaceManifestView {
  return {
    manifest: current,
    loading: false,
    mutating: false,
    issue: null,
    refresh: vi.fn(async () => undefined),
    addRoot: vi.fn(async () => true),
    removeRoot: vi.fn(async () => true),
    reorderRoots: vi.fn(async () => true),
    focusRoot: vi.fn(async () => true),
  };
}

function Harness({ current }: { readonly current: WorkspaceManifest }): ReactNode {
  const [cfg, setCfg] = useState<Record<string, unknown>>({
    root: "/repo-a",
    layoutJson: "layout:/repo-a:initial",
  });
  const view = workspace(current);
  return (
    <I18nProvider>
      <button
        type="button"
        onClick={() =>
          setCfg((value) => ({
            ...value,
            root: "/repo-a",
            file: "src/opened.ts",
            openFiles: ["src/opened.ts"],
            layoutJson: "layout:/repo-a:opened",
          }))
        }
      >
        Request external open
      </button>
      <MultiRootEditorHost
        manifest={current}
        workspace={view}
        configuredRoot={typeof cfg["root"] === "string" ? cfg["root"] : undefined}
        cfg={cfg}
        buildBaseProps={() => ({ windowId: "editor-window" })}
        updateCfg={(patch) => setCfg((value) => ({ ...value, ...patch }))}
      />
    </I18nProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mountedBindings.length = 0;
});

// Issue #2619 (ADR-0147 D1) — `selectedRoot()` in this host also falls back to the focused root, and
// that is the deliberate exception, not an oversight: the host mounts EVERY root with its own
// explicit `root` and `agentRootBinding`, so focus only decides which already-bound tab is visible.
// No mutation ever borrows a root it was not given. Named here so the distinction stays deliberate
// rather than assumed.
describe("MultiRootEditorHost focused-root exception (#2619)", () => {
  it("binds every root explicitly, so focus only selects the visible tab", () => {
    render(
      <I18nProvider>
        <MultiRootEditorHost
          manifest={manifest()}
          workspace={workspace(manifest())}
          // No configured root at all — the case where `selectedRoot()` consults focus.
          configuredRoot={undefined}
          cfg={{}}
          buildBaseProps={() => ({ windowId: "editor-window" })}
          updateCfg={vi.fn()}
        />
      </I18nProvider>,
    );

    const bindings = new Map(mountedBindings.map((entry) => [entry.root, entry.rootRef]));
    // Both roots are mounted, each carrying its OWN identity — never the focused root's.
    expect(bindings.get("/repo-a")).toBe("root-a");
    expect(bindings.get("/repo-b")).toBe("root-b");
    // Nothing mounted without a root, and nothing inherited another root's binding.
    for (const entry of mountedBindings) {
      expect(entry.root).toBeDefined();
      expect(entry.rootRef).toBeDefined();
    }
  });
});

describe("MultiRootEditorHost", () => {
  it("retains dirty host and layout state while switching roots", async () => {
    const user = userEvent.setup();
    render(<Harness current={manifest()} />);

    expect(screen.getByTestId("editor-/repo-a")).toHaveTextContent("layout:/repo-a:initial");
    await user.click(screen.getByRole("button", { name: "Edit buffer" }));
    await user.click(screen.getByRole("button", { name: "Change layout" }));
    await user.click(screen.getByRole("tab", { name: /Repo B/u }));
    expect(screen.getByTestId("editor-/repo-b")).toHaveTextContent("Clean buffer");
    await user.click(screen.getByRole("tab", { name: /Repo A/u }));

    expect(screen.getByTestId("editor-/repo-a")).toHaveTextContent("Dirty buffer");
    expect(screen.getByTestId("editor-/repo-a")).toHaveTextContent("layout:/repo-a:changed");
  });

  it("adopts an external open request into the target root's session exactly once", async () => {
    // Regression: per-root sessions took precedence over cfg, so once a root had a session the
    // root/file/layoutJson patch openEditorFile writes was ignored and "open in editor" from
    // search, Problems, local history or an agent proposal silently did nothing.
    const user = userEvent.setup();
    render(<Harness current={manifest()} />);

    // A session now exists for /repo-a, and the user has moved it away from the initial layout.
    await user.click(screen.getByRole("button", { name: "Change layout" }));
    expect(screen.getByTestId("editor-/repo-a")).toHaveTextContent("layout:/repo-a:changed");

    await user.click(screen.getByRole("button", { name: "Request external open" }));

    expect(screen.getByTestId("editor-/repo-a")).toHaveTextContent("layout:/repo-a:opened");
  });

  // Issue #2621 — the forced-disposal assertion that used to live here moved to
  // `SelectionAwareWorkspaceHosts.test.tsx` ("removed-root model disposal"), together with the diff
  // itself. It passed here only because this harness mounts the host directly; in the product the
  // 2 -> 1 transition unmounts it, so the assertion described a path the user never takes. The
  // `not.toHaveBeenCalled()` below is a deliberate negative control, not leftover scaffolding: the
  // keiko-editor mock is still installed, so it fails the moment a disposal returns to this layer
  // and starts double-disposing behind the host that now owns it.
  it("remains axe-clean after a root leaves the manifest", async () => {
    const current = manifest();
    const view = render(<Harness current={current} />);
    view.rerender(<Harness current={manifest([current.roots[0]!])} />);

    expect(disposeRoot).not.toHaveBeenCalled();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("drops a stale reveal when the user selects another root by hand", async () => {
    // A reveal request names its target root in the same cfg patch that carries the line range, and
    // cfg keys outlive the request. Without clearing them, clicking a tab re-pointed `cfg.root` at
    // the new root and handed it a jump-to-line that was addressed to the root just left.
    const user = userEvent.setup();
    const updateCfg = vi.fn();
    render(
      <I18nProvider>
        <MultiRootEditorHost
          manifest={manifest()}
          workspace={workspace(manifest())}
          configuredRoot="/repo-a"
          cfg={{
            root: "/repo-a",
            revealLineStart: 7,
            revealLineEnd: 10,
            revealRequestId: "reveal-1",
          }}
          buildBaseProps={() => ({ windowId: "editor-window" })}
          updateCfg={updateCfg}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByRole("tab", { name: /Repo B/u }));

    // The session bootstrap writes cfg on mount, so the tab click is the most recent patch.
    const patch = updateCfg.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
    expect(patch?.["root"]).toBe("/repo-b");
    // Explicitly present and undefined: an absent key would leave the stale reveal in cfg, because
    // the window merges the patch into the existing config instead of replacing it.
    expect(Object.keys(patch ?? {})).toEqual(
      expect.arrayContaining(["revealLineStart", "revealLineEnd", "revealRequestId"]),
    );
    expect(patch?.["revealLineStart"]).toBeUndefined();
    expect(patch?.["revealLineEnd"]).toBeUndefined();
    expect(patch?.["revealRequestId"]).toBeUndefined();
  });
});
