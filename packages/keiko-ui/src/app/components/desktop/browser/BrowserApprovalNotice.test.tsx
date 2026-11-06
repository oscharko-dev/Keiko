import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserApprovalManagementResult } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import * as api from "@/lib/browser-approval-api";
import { ApiError, askGrounded, sendDesktopChatStream } from "@/lib/api";
import { readChatDraft, writeChatDraft } from "@/lib/chat-draft-api";
import { bffFetchJson } from "@/lib/http";
import { openLauncherBrowser } from "@/lib/launcher-browser-client";
vi.mock("@/lib/launcher-browser-client", () => ({ openLauncherBrowser: vi.fn() }));
import {
  codingAppSessionPairingSettled,
  ensureLocalCodingAppSession,
  useCodingAppSessionRedemptions,
  type CodingAppSessionPairingSeams,
} from "@/lib/coding-app-session-client";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
import { BrowserApprovalNotice } from "./BrowserApprovalNotice";
import { BrowserApprovalSettings } from "./BrowserApprovalSettings";

vi.mock("@/lib/browser-approval-api", () => ({
  inspectBrowserApprovals: vi.fn(),
  approveBrowserRequest: vi.fn(),
  revokeBrowserApproval: vi.fn(),
  requestBrowserApproval: vi.fn(),
  requestBrowserChallenge: vi.fn(),
  proveBrowserApproval: vi.fn(),
}));
vi.mock("@/lib/coding-app-session-client", async (original) => ({
  ...(await original<typeof import("@/lib/coding-app-session-client")>()),
  codingAppSessionPairingSettled: vi.fn(),
}));

let active = true;
let inspectionClock = 0;
function inspection(): BrowserApprovalManagementResult {
  return active
    ? {
        state: "active",
        requests: [],
        approvals: [
          {
            approvalId: `bra_${"a".repeat(32)}`,
            remembered: true,
            approvedAtMs: 1_800_000_000_000,
            expiresAtMs: 1_800_003_600_000,
            lastUsedAtMs: 1_800_000_000_000,
            publicKeyFingerprint: "b".repeat(64),
          },
        ],
      }
    : { state: "unavailable" };
}

function repairSeams(post: () => Promise<unknown>): CodingAppSessionPairingSeams {
  return {
    readFragment: () => "",
    stripFragment: () => undefined,
    postPairing: async () => undefined,
    postLocalSession: post,
  };
}

function RefreshCounter(): ReactNode {
  return <output aria-label="Session refresh revision">{useCodingAppSessionRedemptions()}</output>;
}

