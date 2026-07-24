import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_TRUST_SCHEMA_VERSION,
  type WorkspaceManifest,
  type WorkspaceRootDescriptor,
  type WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import { I18nProvider } from "@/lib/i18n";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import { FilesWindowSessionHost } from "./SelectionAwareWorkspaceHosts";

const addRoot = vi.hoisted(() => vi.fn());
const manifestRef = vi.hoisted(() => ({ current: null as WorkspaceManifest | null }));

vi.mock("../hooks/useWorkspaceManifest", () => ({
  useWorkspaceManifest: () => ({
    manifest: manifestRef.current,
    issue: undefined,
    mutating: false,
    addRoot,
    removeRoot: vi.fn(),
    reorderRoots: vi.fn(),
    focusRoot: vi.fn(),
  }),
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

function singleRootManifest(canonicalRoot: string): WorkspaceManifest {
  const roots = [root("root-a", canonicalRoot)];
  return {
    kind: "workspace-manifest",
    schemaVersion: 1,
    manifestRef: "manifest-a" as WorkspaceManifest["manifestRef"],
    manifestDigest: "b".repeat(64) as WorkspaceManifest["manifestDigest"],
    workspaceId: "workspace-a",
    revision: 1,
    roots,
    focusedRootRef: roots[0]!.rootRef,
  };
}

function context(): WindowRenderContext {
  return {
    updateCfg: vi.fn(),
    openEditorFile: vi.fn(),
    openWindow: vi.fn(),
  } as unknown as WindowRenderContext;
}

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
