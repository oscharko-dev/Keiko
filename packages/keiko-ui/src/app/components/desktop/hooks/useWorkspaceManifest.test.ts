import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";
import { WORKSPACE_MANIFEST_CHANGED_EVENT } from "@/lib/workspace-manifest-api";
import { useWorkspaceManifest } from "./useWorkspaceManifest";

const fetchManifestAccess = vi.hoisted(() => vi.fn());
const addRoot = vi.hoisted(() => vi.fn());
const removeRoot = vi.hoisted(() => vi.fn());
const reorderRoots = vi.hoisted(() => vi.fn());
const focusRoot = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workspace-manifest-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-manifest-api")>()),
  fetchWorkspaceManifestAccess: fetchManifestAccess,
  addWorkspaceRoot: addRoot,
  removeWorkspaceRoot: removeRoot,
  reorderWorkspaceRoots: reorderRoots,
  focusWorkspaceRoot: focusRoot,
}));

function identityDigestFor(path: string): string {
  const hex = [...path]
    .map((char) => char.codePointAt(0)?.toString(16).padStart(2, "0") ?? "00")
    .join("");
  return hex.padEnd(64, "0").slice(0, 64);
}

function rootRefFor(path: string): string {
  const hex = [...path]
    .map((char) => char.codePointAt(0)?.toString(16).padStart(2, "0") ?? "00")
    .join("");
  return `root-${hex.padEnd(40, "0").slice(0, 40)}`;
}

function manifest(workspaceId: string, roots: readonly string[]): WorkspaceManifest {
  return {
    kind: "workspace-manifest",
    schemaVersion: 1,
    workspaceId,
    manifestRef: `manifest-${workspaceId}`,
    revision: 1,
    manifestDigest: "d".repeat(64),
    focusedRootRef: rootRefFor(roots[0] ?? "none"),
    roots: roots.map((path) => ({
      rootRef: rootRefFor(path),
      canonicalRoot: `/ws/${path}`,
      displayName: path,
      identityDigest: identityDigestFor(path),
      sourceDigest: { outcome: "absent" },
    })),
  } as unknown as WorkspaceManifest;
}

