import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_TRUST_SCHEMA_VERSION,
  type WorkspaceTrustStatus,
} from "@oscharko-dev/keiko-contracts";
import { ApiError } from "./api";
import {
  fetchWorkspaceTrustStatus,
  mutateWorkspaceTrust,
  workspaceTrustFailure,
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
  it("preserves the server error code and correlation id on a rejected trust read", async () => {
    const correlationId = "trust-request-2625";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "WORKSPACE_STATE_UNAVAILABLE",
              message: "workspace trust unavailable",
              correlationId,
            },
          }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json",
              "X-Keiko-Correlation-Id": correlationId,
            },
          },
        ),
      ),
    );

    await expect(fetchWorkspaceTrustStatus("/repo-a")).rejects.toMatchObject({
      code: "WORKSPACE_STATE_UNAVAILABLE",
      correlationId,
      status: 503,
    });
  });

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

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 503 })));
    await expect(fetchWorkspaceTrustStatus("/repo-a")).rejects.toThrow("request rejected");
  });

  it("projects only redacted API error metadata for trust surfaces", () => {
    const correlated = new ApiError("WORKSPACE_STATE_UNAVAILABLE", "sensitive detail", 503);
    correlated.correlationId = "trust-surface-request-2625";

    expect(workspaceTrustFailure(correlated)).toEqual({
      code: "WORKSPACE_STATE_UNAVAILABLE",
      correlationId: "trust-surface-request-2625",
    });
    expect(workspaceTrustFailure(new ApiError("DENIED", "detail", 403))).toEqual({
      code: "DENIED",
    });
    expect(workspaceTrustFailure(new Error("unstructured"))).toBeUndefined();
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

  it("exposes the pinned event name so useEditorVerificationRun and useWorkspaceTrust bind the same key", () => {
    // useEditorVerificationRun.ts and useWorkspaceTrust.ts both `addEventListener` for this
    // string; a rename in one file without the others would silently break the trust-changed
    // refetch path M11 depends on, so pin the exact byte sequence.
    expect(WORKSPACE_TRUST_CHANGED_EVENT).toBe("keiko:workspace-trust-changed");
    expect(WORKSPACE_TRUST_CHANGED_EVENT.startsWith("keiko:")).toBe(true);
  });
});
