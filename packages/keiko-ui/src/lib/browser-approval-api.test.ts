import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveBrowserRequest,
  inspectBrowserApprovals,
  proveBrowserApproval,
  requestBrowserApproval,
  requestBrowserChallenge,
  revokeBrowserApproval,
} from "./browser-approval-api";

const ROOT = "/api/coding-workbench/app-session/browser";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("browser approval API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the existing protected same-origin transport and canonical management response", async () => {
    const snapshot = { state: "active", requests: [], approvals: [] };
    const fetchMock = vi.fn().mockResolvedValue(response(snapshot));
    vi.stubGlobal("fetch", fetchMock);
    await expect(inspectBrowserApprovals()).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledWith(
      ROOT,
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }),
    );
  });

  it("keeps unavailable distinct from approved access", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ state: "unavailable" })));
    await expect(inspectBrowserApprovals()).resolves.toEqual({ state: "unavailable" });
  });

  it.each([
    (): Promise<unknown> => inspectBrowserApprovals(),
    (): Promise<unknown> =>
      requestBrowserApproval({
        publicKey: { x: "A".repeat(43), y: "A".repeat(43) },
        remember: false,
      }),
    (): Promise<unknown> =>
      approveBrowserRequest({
        requestId: `brq_${"a".repeat(32)}`,
        comparisonCode: "01234567",
        remember: false,
      }),
    (): Promise<unknown> =>
      requestBrowserChallenge({ purpose: "complete", subjectId: `brq_${"a".repeat(32)}` }),
    (): Promise<unknown> =>
      proveBrowserApproval({ challengeId: `bch_${"a".repeat(32)}`, signature: "A".repeat(86) }),
    (): Promise<unknown> => revokeBrowserApproval(`bra_${"a".repeat(32)}`),
  ])("refuses a malformed success response before a caller can use it", async (invoke) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ state: "active", privateKey: {} })),
    );
    await expect(invoke()).rejects.toMatchObject({
      code: "CONTRACT_VALIDATION_FAILED",
      status: 502,
    });
  });

  it("posts revocation as the existing scalar contract with CSRF protection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ state: "accepted" }));
    vi.stubGlobal("fetch", fetchMock);
    const approvalId = `bra_${"a".repeat(32)}`;
    await expect(revokeBrowserApproval(approvalId)).resolves.toEqual({ state: "accepted" });
    expect(fetchMock).toHaveBeenCalledWith(
      ROOT + "/revoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(approvalId),
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
  });

  it("never recursively repairs or replays its own denied write", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => response({ error: { code: "DENIED", message: "Denied" } }, 403));
    vi.stubGlobal("fetch", fetchMock);
    await expect(revokeBrowserApproval(`bra_${"a".repeat(32)}`)).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
