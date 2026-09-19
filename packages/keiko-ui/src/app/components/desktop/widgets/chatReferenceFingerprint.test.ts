import { act, renderHook, waitFor, type RenderHookResult } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Chat, ProjectWithAvailability } from "@/lib/types";

import { ChatListLoadError, type ChatListLoad } from "../hooks/useChatSession";
import {
  chatReferenceFingerprint,
  findChatByFingerprint,
  useChatReferenceFingerprint,
  useChatReferenceRebind,
  type ChatReferenceRebind,
} from "./chatReferenceFingerprint";

type RebindSession = Parameters<typeof useChatReferenceRebind>[1];

interface RebindProps {
  readonly cfg: Record<string, unknown>;
  readonly session: RebindSession;
}

const sharedFetchChatsWithEvidenceMock = vi.hoisted(() =>
  vi.fn((_projectPath: string): Promise<ChatListLoad> =>
    Promise.resolve({ chats: [], correlationId: "ui_list-0000" }),
  ),
);
const reportClientDiagnosticMock = vi.hoisted(() => vi.fn());

vi.mock("../hooks/useChatSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useChatSession")>()),
  sharedFetchChatsWithEvidence: sharedFetchChatsWithEvidenceMock,
}));
vi.mock("@/lib/client-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-diagnostics")>()),
  reportClientDiagnostic: reportClientDiagnosticMock,
}));

// A chat id the shared secret heuristic flags (its digits across the last hyphen are Luhn-valid).
const FLAGGED_ID = "1404206d-9ab6-4bca-8853-813867352087";
const CLEAN_ID = "0f7c2e9a-3b1d-4c5e-9a8b-7d6c5b4a3f2e";

function project(path: string): ProjectWithAvailability {
  return { path, name: path, favorite: false, createdAt: 1, lastOpenedAt: 1, available: true };
}

function chat(id: string, projectPath: string, status: Chat["status"] = "open"): Chat {
  return { id, projectPath, status, title: "Deploy status" } as unknown as Chat;
}

function listed(chats: readonly Chat[], correlationId = "ui_list-0001"): ChatListLoad {
  return { chats, correlationId };
}

// A transport failure: no response could carry an id, so the load keeps the one it was sent with.
function unreadable(correlationId = "ui_list-failed-0001"): ChatListLoadError {
  return new ChatListLoadError(new TypeError("Failed to fetch"), correlationId);
}

afterEach(() => {
  sharedFetchChatsWithEvidenceMock.mockReset();
  sharedFetchChatsWithEvidenceMock.mockResolvedValue(listed([]));
  reportClientDiagnosticMock.mockReset();
});

describe("chatReferenceFingerprint", () => {
  it("is a stable 64-hex digest that names only its own id", () => {
    const fingerprint = chatReferenceFingerprint(FLAGGED_ID);

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(chatReferenceFingerprint(FLAGGED_ID)).toBe(fingerprint);
    expect(chatReferenceFingerprint(CLEAN_ID)).not.toBe(fingerprint);
    expect(fingerprint).not.toContain("8853");
  });
});

