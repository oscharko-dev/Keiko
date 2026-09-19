import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Chat, ProjectWithAvailability } from "@/lib/types";

import {
  chatReferenceFingerprint,
  findRestoredChat,
  useChatReferenceFingerprint,
  useChatReferenceRebind,
} from "./chatReferenceFingerprint";

const sharedFetchChatsMock = vi.hoisted(() =>
  vi.fn(
    (_projectPath: string): Promise<{ readonly chats: readonly Chat[]; correlationId: string }> =>
      Promise.resolve({ chats: [], correlationId: "ui_list-0000" }),
  ),
);
const reportClientDiagnosticMock = vi.hoisted(() => vi.fn());

vi.mock("../hooks/useChatSession", () => ({ sharedFetchChats: sharedFetchChatsMock }));
vi.mock("@/lib/client-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-diagnostics")>()),
  reportClientDiagnostic: reportClientDiagnosticMock,
}));

// A chat id the shared secret heuristic flags (its digits across the last hyphen are Luhn-valid).
const FLAGGED_ID = "1404206d-9ab6-4bca-8853-813867352087";
// A second flagged id: the same digits, another first group.
const OTHER_FLAGGED_ID = "2404206d-9ab6-4bca-8853-813867352087";
const CLEAN_ID = "0f7c2e9a-3b1d-4c5e-9a8b-7d6c5b4a3f2e";

function project(path: string): ProjectWithAvailability {
  return { path, name: path, favorite: false, createdAt: 1, lastOpenedAt: 1, available: true };
}

function chat(id: string, projectPath: string, status: Chat["status"] = "open"): Chat {
  return { id, projectPath, status, title: "Deploy status" } as unknown as Chat;
}

function listing(
  chats: readonly Chat[],
  correlationId = "ui_list-0001",
): { readonly chats: readonly Chat[]; correlationId: string } {
  return { chats, correlationId };
}

// Each project's list answers under its own load id.
function listsByProject(chatsByPath: Readonly<Record<string, readonly Chat[]>>): void {
  sharedFetchChatsMock.mockImplementation((path) =>
    Promise.resolve(listing(chatsByPath[path] ?? [], `ui_list-${path.slice(1)}`)),
  );
}

