import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Chat, ProjectWithAvailability } from "@/lib/types";

import {
  chatReferenceFingerprint,
  findChatByFingerprint,
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

function project(path: string): ProjectWithAvailability {
  return { path, name: path, favorite: false, createdAt: 1, lastOpenedAt: 1, available: true };
}

function chat(id: string, projectPath: string, status: Chat["status"] = "open"): Chat {
  return { id, projectPath, status, title: "Deploy status" } as unknown as Chat;
}

function listing(chats: readonly Chat[]): {
  readonly chats: readonly Chat[];
  correlationId: string;
} {
  return { chats, correlationId: "ui_list-0001" };
}

afterEach(() => {
  sharedFetchChatsMock.mockReset();
  sharedFetchChatsMock.mockResolvedValue(listing([]));
  reportClientDiagnosticMock.mockReset();
});

describe("chatReferenceFingerprint", () => {
  it("is a stable 64-hex digest that names only its own id", async () => {
    const fingerprint = await chatReferenceFingerprint(FLAGGED_ID);

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(await chatReferenceFingerprint(FLAGGED_ID)).toBe(fingerprint);
    expect(await chatReferenceFingerprint("0f7c2e9a-3b1d-4c5e-9a8b-7d6c5b4a3f2e")).not.toBe(
      fingerprint,
    );
    expect(fingerprint).not.toContain("8853");
  });
});

describe("findChatByFingerprint", () => {
  it("finds the open chat whose id has the fingerprint, across projects", async () => {
    sharedFetchChatsMock.mockImplementation((path) =>
      Promise.resolve(
        listing(
          path === "/repo-b"
            ? [chat("chat-b", path), chat(FLAGGED_ID, path)]
            : [chat("chat-a", path)],
        ),
      ),
    );

    const match = await findChatByFingerprint(await chatReferenceFingerprint(FLAGGED_ID), [
      project("/repo-a"),
      project("/repo-b"),
    ]);

    expect(match?.id).toBe(FLAGGED_ID);
    expect(match?.projectPath).toBe("/repo-b");
  });

  it("never matches a closed chat", async () => {
    sharedFetchChatsMock.mockResolvedValue(listing([chat(FLAGGED_ID, "/repo", "closed")]));

    await expect(
      findChatByFingerprint(await chatReferenceFingerprint(FLAGGED_ID), [project("/repo")]),
    ).resolves.toBeUndefined();
  });

  it("reports a list that cannot be read and still searches the others", async () => {
    sharedFetchChatsMock.mockImplementation((path) =>
      path === "/repo-a"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(listing([chat(FLAGGED_ID, path)])),
    );

    const match = await findChatByFingerprint(await chatReferenceFingerprint(FLAGGED_ID), [
      project("/repo-a"),
      project("/repo-b"),
    ]);

    expect(match?.id).toBe(FLAGGED_ID);
    expect(reportClientDiagnosticMock).toHaveBeenCalledWith(
      "[keiko] chat reference lookup failed: TypeError",
    );
  });
});

describe("useChatReferenceFingerprint", () => {
  it("records the fingerprint of a bound chat whose id the heuristic flags", async () => {
    const updateCfg = vi.fn();

    renderHook(() => useChatReferenceFingerprint(FLAGGED_ID, undefined, true, updateCfg));

    const fingerprint = await chatReferenceFingerprint(FLAGGED_ID);
    await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ chatIdFingerprint: fingerprint }));
  });

  it("records nothing for an unflagged id, an unbound chat, or an unchanged fingerprint", async () => {
    const updateCfg = vi.fn();
    const recorded = await chatReferenceFingerprint(FLAGGED_ID);

    renderHook(() =>
      useChatReferenceFingerprint(
        "0f7c2e9a-3b1d-4c5e-9a8b-7d6c5b4a3f2e",
        undefined,
        true,
        updateCfg,
      ),
    );
    renderHook(() => useChatReferenceFingerprint(FLAGGED_ID, undefined, false, updateCfg));
    renderHook(() => useChatReferenceFingerprint(FLAGGED_ID, recorded, true, updateCfg));
    await chatReferenceFingerprint(FLAGGED_ID);

    expect(updateCfg).not.toHaveBeenCalled();
  });
});

describe("useChatReferenceRebind", () => {
  it("stays pending until the fingerprint finds the chat, then binds the window to it", async () => {
    const fingerprint = await chatReferenceFingerprint(FLAGGED_ID);
    sharedFetchChatsMock.mockResolvedValue(listing([chat(FLAGGED_ID, "/repo")]));
    const updateCfg = vi.fn();
    const cfg = { chatId: "[REDACTED]", chatIdFingerprint: fingerprint, projectPath: "/repo" };

    const view = renderHook(() =>
      useChatReferenceRebind(cfg, { loading: false, projects: [project("/repo")] }, updateCfg),
    );

    expect(view.result.current.pending).toBe(true);
    await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID }));
    await waitFor(() => expect(view.result.current).toEqual({ pending: false, restored: true }));
  });

  it("settles without a binding when no listed chat has the fingerprint", async () => {
    const updateCfg = vi.fn();
    const cfg = { chatId: "[REDACTED]", chatIdFingerprint: "a".repeat(64), projectPath: "/repo" };

    const view = renderHook(() =>
      useChatReferenceRebind(cfg, { loading: false, projects: [project("/repo")] }, updateCfg),
    );

    await waitFor(() => expect(view.result.current).toEqual({ pending: false, restored: false }));
    expect(updateCfg).not.toHaveBeenCalled();
  });

  it("never rebinds a live id, a malformed fingerprint, or before the session loaded", () => {
    const updateCfg = vi.fn();
    const session = { loading: false, projects: [project("/repo")] };

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