describe("findChatByFingerprint", () => {
  const fingerprint = chatReferenceFingerprint(FLAGGED_ID);

  it("finds the open chat whose id has the fingerprint, named by the load that listed it", async () => {
    sharedFetchChatsWithEvidenceMock.mockImplementation((path) =>
      Promise.resolve(
        path === "/repo-b"
          ? listed([chat(FLAGGED_ID, path)], "ui_list-repo-b")
          : listed([chat("chat-a", path)], "ui_list-repo-a"),
      ),
    );

    const lookup = await findChatByFingerprint(fingerprint, [
      project("/repo-a"),
      project("/repo-b"),
    ]);

    expect(lookup).toMatchObject({ status: "found", correlationId: "ui_list-repo-b" });
    expect(lookup.status === "found" ? lookup.chat.id : undefined).toBe(FLAGGED_ID);
  });

  it("never matches a closed chat", async () => {
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(
      listed([chat(FLAGGED_ID, "/repo", "closed")]),
    );

    await expect(findChatByFingerprint(fingerprint, [project("/repo")])).resolves.toEqual({
      status: "absent",
    });
  });

  // #3557 review: a failed list is not an authoritative empty one, and its failure keeps the id
  // its load was sent with and a closed class.
  it("stays undecided when a list it could not read may hold the chat, naming that load", async () => {
    sharedFetchChatsWithEvidenceMock.mockImplementation((path) =>
      path === "/repo-a"
        ? Promise.reject(unreadable())
        : Promise.resolve(listed([chat(CLEAN_ID, path)])),
    );

    await expect(
      findChatByFingerprint(fingerprint, [project("/repo-a"), project("/repo-b")]),
    ).resolves.toEqual({ status: "unavailable" });
    expect(reportClientDiagnosticMock).toHaveBeenCalledWith(
      "[keiko] chat reference lookup failed: TypeError",
      { correlationId: "ui_list-failed-0001", errorKind: "unavailable" },
    );
  });

  it("still finds the chat in a list it could read when another fails", async () => {
    sharedFetchChatsWithEvidenceMock.mockImplementation((path) =>
      path === "/repo-a"
        ? Promise.reject(unreadable())
        : Promise.resolve(listed([chat(FLAGGED_ID, path)])),
    );

    const lookup = await findChatByFingerprint(fingerprint, [
      project("/repo-a"),
      project("/repo-b"),
    ]);

    expect(lookup).toMatchObject({ status: "found" });
  });
});

describe("useChatReferenceFingerprint", () => {
  // #3557 review: recorded in the commit that shows the id, so no flush can store it alone.
  it("records the fingerprint of a flagged id in the commit that shows it", () => {
    const updateCfg = vi.fn();

    renderHook(() => useChatReferenceFingerprint(FLAGGED_ID, undefined, updateCfg));

    expect(updateCfg).toHaveBeenCalledWith({
      chatIdFingerprint: chatReferenceFingerprint(FLAGGED_ID),
    });
  });

  it("records nothing for an unflagged id, a redacted id, or an unchanged fingerprint", () => {
    const updateCfg = vi.fn();

    renderHook(() => useChatReferenceFingerprint(CLEAN_ID, undefined, updateCfg));
    renderHook(() => useChatReferenceFingerprint("[REDACTED]", undefined, updateCfg));
    renderHook(() =>
      useChatReferenceFingerprint(FLAGGED_ID, chatReferenceFingerprint(FLAGGED_ID), updateCfg),
    );

    expect(updateCfg).not.toHaveBeenCalled();
  });
});

