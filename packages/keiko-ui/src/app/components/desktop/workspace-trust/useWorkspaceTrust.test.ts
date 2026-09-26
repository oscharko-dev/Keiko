import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest, WorkspaceTrustStatus } from "@oscharko-dev/keiko-contracts";
import { WORKSPACE_MANIFEST_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/workspace-manifest";
import { WORKSPACE_TRUST_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/workspace-trust";
import { ApiError } from "@/lib/api";
import { WORKSPACE_TRUST_CHANGED_EVENT } from "@/lib/workspace-trust-api";
import { WORKSPACE_MANIFEST_CHANGED_EVENT } from "@/lib/workspace-manifest-api";
import { useWorkspaceTrust } from "./useWorkspaceTrust";

const fetchStatus = vi.hoisted(() => vi.fn());
const mutateTrust = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workspace-trust-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-trust-api")>()),
  fetchWorkspaceTrustStatus: fetchStatus,
  mutateWorkspaceTrust: mutateTrust,
}));

function status(
  projectId: string,
  trust: "trusted" | "restricted" = "restricted",
): WorkspaceTrustStatus {
  return {
    kind: "workspace-trust-status",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    projectId,
    trust,
    decidedBy: "server",
    reason: trust === "trusted" ? "human-grant" : "human-revocation",
    revision: 1,
  };
}

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

function manifestFor(roots: readonly string[]): WorkspaceManifest {
  return {
    kind: "workspace-manifest",
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    workspaceId: "workspace-a",
    manifestRef: "manifest-workspace-a",
    revision: 1,
    manifestDigest: "d".repeat(64),
    focusedRootRef: rootRefFor(roots[0] ?? "none"),
    roots: roots.map((canonicalRoot) => ({
      rootRef: rootRefFor(canonicalRoot),
      canonicalRoot,
      displayName: canonicalRoot,
      identityDigest: identityDigestFor(canonicalRoot),
      sourceDigest: { outcome: "absent" },
    })),
  } as unknown as WorkspaceManifest;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((inner) => {
    resolve = inner;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useWorkspaceTrust", () => {
  it("stays empty and never requests a status without a project", async () => {
    const view = renderHook(() => useWorkspaceTrust(undefined));

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.status).toBeUndefined();
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("loads the server status for the named project", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a", "trusted"));
    const view = renderHook(() => useWorkspaceTrust("/repo-a"));

    await waitFor(() => expect(view.result.current.status?.trust).toBe("trusted"));
    expect(view.result.current.issue).toBeUndefined();
    expect(fetchStatus).toHaveBeenCalledWith("/repo-a");
  });

  it("drops the status and reports a load issue when the read fails", async () => {
    const error = new ApiError("WORKSPACE_STATE_UNAVAILABLE", "unavailable", 503);
    error.correlationId = "trust-hook-request-2625";
    fetchStatus.mockRejectedValue(error);
    const view = renderHook(() => useWorkspaceTrust("/repo-a"));

    await waitFor(() => expect(view.result.current.issue).toBe("load"));
    expect(view.result.current.status).toBeUndefined();
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.failure).toEqual({
      code: "WORKSPACE_STATE_UNAVAILABLE",
      correlationId: "trust-hook-request-2625",
    });
  });

  it("ignores a superseded in-flight read so a stale status cannot overwrite a newer one", async () => {
    // requestRef deconfliction: without it the slower first response would land last and show the
    // previous project's trust for the current one.
    const first = deferred<WorkspaceTrustStatus>();
    fetchStatus.mockReturnValueOnce(first.promise);
    const view = renderHook(({ id }) => useWorkspaceTrust(id), {
      initialProps: { id: "/repo-a" },
    });

    fetchStatus.mockResolvedValue(status("/repo-b", "restricted"));
    view.rerender({ id: "/repo-b" });
    await waitFor(() => expect(view.result.current.status?.projectId).toBe("/repo-b"));

    await act(async () => {
      first.resolve(status("/repo-a", "trusted"));
      await first.promise;
    });

    expect(view.result.current.status?.projectId).toBe("/repo-b");
    expect(view.result.current.status?.trust).toBe("restricted");
  });

  it("refreshes on a change event for this project only", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a"));
    const view = renderHook(() => useWorkspaceTrust("/repo-a"));
    await waitFor(() => expect(view.result.current.status).toBeDefined());
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_TRUST_CHANGED_EVENT, { detail: { projectId: "/repo-b" } }),
      );
    });
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_TRUST_CHANGED_EVENT, { detail: { projectId: "/repo-a" } }),
      );
    });
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
  });

  // KEIKO-0352: server can recompute trust as a side-effect of an unrelated manifest mutation, so
  // the trust panel must re-fetch on WORKSPACE_MANIFEST_CHANGED_EVENT (filtered to this projectId)
  // instead of waiting for the next WORKSPACE_TRUST_CHANGED_EVENT.
  it("refreshes on a manifest-changed event that includes the tracked project root", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a"));
    const view = renderHook(() => useWorkspaceTrust("/repo-a"));
    await waitFor(() => expect(view.result.current.status).toBeDefined());
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    // Foreign manifest (does not include /repo-a) must NOT trigger a refresh.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_MANIFEST_CHANGED_EVENT, {
          detail: { manifest: manifestFor(["/repo-b"]) },
        }),
      );
    });
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    // Manifest that includes /repo-a triggers a re-fetch.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_MANIFEST_CHANGED_EVENT, {
          detail: { manifest: manifestFor(["/repo-a", "/repo-b"]) },
        }),
      );
    });
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
  });

  it("adopts the mutation result and reports an update issue when it is rejected", async () => {
    fetchStatus.mockResolvedValue(status("/repo-a"));
    mutateTrust.mockResolvedValue(status("/repo-a", "trusted"));
    const view = renderHook(() => useWorkspaceTrust("/repo-a"));
    await waitFor(() => expect(view.result.current.status).toBeDefined());

    await act(async () => {
      await expect(view.result.current.grant()).resolves.toBe(true);
    });
    expect(view.result.current.status?.trust).toBe("trusted");
    expect(mutateTrust).toHaveBeenCalledWith("/repo-a", "grant");

    mutateTrust.mockRejectedValue(new Error("denied"));
    await act(async () => {
      await expect(view.result.current.revoke()).resolves.toBe(false);
    });
    expect(view.result.current.issue).toBe("update");
    expect(view.result.current.mutating).toBe(false);
    // The last good status is kept: a failed revoke must not present the root as trust-unknown.
    expect(view.result.current.status?.trust).toBe("trusted");
  });

  it("refuses a mutation without a project", async () => {
    const view = renderHook(() => useWorkspaceTrust(""));
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    await act(async () => {
      await expect(view.result.current.grant()).resolves.toBe(false);
    });
    expect(mutateTrust).not.toHaveBeenCalled();
  });

  it("keeps status pinned when the tracked project id is the empty string", async () => {
    // The `""` project id is the "no workspace open" sentinel: the hook must not attempt
    // a fetch, and every consumer read (status/loading/mutating/issue) has to yield a
    // deterministic empty projection so downstream widgets never receive a stale trust
    // decision from a previously-open project.
    const view = renderHook(() => useWorkspaceTrust(""));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(view.result.current.status).toBeUndefined();
    expect(view.result.current.mutating).toBe(false);
    expect(view.result.current.issue).toBeUndefined();
  });
});
