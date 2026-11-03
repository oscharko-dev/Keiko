import { beforeEach, describe, expect, it, vi } from "vitest";
import { readChatDraft, writeChatDraft } from "./chat-draft-api";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { bffFetchJson } from "./http";

vi.mock("./coding-app-session-client", () => ({ codingAppSessionPairingSettled: vi.fn() }));
vi.mock("./http", () => ({ bffFetchJson: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe("private draft transport", () => {
  it("waits for pairing and preserves the exact revision and text on a keepalive save", async () => {
    let finish: ((paired: boolean) => void) | undefined;
    vi.mocked(codingAppSessionPairingSettled).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const update = { text: "Grüße 日本語", expectedRevision: 4 };
    const request = writeChatDraft("chat/id", update);
    expect(bffFetchJson).not.toHaveBeenCalled();
    finish?.(true);
    await request;
    expect(bffFetchJson).toHaveBeenCalledExactlyOnceWith(
      "/api/chats/chat%2Fid/draft",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(update), keepalive: true }),
    );
  });

  it("keeps large multibyte drafts on normal transport without truncating or replaying", async () => {
    const update = { text: "日".repeat(22_000), expectedRevision: 1 };
    vi.mocked(bffFetchJson).mockRejectedValue(new TypeError("unavailable"));
    await expect(writeChatDraft("a", update)).rejects.toThrow("unavailable");
    expect(bffFetchJson).toHaveBeenCalledExactlyOnceWith(
      "/api/chats/a/draft",
      expect.objectContaining({ body: JSON.stringify(update), keepalive: false }),
    );
  });

  it("reads the authenticated draft without caching", async () => {
    vi.mocked(bffFetchJson).mockResolvedValue({ text: "saved", revision: 5 });
    await expect(readChatDraft("a")).resolves.toEqual({ text: "saved", revision: 5 });
    expect(bffFetchJson).toHaveBeenCalledWith(
      "/api/chats/a/draft",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });
});
