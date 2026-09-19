import { act, renderHook, waitFor, type RenderHookResult } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Chat, ProjectWithAvailability } from "@/lib/types";

import { ChatListLoadError, type ChatListLoad } from "../hooks/useChatSession";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import { persistedReferenceEvidence } from "../hooks/workspace-persistence";
import {
  chatChoiceReferences,
  chatReferenceFingerprint,
  findChatByFingerprint,
  useChatReferenceFingerprint,
  useChatChoiceDecision,
  useChatReferenceRebind,
  useRedactedChatChoice,
  type ChatReferenceRebind,
} from "./chatReferenceFingerprint";

type RebindSession = Parameters<typeof useChatReferenceRebind>[1];
type ChoiceWindow = Parameters<typeof useRedactedChatChoice>[2];

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

function chat(
  id: string,
  projectPath: string,
  status: Chat["status"] = "open",
  updatedAt = 1,
  title = "Deploy status",
): Chat {
  return { id, projectPath, status, title, updatedAt } as unknown as Chat;
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

// #3557 review: two offers can share a title and a last-active second. Each then shows the start of
// its chat's fingerprint, long enough to tell them apart, so no two offers ever read alike.
describe("chatChoiceReferences", () => {
  // Two flagged ids found by search whose fingerprints share their first six hex digits.
  const PREFIX_TWIN_A = "a0001280-9ab6-4bca-8853-813867352087";
  const PREFIX_TWIN_B = "a0001aee-9ab6-4bca-8853-813867352087";

  function offer(id: string, label: string): { readonly chat: Chat; readonly label: string } {
    return { chat: chat(id, "/repo"), label };
  }

  it("gives an offer whose label is its own no reference", () => {
    expect(chatChoiceReferences([offer(FLAGGED_ID, "Open A"), offer(CLEAN_ID, "Open B")])).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("tells offers that read alike apart by the start of their fingerprints", () => {
    const references = chatChoiceReferences([
      offer(FLAGGED_ID, "Open New chat"),
      offer(CLEAN_ID, "Open Deploy status"),
      offer(PREFIX_TWIN_A, "Open New chat"),
    ]);

    expect(references[1]).toBeUndefined();
    expect(references[0]).toBe(chatReferenceFingerprint(FLAGGED_ID).slice(0, 6));
    expect(references[2]).toBe(chatReferenceFingerprint(PREFIX_TWIN_A).slice(0, 6));
    expect(references[0]).not.toBe(references[2]);
  });

  it("lengthens the references until fingerprints that share a prefix differ", () => {
    const twinA = chatReferenceFingerprint(PREFIX_TWIN_A);
    const twinB = chatReferenceFingerprint(PREFIX_TWIN_B);
    // The fixture's premise, derived from the production fingerprint.
    expect(twinA.slice(0, 6)).toBe(twinB.slice(0, 6));
    expect(twinA.slice(0, 7)).not.toBe(twinB.slice(0, 7));
    expect(persistedReferenceEvidence(PREFIX_TWIN_A).heuristicFlagged).toBe(true);
    expect(persistedReferenceEvidence(PREFIX_TWIN_B).heuristicFlagged).toBe(true);

    const references = chatChoiceReferences([
      offer(PREFIX_TWIN_A, "Open New chat"),
      offer(PREFIX_TWIN_B, "Open New chat"),
    ]);

    expect(references).toEqual([twinA.slice(0, 7), twinB.slice(0, 7)]);
    expect(references.join()).not.toContain("9ab6");
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
      restored: { shape: "fingerprint", correlationId: "ui_list-c1" },
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

  // #3557 review: a failed project catalog is no answer about the chat, and neither is a catalog that
  // lacks the window's project. The window stops waiting and shows that state the way it does for
  // any chat; nothing is settled, and the lookup runs once the catalog changes.
  it("hands a failed catalog to the window, and binds once the catalog loads", async () => {
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(listed([chat(FLAGGED_ID, "/repo")]));
    const updateCfg = vi.fn();
    const failedCatalog = { loading: false, error: "Projects could not be loaded", projects: [] };

    const view = renderRebind(redacted, failedCatalog, updateCfg);
    await act(async () => Promise.resolve());

    expect(view.result.current).toEqual({ pending: false, restored: undefined });
    expect(sharedFetchChatsWithEvidenceMock).not.toHaveBeenCalled();
    view.rerender({ cfg: redacted, session });
    await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID }));
  });

  it("hands a catalog without the window's project to the window, and binds once it is listed", async () => {
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(listed([chat(FLAGGED_ID, "/repo")]));
    const updateCfg = vi.fn();

    const view = renderRebind(
      redacted,
      { loading: false, projects: [project("/other")] },
      updateCfg,
    );
    await act(async () => Promise.resolve());

    expect(view.result.current).toEqual({ pending: false, restored: undefined });
    expect(sharedFetchChatsWithEvidenceMock).not.toHaveBeenCalled();
    view.rerender({
      cfg: redacted,
      session: { loading: false, projects: [project("/other"), ...repo] },
    });
    await waitFor(() => expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID }));
  });

  it("waits while the project catalog is loading", () => {
    const view = renderRebind(redacted, { loading: true, projects: [] }, vi.fn());

    expect(view.result.current.pending).toBe(true);
    expect(sharedFetchChatsWithEvidenceMock).not.toHaveBeenCalled();
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

// #3557 review (P0): a snapshot an older build wrote holds the redaction marker without a
// fingerprint. Nothing in it proves which chat it named, so the window never guesses: it offers the
// chats whose ids persistence redacts, and binds only to the one the person chooses.
describe("useRedactedChatChoice", () => {
  const OTHER_FLAGGED_ID = "2404206d-9ab6-4bca-8853-813867352087";
  const session = { loading: false, projects: [project("/repo")] };
  const legacy = { chatId: "[REDACTED]", projectPath: "/repo" };

  function windowOf(updateCfg: WindowRenderContext["updateCfg"]): ChoiceWindow {
    return { updateCfg, windowId: "window-legacy" };
  }

  function offerReports(): readonly unknown[][] {
    return reportClientDiagnosticMock.mock.calls.filter(([message]) =>
      String(message).startsWith("[keiko] chat window offered conversations"),
    );
  }

  it("offers the listed chats whose ids persistence redacts, and binds none on its own", async () => {
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(
      listed([chat(FLAGGED_ID, "/repo"), chat(OTHER_FLAGGED_ID, "/repo"), chat(CLEAN_ID, "/repo")]),
    );
    const updateCfg = vi.fn();

    const view = renderHook(() => useRedactedChatChoice(legacy, session, windowOf(updateCfg)));

    await waitFor(() =>
      expect(view.result.current.choice?.offers.map((offer) => offer.chat.id)).toEqual([
        FLAGGED_ID,
        OTHER_FLAGGED_ID,
      ]),
    );
    expect(updateCfg).not.toHaveBeenCalled();
    expect(view.result.current.restored).toBeUndefined();
  });

  it("binds the window to the chat the person chooses, named by the load that listed it", async () => {
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(
      listed([chat(FLAGGED_ID, "/repo"), chat(OTHER_FLAGGED_ID, "/repo")], "ui_list-choice-0001"),
    );
    const updateCfg = vi.fn();
    const view = renderHook(
      ({ cfg }: { cfg: Record<string, unknown> }) =>
        useRedactedChatChoice(cfg, session, windowOf(updateCfg)),
      { initialProps: { cfg: legacy as Record<string, unknown> } },
    );
    await waitFor(() => expect(view.result.current.choice).toBeDefined());
    const target = view.result.current.choice?.offers.find((o) => o.chat.id === FLAGGED_ID)?.chat;
    if (target === undefined) throw new Error("candidate missing");

    act(() => {
      view.result.current.choice?.choose(target);
    });
    view.rerender({ cfg: { ...legacy, chatId: FLAGGED_ID, chatIdChosen: true } });

    // The binding stays a choice until the person keeps it.
    expect(updateCfg).toHaveBeenCalledWith({ chatId: FLAGGED_ID, chatIdChosen: true });
    expect(view.result.current.restored).toEqual({
      shape: "user-selected",
      correlationId: "ui_list-choice-0001",
    });
  });

  it("offers nothing for a window with a fingerprint or a live id", () => {
    const updateCfg = vi.fn();

    const fingerprinted = renderHook(() =>
      useRedactedChatChoice(
        { ...legacy, chatIdFingerprint: chatReferenceFingerprint(FLAGGED_ID) },
        session,
        windowOf(updateCfg),
      ),
    );
    const live = renderHook(() =>
      useRedactedChatChoice(
        { chatId: FLAGGED_ID, projectPath: "/repo" },
        session,
        windowOf(updateCfg),
      ),
    );

    expect(fingerprinted.result.current.choice).toBeUndefined();
    expect(live.result.current.choice).toBeUndefined();
    expect(sharedFetchChatsWithEvidenceMock).not.toHaveBeenCalled();
    expect(offerReports()).toEqual([]);
  });

  it("offers the most recently active chat first", async () => {
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(
      listed([chat(FLAGGED_ID, "/repo", "open", 10), chat(OTHER_FLAGGED_ID, "/repo", "open", 20)]),
    );

    const view = renderHook(() => useRedactedChatChoice(legacy, session, windowOf(vi.fn())));

    await waitFor(() =>
      expect(view.result.current.choice?.offers.map((offer) => offer.chat.id)).toEqual([
        OTHER_FLAGGED_ID,
        FLAGGED_ID,
      ]),
    );
  });

  // #3557 review: the offer is reconstructable from the log, under the list load that decided it,
  // with its count and the window's own reference, and never a chat id.
  it("reports each offer once under the load that decided it, with its count", async () => {
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(
      listed(
        [
          chat(FLAGGED_ID, "/repo", "open", 10_000),
          chat(OTHER_FLAGGED_ID, "/repo", "open", 20_000),
        ],
        "ui_list-offer-0001",
      ),
    );
    const view = renderHook(() => useRedactedChatChoice(legacy, session, windowOf(vi.fn())));
    await waitFor(() => expect(view.result.current.choice).toBeDefined());
    view.rerender();
    view.rerender();

    expect(offerReports()).toEqual([
      [
        "[keiko] chat window offered conversations to choose from (candidates=2, disambiguated=0)",
        {
          correlationId: "ui_list-offer-0001",
          bindingReport: {
            surface: "chat-window",
            outcome: "candidates-offered",
            referenceShape: "redacted",
            heuristicFlagged: false,
            windowRef: "window-legacy",
            candidateCount: 2,
            disambiguatedCount: 0,
            decidingLoadCount: 1,
          },
        },
      ],
    ]);
    expect(JSON.stringify(reportClientDiagnosticMock.mock.calls)).not.toContain(FLAGGED_ID);
  });

  it("reports an empty offer, and names every load a window without a project read", async () => {
    sharedFetchChatsWithEvidenceMock.mockImplementation((path) =>
      Promise.resolve(listed([chat(CLEAN_ID, path)], `ui_list-${path.slice(1)}`)),
    );
    const everywhere = { loading: false, projects: [project("/repo-a"), project("/repo-b")] };

    const view = renderHook(() =>
      useRedactedChatChoice({ chatId: "[REDACTED]" }, everywhere, windowOf(vi.fn())),
    );

    await waitFor(() => expect(offerReports()).toHaveLength(1));
    expect(offerReports()[0]?.[1]).toEqual({
      correlationId: "ui_list-repo-a",
      bindingReport: expect.objectContaining({
        candidateCount: 0,
        disambiguatedCount: 0,
        relatedCorrelationIds: ["ui_list-repo-b"],
        decidingLoadCount: 2,
      }) as unknown,
    });
    expect(view.result.current.choice).toBeUndefined();
  });

  // #3557 review: a list that could not be read is no empty offer. The scan stays undecided, offers
  // and reports nothing, and runs again after a backoff until the person can choose.
  it("scans again after a backoff when a list could not be read", async () => {
    vi.useFakeTimers();
    try {
      sharedFetchChatsWithEvidenceMock
        .mockRejectedValueOnce(unreadable())
        .mockResolvedValue(listed([chat(FLAGGED_ID, "/repo")], "ui_list-offer-0002"));

      const view = renderHook(() => useRedactedChatChoice(legacy, session, windowOf(vi.fn())));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(view.result.current.choice).toBeUndefined();
      expect(offerReports()).toEqual([]);
      expect(reportClientDiagnosticMock).toHaveBeenCalledWith(
        "[keiko] chat reference lookup failed: TypeError",
        { correlationId: "ui_list-failed-0001", errorKind: "unavailable" },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(view.result.current.choice?.offers.map((offer) => offer.chat.id)).toEqual([
        FLAGGED_ID,
      ]);
      expect(offerReports()).toHaveLength(1);
      expect(offerReports()[0]?.[1]).toMatchObject({ correlationId: "ui_list-offer-0002" });
    } finally {
      vi.useRealTimers();
    }
  });

  // #3557 review: two offers that share a title and a last-active second read alike; each shows a
  // fingerprint reference, and the offer says how many needed one, so the log states what was seen.
  it("labels offers that read alike with a fingerprint reference, and counts them in the offer", async () => {
    const SOLO_FLAGGED_ID = "a0001280-9ab6-4bca-8853-813867352087";
    sharedFetchChatsWithEvidenceMock.mockResolvedValue(
      listed([
        chat(FLAGGED_ID, "/repo"),
        chat(OTHER_FLAGGED_ID, "/repo"),
        chat(SOLO_FLAGGED_ID, "/repo", "open", 1, "Release notes"),
      ]),
    );

    const view = renderHook(() => useRedactedChatChoice(legacy, session, windowOf(vi.fn())));

    await waitFor(() => expect(view.result.current.choice?.offers).toHaveLength(3));
    const labels = new Map(
      view.result.current.choice?.offers.map((offer) => [offer.chat.id, offer.label]),
    );
    for (const id of [FLAGGED_ID, OTHER_FLAGGED_ID]) {
      expect(labels.get(id)).toMatch(
        /^Open Deploy status, last active .+, reference [0-9a-f]{6,}$/u,
      );
      expect(labels.get(id)).toContain(`reference ${chatReferenceFingerprint(id).slice(0, 6)}`);
    }
    expect(labels.get(SOLO_FLAGGED_ID)).not.toContain("reference");
    expect(new Set(labels.values()).size).toBe(3);
    await waitFor(() => expect(offerReports()).toHaveLength(1));
    expect(offerReports()[0]?.[1]).toMatchObject({
      bindingReport: { candidateCount: 3, disambiguatedCount: 2 },
    });
  });

  it("scans again at once when the listed projects change after a list could not be read", async () => {
    sharedFetchChatsWithEvidenceMock
      .mockRejectedValueOnce(unreadable())
      .mockResolvedValue(listed([chat(FLAGGED_ID, "/repo")]));
    const view = renderHook(
      ({ current }: { current: typeof session }) =>
        useRedactedChatChoice(legacy, current, windowOf(vi.fn())),
      { initialProps: { current: session } },
    );
    await waitFor(() => expect(sharedFetchChatsWithEvidenceMock).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(view.result.current.choice).toBeUndefined();

    view.rerender({ current: { loading: false, projects: [project("/repo")] } });

    await waitFor(() => expect(view.result.current.choice).toBeDefined());
  });
});

// #3557 review: a chat the person chose without proof stays a choice until they keep it. They can
// keep it, or withdraw it and return the window to the chats it may have shown; each decision names
// the chat by its fingerprint, on the timeline of the load that decided the binding.
describe("useChatChoiceDecision", () => {
  const chosen = { chatId: FLAGGED_ID, chatIdChosen: true, projectPath: "/repo" };
  const restoration = { shape: "user-selected", correlationId: "ui_list-choice-0002" } as const;

  function decisionReports(): readonly unknown[][] {
    return reportClientDiagnosticMock.mock.calls.filter(([message]) =>
      String(message).includes("the conversation the person chose"),
    );
  }

  it("offers no decision for a binding the person already kept, or one not restored", () => {
    const window = { updateCfg: vi.fn(), windowId: "window-legacy" };

    const kept = renderHook(() =>
      useChatChoiceDecision({ ...chosen, chatIdChosen: false }, restoration, window),
    );
    const unrestored = renderHook(() => useChatChoiceDecision(chosen, undefined, window));

    expect(kept.result.current).toBeUndefined();
    expect(unrestored.result.current).toBeUndefined();
  });

  it("keeps the chosen chat, and names it by its fingerprint", () => {
    const updateCfg = vi.fn();
    const view = renderHook(() =>
      useChatChoiceDecision(chosen, restoration, { updateCfg, windowId: "window-legacy" }),
    );

    act(() => {
      view.result.current?.keep();
    });

    expect(updateCfg).toHaveBeenCalledWith({ chatIdChosen: false });
    expect(decisionReports()).toEqual([
      [
        "[keiko] chat window kept the conversation the person chose",
        {
          correlationId: "ui_list-choice-0002",
          bindingReport: {
            surface: "chat-window",
            outcome: "choice-kept",
            referenceShape: "user-selected",
            heuristicFlagged: true,
            windowRef: "window-legacy",
            targetFingerprint: chatReferenceFingerprint(FLAGGED_ID),
          },
        },
      ],
    ]);
  });

  it("withdraws the chosen chat and returns the window to the chats it may have shown", () => {
    const updateCfg = vi.fn();
    const afterReload = { shape: "fingerprint", correlationId: "ui_list-rebind-0003" } as const;
    const view = renderHook(() =>
      useChatChoiceDecision(chosen, afterReload, { updateCfg, windowId: "window-legacy" }),
    );

    act(() => {
      view.result.current?.chooseAnother();
    });

    expect(updateCfg).toHaveBeenCalledWith({
      chatId: "[REDACTED]",
      chatIdFingerprint: undefined,
      chatIdChosen: false,
    });
    expect(decisionReports()).toEqual([
      [
        "[keiko] chat window withdrew the conversation the person chose",
        {
          correlationId: "ui_list-rebind-0003",
          bindingReport: expect.objectContaining({
            outcome: "choice-withdrawn",
            referenceShape: "fingerprint",
            targetFingerprint: chatReferenceFingerprint(FLAGGED_ID),
          }) as unknown,
        },
      ],
    ]);
    expect(JSON.stringify(reportClientDiagnosticMock.mock.calls)).not.toContain(FLAGGED_ID);
  });
});
