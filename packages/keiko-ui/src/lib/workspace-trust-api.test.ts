import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_TRUST_SCHEMA_VERSION,
  type WorkspaceTrustStatus,
} from "@oscharko-dev/keiko-contracts";
import {
  fetchWorkspaceTrustStatus,
  mutateWorkspaceTrust,
  workspaceTrustEventProjectId,
  WORKSPACE_TRUST_CHANGED_EVENT,
} from "./workspace-trust-api";

function status(projectId = "/repo-a", trust: "trusted" | "restricted" = "trusted") {
  return {
    kind: "workspace-trust-status",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    projectId,
    trust,
    decidedBy: "server",
    reason: trust === "trusted" ? "human-grant" : "human-revocation",
    revision: 1,
  } satisfies WorkspaceTrustStatus;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace trust API", () => {
  it("returns a server status only when it validates and names the requested project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(status()), { status: 200 })),
    );

    await expect(fetchWorkspaceTrustStatus("/repo-a")).resolves.toMatchObject({
      projectId: "/repo-a",
      trust: "trusted",
    });
  });

  it("rejects a status that belongs to a different project instead of projecting it", async () => {
    // The browser must never adopt trust state it did not ask for: a response naming another
    // project would otherwise unlock the wrong root's UI.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(status("/repo-b")), { status: 200 })),
    );

    await expect(fetchWorkspaceTrustStatus("/repo-a")).rejects.toThrow("response invalid");
  });

  it("rejects malformed and non-ok trust responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(fetchWorkspaceTrustStatus("/repo-a")).rejects.toThrow("response invalid");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(status()), { status: 503 })),
    );
    await expect(fetchWorkspaceTrustStatus("/repo-a")).rejects.toThrow("request rejected");
  });

  it("sends the CSRF-guarded verb for each mutation and announces the validated result", async () => {
    for (const [mutation, method, trust] of [
      ["grant", "POST", "trusted"],
      ["revoke", "DELETE", "restricted"],
    ] as const) {
      const listener = vi.fn();
      window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, listener);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(status("/repo-a", trust)), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(mutateWorkspaceTrust("/repo-a", mutation)).resolves.toMatchObject({ trust });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/editor/verification/trust",
        expect.objectContaining({
          method,
          headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
        }),
      );
      expect(listener).toHaveBeenCalledTimes(1);
      window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, listener);
      vi.unstubAllGlobals();
    }
  });

  it("does not announce a change when the mutation response fails validation", async () => {
    const listener = vi.fn();
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, listener);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ trust: "trusted" }))),
    );

    await expect(mutateWorkspaceTrust("/repo-a", "grant")).rejects.toThrow("response invalid");

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, listener);
  });

  it("reads a project id only from a well-formed change event", () => {
    expect(
      workspaceTrustEventProjectId(
        new CustomEvent(WORKSPACE_TRUST_CHANGED_EVENT, { detail: { projectId: "/repo-a" } }),
      ),
    ).toBe("/repo-a");

    const rejected: readonly Event[] = [
      new Event(WORKSPACE_TRUST_CHANGED_EVENT),
      new CustomEvent(WORKSPACE_TRUST_CHANGED_EVENT, { detail: null }),
      new CustomEvent(WORKSPACE_TRUST_CHANGED_EVENT, { detail: ["/repo-a"] }),
      new CustomEvent(WORKSPACE_TRUST_CHANGED_EVENT, { detail: { projectId: "" } }),
      new CustomEvent(WORKSPACE_TRUST_CHANGED_EVENT, { detail: { projectId: 7 } }),
    ];
    for (const event of rejected) {
      expect(workspaceTrustEventProjectId(event)).toBeNull();
    }
  });
});
