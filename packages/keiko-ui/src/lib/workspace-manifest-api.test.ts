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
  it("preserves the server error code and correlation id on a rejected workspace request", async () => {
    const correlationId = "workspace-request-2625";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "WORKSPACE_REVISION_CONFLICT",
              message: "workspace request rejected",
              correlationId,
            },
          }),
          {
            status: 409,
            headers: {
              "Content-Type": "application/json",
              "X-Keiko-Correlation-Id": correlationId,
            },
          },
        ),
      ),
    );

    await expect(fetchWorkspaceManifests()).rejects.toMatchObject({
      code: "WORKSPACE_REVISION_CONFLICT",
      correlationId,
      status: 409,
    });
  });

  it("fails closed with a correlated API error when a rejection is not a BFF envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 502 })));

    await expect(fetchWorkspaceManifests()).rejects.toMatchObject({
      code: "INTERNAL",
      message: "workspace manifest request rejected",
      status: 502,
      correlationId: expect.stringMatching(/^[A-Za-z0-9._-]{8,128}$/),
    });
  });

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