beforeEach(() => {
  vi.resetAllMocks();
  // Independent cases are separate denial bursts, beyond the production five-second cooldown.
  inspectionClock += 10_000;
  vi.spyOn(performance, "now").mockReturnValue(inspectionClock);
  active = true;
  vi.mocked(codingAppSessionPairingSettled).mockResolvedValue(false);
  vi.mocked(api.inspectBrowserApprovals).mockImplementation(async () => inspection());
  vi.mocked(api.revokeBrowserApproval).mockImplementation(async () => {
    active = false;
    return { state: "accepted" };
  });
  setClientDiagnosticWriter(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetClientDiagnosticWriter();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser notice authentication lifecycle", () => {
  it.each(["grounded", "streamed", "draft"] as const)(
    "reinspects only session-concealing %s mutation refusals",
    async (surface) => {
      render(<BrowserApprovalNotice compact />);
      await waitFor(() => expect(api.inspectBrowserApprovals).toHaveBeenCalledOnce());
      expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull();
      active = false;
      const fetchMock = vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "NOT_FOUND", message: "Private resource not found." },
            }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      await act(async () => {
        const pending =
          surface === "grounded"
            ? askGrounded({
                chatId: "a",
                content: "Retain this prompt.",
                expectedSkillSelectionRevision: 1,
              })
            : surface === "streamed"
              ? sendDesktopChatStream(
                  { chatId: "a", projectPath: "/workspace", content: "Retain this prompt." },
                  new AbortController().signal,
                  {
                    onToken: () => undefined,
                    onDone: () => undefined,
                    onError: () => undefined,
                    onCancelled: () => undefined,
                  },
                )
              : writeChatDraft("a", { text: "Retain this prompt.", expectedRevision: 1 });
        await expect(pending).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      });
      // ADR-0141 D6: only private drafts conceal missing session authority here.
      // Ordinary missing Chat responses stay final and do not invalidate the held inspection.
      if (surface === "draft") await screen.findByRole("button", { name: "Connect browser" });
      else expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(api.inspectBrowserApprovals).toHaveBeenCalledTimes(surface === "draft" ? 3 : 1);
      expect(api.requestBrowserApproval).not.toHaveBeenCalled();
      expect(openLauncherBrowser).not.toHaveBeenCalled();
    },
  );

  it.each([
    [401, "UNAUTHORIZED", true],
    [403, "FORBIDDEN", true],
    [403, "PATH_ESCAPE", false],
    [409, "SKILL_SELECTION_CHANGED", false],
    [404, "OTHER_NOT_FOUND", false],
  ] as const)(
    "reinspects only session-relevant mutation refusals: %s %s",
    async (status, code, expected) => {
      render(<BrowserApprovalNotice compact />);
      await waitFor(() => expect(api.inspectBrowserApprovals).toHaveBeenCalledOnce());
      active = false;
      const fetchMock = vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              error: { code, message: "Refused." },
            }),
            { status },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      await act(async () => {
        await expect(
          bffFetchJson("/api/chats/a/draft", { method: "PUT", body: "{}" }),
        ).rejects.toMatchObject({ status, code });
      });
      if (expected) await screen.findByRole("button", { name: "Connect browser" });
      else expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull();
      expect(api.inspectBrowserApprovals).toHaveBeenCalledTimes(expected ? 3 : 1);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("does not recurse when session-dependent follow-up reads are also concealed", async () => {
    render(<BrowserApprovalNotice compact />);
    await waitFor(() => expect(api.inspectBrowserApprovals).toHaveBeenCalledOnce());
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "NOT_FOUND", message: "Private resource not found." },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(readChatDraft("a")).rejects.toMatchObject({ status: 404 });
    await expect(bffFetchJson("/api/chats/a/skill")).rejects.toMatchObject({ status: 404 });
    expect(api.inspectBrowserApprovals).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull();
  });

  it("preserves genuine missing-resource errors when the authoritative session is still active", async () => {
    render(<BrowserApprovalNotice compact />);
    await waitFor(() => expect(api.inspectBrowserApprovals).toHaveBeenCalledOnce());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "NOT_FOUND", message: "Chat not found." },
          }),
          { status: 404 },
        ),
      ),
    );
    await act(async () => {
      await expect(
        askGrounded({ chatId: "removed", content: "Keep this prompt." }),
      ).rejects.toMatchObject(new ApiError("NOT_FOUND", "Chat not found.", 404));
    });
    // ADR-0141 D6 preserves ordinary missing-resource errors without a global refresh.
    expect(api.inspectBrowserApprovals).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull();
  });

  it("connects in one click through the native launcher without a code dialog", async () => {
    active = false;
    vi.mocked(openLauncherBrowser).mockImplementation(async () => {
      active = true;
    });
    render(<BrowserApprovalNotice compact />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect browser" }));
    await waitFor(() => expect(openLauncherBrowser).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.requestBrowserApproval).not.toHaveBeenCalled();
    expect(api.approveBrowserRequest).not.toHaveBeenCalled();
  });

  it("reports an opener failure without starting the code flow or changing saved work", async () => {
    active = false;
    vi.mocked(openLauncherBrowser).mockRejectedValueOnce(new TypeError("unavailable"));
    render(<BrowserApprovalNotice compact />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect browser" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("reopen Keiko from its launcher");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.requestBrowserApproval).not.toHaveBeenCalled();
  });

  it("does not treat a launcher acknowledgement as authenticated access and offers a retry", async () => {
    active = false;
    vi.mocked(openLauncherBrowser).mockResolvedValue(undefined);
    render(<BrowserApprovalNotice compact />);
    const button = await screen.findByRole("button", { name: "Connect browser" });
    vi.useFakeTimers();
    fireEvent.click(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("reopen Keiko from its launcher");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps compact inventory retry read-only", async () => {
    active = false;
    vi.mocked(api.inspectBrowserApprovals).mockRejectedValueOnce(new TypeError("offline"));
    render(<BrowserApprovalNotice compact />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Connect browser" });
    expect(api.requestBrowserApproval).not.toHaveBeenCalled();
    expect(api.approveBrowserRequest).not.toHaveBeenCalled();
  });

  it("rechecks a local self-revocation without waiting for focus", async () => {
    render(
      <>
        <BrowserApprovalNotice />
        <BrowserApprovalSettings />
      </>,
    );
    const revoke = await screen.findByRole("button", { name: "Revoke approval" });
    expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull();
    fireEvent.click(revoke);
    await screen.findByRole("button", { name: "Connect browser" });
    expect(api.revokeBrowserApproval).toHaveBeenCalledOnce();
    expect(vi.mocked(api.inspectBrowserApprovals).mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("inspects after a repair acknowledgement and never treats that acknowledgement as authority", async () => {
    render(<BrowserApprovalNotice />);
    await waitFor(() => expect(api.inspectBrowserApprovals).toHaveBeenCalledOnce());
    active = false;
    const post = vi.fn().mockResolvedValue({ schemaVersion: "1" });
    await act(async () => {
      expect(await ensureLocalCodingAppSession(repairSeams(post))).toBe(true);
    });
    await screen.findByRole("button", { name: "Connect browser" });
    expect(post).toHaveBeenCalledOnce();
  });

  it("also rechecks protected availability after a failed repair", async () => {
    render(<BrowserApprovalNotice />);
    await waitFor(() => expect(api.inspectBrowserApprovals).toHaveBeenCalledOnce());
    active = false;
    await act(async () => {
      expect(
        await ensureLocalCodingAppSession(
          repairSeams(async () => {
            throw new TypeError("offline");
          }),
        ),
      ).toBe(false);
    });
    await screen.findByRole("button", { name: "Connect browser" });
  });

  it("refreshes dependent readers after focus verifies a newly usable cookie, without a notification loop", async () => {
    active = false;
    render(
      <>
        <BrowserApprovalNotice />
        <RefreshCounter />
      </>,
    );
    await screen.findByRole("button", { name: "Connect browser" });
    const before = Number(screen.getByLabelText("Session refresh revision").textContent);
    active = true;
    fireEvent.focus(window);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Connect browser" })).toBeNull(),
    );
    await waitFor(() =>
      expect(Number(screen.getByLabelText("Session refresh revision").textContent)).toBeGreaterThan(
        before,
      ),
    );
    const after = screen.getByLabelText("Session refresh revision").textContent;
    const reads = vi.mocked(api.inspectBrowserApprovals).mock.calls.length;
    fireEvent.focus(window);
    await waitFor(() =>
      expect(vi.mocked(api.inspectBrowserApprovals).mock.calls.length).toBeGreaterThan(reads),
    );
    expect(screen.getByLabelText("Session refresh revision").textContent).toBe(after);
  });

  it("ignores an obsolete active response delivered after a newer unavailable inspection", async () => {
    let deliver: ((value: BrowserApprovalManagementResult) => void) | undefined;
    const old = inspection();
    vi.mocked(api.inspectBrowserApprovals).mockImplementationOnce(
      () =>
        new Promise((resolve): void => {
          deliver = resolve;
        }),
    );
    active = false;
    render(<BrowserApprovalNotice />);
    await waitFor(() => expect(deliver).toBeDefined());
    fireEvent.focus(window);
    await screen.findByRole("button", { name: "Connect browser" });
    expect(vi.mocked(api.inspectBrowserApprovals).mock.calls[0]?.[0]?.aborted).toBe(true);
    await act(async () => {
      deliver?.(old);
    });
    expect(screen.getByRole("button", { name: "Connect browser" })).toBeInTheDocument();
  });
});