function emitChanged(next: WorkspaceManifest): void {
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_MANIFEST_CHANGED_EVENT, { detail: { manifest: next } }),
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useWorkspaceManifest", () => {
  it("loads the manifest containing the tracked root and clears on miss", async () => {
    const alpha = manifest("ws-a", ["alpha"]);
    fetchManifestAccess.mockResolvedValue({
      session: "paired",
      manifests: [alpha, manifest("ws-b", ["beta"])],
    });

    const view = renderHook(() => useWorkspaceManifest("/ws/alpha"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.manifest?.workspaceId).toBe("ws-a");
    expect(view.result.current.issue).toBeNull();

    const missing = renderHook(() => useWorkspaceManifest("/ws/unknown"));
    await waitFor(() => expect(missing.result.current.loading).toBe(false));
    expect(missing.result.current.manifest).toBeNull();
  });

  it("stays empty without a tracked root and never fetches", async () => {
    const view = renderHook(() => useWorkspaceManifest(undefined));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.manifest).toBeNull();
    expect(fetchManifestAccess).not.toHaveBeenCalled();
  });

  it("surfaces a load failure as the load issue", async () => {
    fetchManifestAccess.mockRejectedValue(new Error("offline"));
    const view = renderHook(() => useWorkspaceManifest("/ws/alpha"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.manifest).toBeNull();
    expect(view.result.current.issue).toBe("load");
    expect(view.result.current.pathReadAuthority).toBe("unavailable");
  });

  it("preserves an explicit unpaired app session without treating it as a load error", async () => {
    fetchManifestAccess.mockResolvedValue({ session: "unpaired", manifests: [] });
    const view = renderHook(() => useWorkspaceManifest("/managed/task"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.manifest).toBeNull();
    expect(view.result.current.issue).toBeNull();
    expect(view.result.current.pathReadAuthority).toBe("unpaired");
  });

  it("applies change events for the same workspace or a manifest gaining the root", async () => {
    const alpha = manifest("ws-a", ["alpha"]);
    fetchManifestAccess.mockResolvedValue({ session: "paired", manifests: [alpha] });
    const view = renderHook(() => useWorkspaceManifest("/ws/alpha"));
    await waitFor(() => expect(view.result.current.manifest).not.toBeNull());

    const grown = { ...alpha, revision: 2 } as WorkspaceManifest;
    act(() => {
      emitChanged(grown);
    });
    expect(view.result.current.manifest?.revision).toBe(2);

    const unrelated = manifest("ws-c", ["gamma"]);
    act(() => {
      emitChanged(unrelated);
    });
    expect(view.result.current.manifest?.workspaceId).toBe("ws-a");

    const adopting = manifest("ws-d", ["delta", "alpha"]);
    act(() => {
      emitChanged(adopting);
    });
    expect(view.result.current.manifest?.workspaceId).toBe("ws-d");
  });

  it("runs mutations through the member actor and reports mutation failures", async () => {
    const alpha = manifest("ws-a", ["alpha", "beta"]);
    fetchManifestAccess.mockResolvedValue({ session: "paired", manifests: [alpha] });
    const view = renderHook(() => useWorkspaceManifest("/ws/alpha"));
    await waitFor(() => expect(view.result.current.manifest).not.toBeNull());

    const next = { ...alpha, revision: 3 } as WorkspaceManifest;
    addRoot.mockResolvedValue(next);
    await act(async () => {
      await expect(
        view.result.current.addRoot(rootRefFor("alpha") as never, "/ws/gamma"),
      ).resolves.toBe(true);
    });
    expect(view.result.current.manifest?.revision).toBe(3);

    removeRoot.mockRejectedValue(new Error("denied"));
    await act(async () => {
      await expect(
        view.result.current.removeRoot(rootRefFor("alpha") as never, rootRefFor("beta") as never),
      ).resolves.toBe(false);
    });
    expect(view.result.current.issue).toBe("mutation");
    expect(view.result.current.mutating).toBe(false);

    await act(async () => {
      await expect(
        view.result.current.reorderRoots("root-0000000000000000000000000000000000000000" as never, [
          rootRefFor("beta") as never,
        ]),
      ).resolves.toBe(false);
    });
    expect(reorderRoots).not.toHaveBeenCalled();
  });

  it("keeps an event manifest when a fetch that predates it resolves afterwards (#2747)", async (): Promise<void> => {
    // The consequence is not cosmetic: the editor host diffs consecutive manifests of one workspace
    // and force-disposes every root that disappeared. A fetch resolving with a snapshot from before
    // a root was added therefore destroyed that live root's Monaco models, dirty buffers included.
    const before = manifest("ws-a", ["alpha"]);
    const after = manifest("ws-a", ["alpha", "beta"]);
    let releaseFetch = (): void => undefined;
    fetchManifestAccess.mockReturnValue(
      new Promise<unknown>((resolve): void => {
        releaseFetch = (): void => resolve({ session: "paired", manifests: [before] });
      }),
    );

    const view = renderHook(() => useWorkspaceManifest("/ws/alpha"));
    // The mount fetch is still in flight when another surface announces the added root.
    act((): void => emitChanged(after));
    expect(view.result.current.manifest?.roots).toHaveLength(2);

    await act(async () => {
      releaseFetch();
      await Promise.resolve();
    });

    // The stale response is discarded, so `beta` is never seen as removed.
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.manifest?.roots).toHaveLength(2);
  });

  it("refuses mutations before a manifest is loaded", async () => {
    fetchManifestAccess.mockResolvedValue({ session: "paired", manifests: [] });
    const view = renderHook(() => useWorkspaceManifest("/ws/alpha"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(async () => {
      await expect(view.result.current.focusRoot(rootRefFor("alpha") as never)).resolves.toBe(
        false,
      );
    });
    expect(focusRoot).not.toHaveBeenCalled();
  });
});
