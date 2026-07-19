import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceManifest,
  WorkspaceRootDescriptor,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import {
  fetchWorkspaceManifests,
  focusWorkspaceRoot,
  workspaceManifestEventValue,
  workspaceRootDispatch,
  WORKSPACE_MANIFEST_CHANGED_EVENT,
} from "./workspace-manifest-api";

function root(rootRef: string, canonicalRoot: string): WorkspaceRootDescriptor {
  return {
    rootRef: rootRef as WorkspaceRootRef,
    canonicalRoot,
    displayName: canonicalRoot.slice(1),
    identityDigest: (rootRef === "root-a" ? "a" : "c").repeat(
      64,
    ) as WorkspaceRootDescriptor["identityDigest"],
    sourceDigest: { outcome: "absent" },
  };
}

function manifest(revision = 1): WorkspaceManifest {
  const roots = [root("root-a", "/repo-a"), root("root-b", "/repo-b")];
  return {
    kind: "workspace-manifest",
    schemaVersion: 1,
    manifestRef: "manifest-a" as WorkspaceManifest["manifestRef"],
    manifestDigest: "b".repeat(64) as WorkspaceManifest["manifestDigest"],
    workspaceId: "workspace-a",
    revision,
    roots,
    focusedRootRef: roots[0]!.rootRef,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("workspace manifest API", () => {
  it("rejects malformed list entries instead of projecting browser-owned workspace state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ manifests: [{}] }))),
    );

    await expect(fetchWorkspaceManifests()).rejects.toThrow("response invalid");
  });

  it("builds a closed dispatch only from an explicit current root", () => {
    const current = manifest();
    expect(workspaceRootDispatch(current, current.roots[1]!.rootRef)).toMatchObject({
      workspaceId: "workspace-a",
      rootRef: "root-b",
      rootIdentityDigest: "c".repeat(64),
      operationClass: "mutating",
    });
    expect(() => workspaceRootDispatch(current, "root-foreign" as WorkspaceRootRef)).toThrow(
      "not a current member",
    );
  });

  it("publishes a validated manifest after a focused-root mutation", async () => {
    const current = manifest();
    const next = { ...manifest(2), focusedRootRef: current.roots[1]!.rootRef };
    const listener = vi.fn();
    window.addEventListener(WORKSPACE_MANIFEST_CHANGED_EVENT, listener);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ manifest: next }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      focusWorkspaceRoot(current, current.roots[1]!, next.focusedRootRef),
    ).resolves.toEqual(next);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-a/focus",
      expect.objectContaining({ method: "PUT" }),
    );
    const event = listener.mock.calls[0]?.[0] as Event | undefined;
    expect(event === undefined ? null : workspaceManifestEventValue(event)).toEqual(next);
    window.removeEventListener(WORKSPACE_MANIFEST_CHANGED_EVENT, listener);
  });
});