afterEach(() => {
  sharedFetchChatsMock.mockReset();
  sharedFetchChatsMock.mockResolvedValue(listing([]));
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

describe("findRestoredChat through a fingerprint", () => {
  const target = {
    kind: "fingerprint" as const,
    fingerprint: chatReferenceFingerprint(FLAGGED_ID),
  };

  it("finds the open chat whose id has the fingerprint, named by the load that listed it", async () => {
    listsByProject({ "/repo-a": [chat("chat-a", "/repo-a")], "/repo-b": [chat(FLAGGED_ID, "/b")] });

    const lookup = await findRestoredChat(target, [project("/repo-a"), project("/repo-b")]);

    expect(lookup).toMatchObject({
      status: "found",
      shape: "fingerprint",
      correlationIds: ["ui_list-repo-b"],
    });
    expect(lookup.status === "found" ? lookup.chat.id : undefined).toBe(FLAGGED_ID);
  });

  it("never matches a closed chat", async () => {
    sharedFetchChatsMock.mockResolvedValue(listing([chat(FLAGGED_ID, "/repo", "closed")]));

    await expect(findRestoredChat(target, [project("/repo")])).resolves.toEqual({
      status: "absent",
    });
  });

  // #3557 review: a failed list is not an authoritative empty one.
  it("stays undecided when a list it could not read may hold the chat", async () => {
    sharedFetchChatsMock.mockImplementation((path) =>
      path === "/repo-a"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(listing([chat(CLEAN_ID, path)])),
    );

    await expect(
      findRestoredChat(target, [project("/repo-a"), project("/repo-b")]),
    ).resolves.toEqual({ status: "unavailable" });
    expect(reportClientDiagnosticMock).toHaveBeenCalledWith(
      "[keiko] chat reference lookup failed: TypeError",
      { correlationId: undefined },
    );
  });

  it("still finds the chat in a list it could read when another fails", async () => {
    sharedFetchChatsMock.mockImplementation((path) =>
      path === "/repo-a"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(listing([chat(FLAGGED_ID, path)])),
    );

    const lookup = await findRestoredChat(target, [project("/repo-a"), project("/repo-b")]);

    expect(lookup).toMatchObject({ status: "found", shape: "fingerprint" });
  });
});

// #3557 review (P0): a snapshot an older build wrote holds the redaction marker and no fingerprint.
describe("findRestoredChat for a redacted reference without a fingerprint", () => {
  const target = { kind: "sole-candidate" as const };

  it("finds the only listed chat whose id persistence redacts, decided by every list", async () => {
    listsByProject({
      "/repo-a": [chat(CLEAN_ID, "/repo-a")],
      "/repo-b": [chat(FLAGGED_ID, "/repo-b"), chat("chat-b", "/repo-b")],
    });

    const lookup = await findRestoredChat(target, [project("/repo-a"), project("/repo-b")]);

    expect(lookup).toMatchObject({
      status: "found",
      shape: "sole-candidate",
      correlationIds: ["ui_list-repo-a", "ui_list-repo-b"],
    });
    expect(lookup.status === "found" ? lookup.chat.id : undefined).toBe(FLAGGED_ID);
  });

  it("never picks between two chats whose ids persistence redacts", async () => {
    sharedFetchChatsMock.mockResolvedValue(
      listing([chat(FLAGGED_ID, "/repo"), chat(OTHER_FLAGGED_ID, "/repo")]),
    );

    await expect(findRestoredChat(target, [project("/repo")])).resolves.toEqual({
      status: "absent",
    });
  });

  it("finds nothing when no listed chat has such an id", async () => {
    sharedFetchChatsMock.mockResolvedValue(listing([chat(CLEAN_ID, "/repo")]));

    await expect(findRestoredChat(target, [project("/repo")])).resolves.toEqual({
      status: "absent",
    });
  });

  it("never decides while a list that could hold a second candidate is unreadable", async () => {
    sharedFetchChatsMock.mockImplementation((path) =>
      path === "/repo-a"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(listing([chat(FLAGGED_ID, path)])),
    );

    await expect(
      findRestoredChat(target, [project("/repo-a"), project("/repo-b")]),
    ).resolves.toEqual({ status: "unavailable" });
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

  it("stays pending until the fingerprint finds the chat, then binds the window to it", async () => {
    sharedFetchChatsMock.mockResolvedValue(listing([chat(FLAGGED_ID, "/repo")], "ui_list-c1"));
    const updateCfg = vi.fn();
    const cfg = {
      chatId: "[REDACTED]",
      chatIdFingerprint: chatReferenceFingerprint(FLAGGED_ID),
      projectPath: "/repo",
    };

    const view = renderHook(
      ({ current }: { current: Record<string, unknown> }) =>
        useChatReferenceRebind(current, session, updateCfg),
      { initialProps: { current: cfg } },
    );

    expect(view.result.current.pending).toBe(true);
    await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID }));
    view.rerender({ current: { ...cfg, chatId: FLAGGED_ID } });
    // The binding carries the load that decided it, never a later one.
    expect(view.result.current).toEqual({
      pending: false,
      restored: { shape: "fingerprint", correlationIds: ["ui_list-c1"] },
    });
    view.rerender({ current: { ...cfg, chatId: "chat-elsewhere" } });
    expect(view.result.current.restored).toBeUndefined();
  });

  it("rebinds a window an older build persisted without a fingerprint to its sole candidate", async () => {
    sharedFetchChatsMock.mockResolvedValue(
      listing([chat(FLAGGED_ID, "/repo"), chat(CLEAN_ID, "/repo")], "ui_list-c1"),
    );
    const updateCfg = vi.fn();
    const cfg = { chatId: "[REDACTED]", projectPath: "/repo" };

    const view = renderHook(
      ({ current }: { current: Record<string, unknown> }) =>
        useChatReferenceRebind(current, session, updateCfg),
      { initialProps: { current: cfg } },
    );

    await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID }));
    view.rerender({ current: { ...cfg, chatId: FLAGGED_ID } });
    expect(view.result.current).toEqual({
      pending: false,
      restored: { shape: "sole-candidate", correlationIds: ["ui_list-c1"] },
    });
  });

  it("settles without a binding when no listed chat has the fingerprint", async () => {
    const updateCfg = vi.fn();
    const cfg = { chatId: "[REDACTED]", chatIdFingerprint: "a".repeat(64), projectPath: "/repo" };

    const view = renderHook(() => useChatReferenceRebind(cfg, session, updateCfg));

    await waitFor(() =>
      expect(view.result.current).toEqual({ pending: false, restored: undefined }),
    );
    expect(updateCfg).not.toHaveBeenCalled();
  });

  // #3557 review: a transient list failure must not settle the window as missing for good.
  it("looks again at once when the listed projects change after a list could not be read", async () => {
    sharedFetchChatsMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(listing([chat(FLAGGED_ID, "/repo")]));
    const updateCfg = vi.fn();
    const cfg = { chatId: "[REDACTED]", chatIdFingerprint: chatReferenceFingerprint(FLAGGED_ID) };

    const view = renderHook(
      ({ current }: { current: typeof session }) => useChatReferenceRebind(cfg, current, updateCfg),
      { initialProps: { current: session } },
    );

    await waitFor(() => expect(sharedFetchChatsMock).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(view.result.current.pending).toBe(true);
    expect(updateCfg).not.toHaveBeenCalled();
    view.rerender({ current: { loading: false, projects: [project("/repo")] } });

    await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID }));
  });

  it("looks again after a backoff while the list stays unreadable", async () => {
    vi.useFakeTimers();
    try {
      sharedFetchChatsMock
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValue(listing([chat(FLAGGED_ID, "/repo")]));
      const updateCfg = vi.fn();
      const cfg = { chatId: "[REDACTED]", chatIdFingerprint: chatReferenceFingerprint(FLAGGED_ID) };

      const view = renderHook(() => useChatReferenceRebind(cfg, session, updateCfg));
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

  it("never rebinds a live id, a malformed fingerprint, or before the session loaded", () => {
    const updateCfg = vi.fn();

    const live = renderHook(() =>
      useChatReferenceRebind(
        { chatId: FLAGGED_ID, chatIdFingerprint: "a".repeat(64) },
        session,
        updateCfg,
      ),
    );
    const malformed = renderHook(() =>
      useChatReferenceRebind(
        { chatId: "[REDACTED]", chatIdFingerprint: "not-a-digest" },
        session,
        updateCfg,
      ),
    );
    const loading = renderHook(() =>
      useChatReferenceRebind(
        { chatId: "[REDACTED]", chatIdFingerprint: "a".repeat(64) },
        { loading: true, projects: [] },
        updateCfg,
      ),
    );

    expect(live.result.current.pending).toBe(false);
    expect(malformed.result.current.pending).toBe(false);
    expect(loading.result.current.pending).toBe(true);
    expect(sharedFetchChatsMock).not.toHaveBeenCalled();
  });
});
