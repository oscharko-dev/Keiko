import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_TRUST_SCHEMA_VERSION,
  type WorkspaceTrustStatus,
} from "@oscharko-dev/keiko-contracts";
import { WORKSPACE_TRUST_CHANGED_EVENT } from "@/lib/workspace-trust-api";
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
    fetchStatus.mockRejectedValue(new Error("boom"));
    const view = renderHook(() => useWorkspaceTrust("/repo-a"));

    await waitFor(() => expect(view.result.current.issue).toBe("load"));
    expect(view.result.current.status).toBeUndefined();
    expect(view.result.current.loading).toBe(false);
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
});