describe("useChatReferenceRebind", () => {
  const repo = [project("/repo")];
  const session = { loading: false, projects: repo };
  const redacted = {
    chatId: "[REDACTED]",
    chatIdFingerprint: chatReferenceFingerprint(FLAGGED_ID),
    projectPath: "/repo",
  };

  function renderRebind(
    cfg: Record<string, unknown>,
    rebindSession: RebindSession,
    updateCfg: Parameters<typeof useChatReferenceRebind>[2],
  ): RenderHookResult<ChatReferenceRebind, RebindProps> {
    return renderHook(
      (props: RebindProps) => useChatReferenceRebind(props.cfg, props.session, updateCfg),
      { initialProps: { cfg, session: rebindSession } },
    );
  }

  it("stays pending until the fingerprint finds the chat, then binds the window to it", async () => {
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(
      listed([chat(FLAGGED_ID, "/repo")], "ui_list-c1"),
    );
    const updateCfg = vi.fn();

    const view = renderRebind(redacted, session, updateCfg);

    expect(view.result.current.pending).toBe(true);
    await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID }));
    view.rerender({ cfg: { ...redacted, chatId: FLAGGED_ID }, session });
    // The binding carries the load that decided it, never a later one.
    expect(view.result.current).toEqual({
      pending: false,
      restored: { correlationId: "ui_list-c1" },
    });
    view.rerender({ cfg: { ...redacted, chatId: "chat-elsewhere" }, session });
    expect(view.result.current.restored).toBeUndefined();
  });

  // #3557 review: a redaction marker without a fingerprint identifies nothing. The chat it named may
  // be gone while another flagged chat is the only one left; binding to it would open the wrong
  // conversation, so such a window is never rebound.
  it("never rebinds a redaction marker without a fingerprint, even to the only flagged chat", () => {
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(listed([chat(FLAGGED_ID, "/repo")]));
    const updateCfg = vi.fn();

    const view = renderRebind({ chatId: "[REDACTED]", projectPath: "/repo" }, session, updateCfg);

    expect(view.result.current).toEqual({ pending: false, restored: undefined });
    expect(sharedFetchChatsWithEvidenceMock).not.toHaveBeenCalled();
    expect(updateCfg).not.toHaveBeenCalled();
  });

  it("settles without a binding when no listed chat has the fingerprint", async () => {
    const updateCfg = vi.fn();

    const view = renderRebind(
      { chatId: "[REDACTED]", chatIdFingerprint: "a".repeat(64), projectPath: "/repo" },
      session,
      updateCfg,
    );

    await waitFor(() =>
      expect(view.result.current).toEqual({ pending: false, restored: undefined }),
    );
    expect(updateCfg).not.toHaveBeenCalled();
  });

  // #3557 review: a transient list failure must not settle the window as missing for good.
  it("looks again at once when the listed projects change after a list could not be read", async () => {
    sharedFetchChatsWithEvidenceMock
      .mockRejectedValueOnce(unreadable())
      .mockResolvedValue(listed([chat(FLAGGED_ID, "/repo")]));
    const updateCfg = vi.fn();

    const view = renderRebind(redacted, session, updateCfg);

    await waitFor(() => expect(sharedFetchChatsWithEvidenceMock).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(view.result.current.pending).toBe(true);
    expect(updateCfg).not.toHaveBeenCalled();
    view.rerender({ cfg: redacted, session: { loading: false, projects: [project("/repo")] } });

    await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID }));
  });

  it("looks again after a backoff while the list stays unreadable", async () => {
    vi.useFakeTimers();
    try {
      sharedFetchChatsWithEvidenceMock
        .mockRejectedValueOnce(unreadable())
        .mockResolvedValue(listed([chat(FLAGGED_ID, "/repo")]));
      const updateCfg = vi.fn();

      const view = renderRebind(redacted, session, updateCfg);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(view.result.current.pending).toBe(true);
      expect(updateCfg).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID });
    } finally {
      vi.useRealTimers();
    }
  });

  // #3557 review: a failed project catalog leaves the projects empty; that is no answer at all.
  it("stays undecided while the project catalog failed, and binds once it loads", async () => {
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(listed([chat(FLAGGED_ID, "/repo")]));
    const updateCfg = vi.fn();
    const failedCatalog = { loading: false, error: "Projects could not be loaded", projects: [] };

    const view = renderRebind(redacted, failedCatalog, updateCfg);
    await act(async () => Promise.resolve());

    expect(view.result.current.pending).toBe(true);
    expect(sharedFetchChatsWithEvidenceMock).not.toHaveBeenCalled();
    view.rerender({ cfg: redacted, session });
    await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID }));
  });

  it("stays undecided while the window's own project is not listed", async () => {
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(listed([chat(FLAGGED_ID, "/repo")]));
    const updateCfg = vi.fn();

    const view = renderRebind(
      redacted,
      { loading: false, projects: [project("/other")] },
      updateCfg,
    );
    await act(async () => Promise.resolve());

    expect(view.result.current.pending).toBe(true);
    expect(sharedFetchChatsWithEvidenceMock).not.toHaveBeenCalled();
    view.rerender({
      cfg: redacted,
      session: { loading: false, projects: [project("/other"), ...repo] },
    });
    await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID }));
  });

  it("never rebinds a live id, a malformed fingerprint, or before the session loaded", () => {
    const updateCfg = vi.fn();

    const live = renderRebind(
      { chatId: FLAGGED_ID, chatIdFingerprint: "a".repeat(64) },
      session,
      updateCfg,
    );
    const malformed = renderRebind(
      { chatId: "[REDACTED]", chatIdFingerprint: "not-a-digest" },
      session,
      updateCfg,
    );
    const loading = renderRebind(
      { chatId: "[REDACTED]", chatIdFingerprint: "a".repeat(64) },
      { loading: true, projects: [] },
      updateCfg,
    );

    expect(live.result.current.pending).toBe(false);
    expect(malformed.result.current.pending).toBe(false);
    expect(loading.result.current.pending).toBe(true);
    expect(sharedFetchChatsWithEvidenceMock).not.toHaveBeenCalled();
  });
});
