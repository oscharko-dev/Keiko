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

vi.mock("next/dynamic", () => ({
  default: () => {
    function EditorProbe(props: EditorWidgetProps): ReactNode {
      const [dirty, setDirty] = useState(false);
      const { layoutJson, onWorkspaceChange, root, sessionActive } = props;
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

afterEach(() => vi.clearAllMocks());

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

  it("forcibly disposes models only after a root leaves the manifest and remains axe-clean", async () => {
    const current = manifest();
    const view = render(<Harness current={current} />);
    view.rerender(<Harness current={manifest([current.roots[0]!])} />);

    expect(disposeRoot).toHaveBeenCalledWith("/repo-b", "root-disposed", true);
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
