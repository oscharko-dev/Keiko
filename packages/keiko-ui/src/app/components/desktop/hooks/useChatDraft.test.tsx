import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatDraft, ChatDraftUpdate } from "@oscharko-dev/keiko-contracts/bff-wire";
import { ApiError } from "@/lib/api";
import { readChatDraft, writeChatDraft } from "@/lib/chat-draft-api";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import { ChatDraftController } from "./chat-draft-controller";
import { useChatDraft, useChatDraftUnloadGuard } from "./useChatDraft";

vi.mock("@/lib/chat-draft-api", () => ({ readChatDraft: vi.fn(), writeChatDraft: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(readChatDraft).mockReset().mockResolvedValue({ text: "", revision: 0 });
  vi.mocked(writeChatDraft)
    .mockReset()
    .mockImplementation(async (_id: string, update: ChatDraftUpdate): Promise<ChatDraft> => ({
      text: update.text,
      revision: update.expectedRevision + 1,
    }));
});
afterEach(() => {
  vi.useRealTimers();
});

function controller(): ChatDraftController {
  return new ChatDraftController(vi.fn());
}

describe("private chat drafts", () => {
  it("hydrates a saved draft and never persists the body in browser storage", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    vi.mocked(readChatDraft).mockResolvedValue({ text: "私の Entwurf", revision: 7 });
    const { result } = renderHook(() => useChatDraft("a"));
    await waitFor(() => expect(result.current.text).toBe("私の Entwurf"));
    expect(result.current.persistence.phase).toBe("saved");
    expect(local).not.toHaveBeenCalled();
    local.mockRestore();
  });

  it("keeps each chat draft isolated while switching away and back", async () => {
    const { result, rerender } = renderHook(({ id }) => useChatDraft(id), {
      initialProps: { id: "a" },
    });
    await waitFor(() => expect(result.current.persistence.phase).toBe("saved"));
    act(() => result.current.setText("A pending"));
    rerender({ id: "b" });
    expect(result.current.text).toBe("");
    await waitFor(() => expect(result.current.persistence.phase).toBe("saved"));
    act(() => result.current.setText("B pending"));
    rerender({ id: "a" });
    expect(result.current.text).toBe("A pending");
  });

  it("debounces typing and writes the authoritative expected revision", async () => {
    vi.useFakeTimers();
    const draft = controller();
    vi.mocked(readChatDraft).mockResolvedValue({ text: "old", revision: 8 });
    await draft.refresh("a");
    draft.setText("a", "first");
    await vi.advanceTimersByTimeAsync(200);
    draft.setText("a", "latest");
    await vi.advanceTimersByTimeAsync(299);
    expect(writeChatDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeChatDraft).toHaveBeenCalledExactlyOnceWith("a", {
      text: "latest",
      expectedRevision: 8,
    });
    expect(draft.entry("a").phase).toBe("saved");
    expect(draft.hasUnsaved()).toBe(false);
  });

  it("preserves newer typing while an earlier save is pending", async () => {
    const draft = controller();
    await draft.refresh("a");
    const pending = deferred<ChatDraft>();
    vi.mocked(writeChatDraft).mockReturnValueOnce(pending.promise);
    draft.setText("a", "first");
    const saving = draft.save("a");
    draft.setText("a", "newer");
    pending.resolve({ text: "first", revision: 1 });
    await saving;
    expect(draft.entry("a").text).toBe("newer");
    expect(draft.hasUnsaved()).toBe(true);
    await draft.save("a");
    expect(writeChatDraft).toHaveBeenLastCalledWith("a", { text: "newer", expectedRevision: 1 });
    expect(draft.hasUnsaved()).toBe(false);
  });

  it("keeps typing during initial load without overwriting an existing saved draft", async () => {
    const draft = controller();
    const pending = deferred<ChatDraft>();
    vi.mocked(readChatDraft).mockReturnValueOnce(pending.promise);
    const loading = draft.refresh("a");
    draft.setText("a", "local");
    pending.resolve({ text: "remote", revision: 3 });
    await loading;
    expect(draft.entry("a")).toMatchObject({ text: "local", phase: "conflict" });
    await draft.save("a");
    expect(writeChatDraft).not.toHaveBeenCalled();
  });

  it("saves typing during initial load when the saved draft was empty", async () => {
    const draft = controller();
    const pending = deferred<ChatDraft>();
    vi.mocked(readChatDraft).mockReturnValueOnce(pending.promise);
    const loading = draft.refresh("a");
    draft.setText("a", "local");
    pending.resolve({ text: "", revision: 2 });
    await loading;
    await draft.save("a");
    expect(writeChatDraft).toHaveBeenCalledWith("a", { text: "local", expectedRevision: 2 });
  });

  it("never replays a conflicting mutation on focus or repeated refresh", async () => {
    const draft = controller();
    await draft.refresh("a");
    draft.setText("a", "local");
    vi.mocked(writeChatDraft).mockRejectedValueOnce(
      new ApiError("INVALID_REQUEST", "Conflict", 409),
    );
    await draft.save("a");
    vi.mocked(readChatDraft).mockResolvedValue({ text: "other tab", revision: 2 });
    await draft.refresh("a");
    await draft.refresh("a");
    await draft.save("a");
    expect(draft.entry("a")).toMatchObject({ text: "local", phase: "conflict" });
    expect(writeChatDraft).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "retains conflict through a failed read and later recovery (edit again: %s)",
    async (editAgain) => {
      const draft = controller();
      await draft.refresh("a");
      draft.setText("a", "local");
      vi.mocked(readChatDraft).mockResolvedValue({ text: "other tab", revision: 2 });
      await draft.refresh("a");
      vi.mocked(readChatDraft).mockRejectedValueOnce(new TypeError("offline"));
      await draft.refresh("a");
      if (editAgain) draft.setText("a", "newer local");
      await draft.refresh("a");
      await draft.save("a");
      expect(writeChatDraft).not.toHaveBeenCalled();
      expect(draft.entry("a")).toMatchObject({
        text: editAgain ? "newer local" : "local",
        phase: "conflict",
      });
      await expect(draft.prepareClose()).resolves.toBe(false);
    },
  );

  it("only explicit keep-local resolution replaces the current remote revision", async () => {
    const draft = controller();
    await draft.refresh("a");
    draft.setText("a", "local");
    vi.mocked(readChatDraft).mockResolvedValue({ text: "other", revision: 9 });
    await draft.refresh("a");
    await draft.keepLocal("a");
    expect(writeChatDraft).toHaveBeenCalledExactlyOnceWith("a", {
      text: "local",
      expectedRevision: 9,
    });
    expect(draft.entry("a").phase).toBe("saved");
  });

  it("explicit use-saved resolution restores the current remote text", async () => {
    const draft = controller();
    await draft.refresh("a");
    draft.setText("a", "local");
    vi.mocked(readChatDraft).mockResolvedValue({ text: "remote", revision: 5 });
    await draft.restoreSaved("a");
    expect(draft.entry("a")).toMatchObject({ text: "remote", phase: "saved" });
    expect(writeChatDraft).not.toHaveBeenCalled();
  });

  it("does not erase new typing during explicit use-saved resolution", async () => {
    const draft = controller();
    await draft.refresh("a");
    draft.setText("a", "local");
    const pending = deferred<ChatDraft>();
    vi.mocked(readChatDraft).mockReturnValueOnce(pending.promise);
    const loading = draft.restoreSaved("a");
    draft.setText("a", "new local");
    pending.resolve({ text: "remote", revision: 5 });
    await loading;
    expect(draft.entry("a")).toMatchObject({ text: "new local", phase: "conflict" });
  });

  it("retains unsaved typing after a denied read and recovers on session redemption", async () => {
    vi.mocked(readChatDraft).mockRejectedValueOnce(new ApiError("NOT_FOUND", "Unavailable", 404));
    const { result } = renderHook(() => useChatDraft("a"));
    await waitFor(() => expect(result.current.persistence.phase).toBe("unavailable"));
    act(() => result.current.setText("retained"));
    act(() => notifyCodingAppSessionChanged());
    await waitFor(() => expect(readChatDraft).toHaveBeenCalledTimes(2));
    expect(result.current.text).toBe("retained");
    await act(() => result.current.controller.save("a"));
    expect(result.current.persistence.phase).toBe("saved");
  });

  it("queues session refresh behind a pending read", async () => {
    const pending = deferred<ChatDraft>();
    vi.mocked(readChatDraft).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useChatDraft("a"));
    act(() => notifyCodingAppSessionChanged());
    pending.resolve({ text: "stale", revision: 1 });
    vi.mocked(readChatDraft).mockResolvedValue({ text: "current", revision: 2 });
    await waitFor(() => expect(result.current.text).toBe("current"));
    expect(readChatDraft).toHaveBeenCalledTimes(2);
  });

  it("persists clearing a typed draft after admission", async () => {
    const draft = controller();
    vi.mocked(readChatDraft).mockResolvedValue({ text: "sent text", revision: 4 });
    await draft.refresh("a");
    draft.setText("a", "");
    await draft.save("a");
    expect(writeChatDraft).toHaveBeenCalledWith("a", { text: "", expectedRevision: 4 });
  });

  it("warns before unload until a dirty draft is acknowledged", async () => {
    const draft = controller();
    await draft.refresh("a");
    renderHook(() => useChatDraftUnloadGuard(draft, 0));
    draft.setText("a", "pending");
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(draft.hasUnsaved()).toBe(false));
    const saved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(saved);
    expect(saved.defaultPrevented).toBe(false);
  });

  it("flushes a pending draft when the page hides without beforeunload", async () => {
    vi.useFakeTimers();
    const draft = controller();
    await draft.refresh("a");
    const view = renderHook(() => useChatDraftUnloadGuard(draft, 0));
    draft.setText("a", "Keep the latest edit on reload");
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(writeChatDraft).toHaveBeenCalledOnce();
    expect(writeChatDraft).toHaveBeenCalledWith("a", {
      text: "Keep the latest edit on reload",
      expectedRevision: 0,
    });
    view.unmount();
  });

  it("warns before unload for transient attachments even with a saved draft", async () => {
    const draft = controller();
    await draft.refresh("a");
    renderHook(() => useChatDraftUnloadGuard(draft, 1));
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  it("waits for a confirmed private save before immediate window close", async () => {
    const draft = controller();
    await draft.refresh("a");
    const pending = deferred<ChatDraft>();
    vi.mocked(writeChatDraft).mockReturnValueOnce(pending.promise);
    draft.setText("a", "Immediately closed draft");
    const closing = draft.prepareClose();
    let closed = false;
    void closing.then((allowed) => {
      closed = allowed;
    });
    await waitFor(() => expect(writeChatDraft).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    pending.resolve({ text: "Immediately closed draft", revision: 1 });
    await expect(closing).resolves.toBe(true);
    expect(draft.hasUnsaved()).toBe(false);
  });

  it("keeps the window open when immediate close cannot save its draft", async () => {
    const draft = controller();
    await draft.refresh("a");
    vi.mocked(writeChatDraft).mockRejectedValueOnce(new TypeError("offline"));
    draft.setText("a", "Keep this text");
    await expect(draft.prepareClose()).resolves.toBe(false);
    expect(draft.entry("a")).toMatchObject({ text: "Keep this text", phase: "failed" });
  });

  it("waits for initial load and saves typing before closing", async () => {
    const draft = controller();
    const pending = deferred<ChatDraft>();
    vi.mocked(readChatDraft).mockReturnValueOnce(pending.promise);
    const loading = draft.refresh("a");
    draft.setText("a", "Typed during load");
    const closing = draft.prepareClose();
    pending.resolve({ text: "", revision: 4 });
    await loading;
    await expect(closing).resolves.toBe(true);
    expect(writeChatDraft).toHaveBeenCalledWith("a", {
      text: "Typed during load",
      expectedRevision: 4,
    });
  });

  it("keeps a conflicting draft open instead of implicitly overwriting remote text", async () => {
    const draft = controller();
    await draft.refresh("a");
    draft.setText("a", "Local");
    vi.mocked(readChatDraft).mockResolvedValue({ text: "Remote", revision: 3 });
    await draft.refresh("a");
    await expect(draft.prepareClose()).resolves.toBe(false);
    expect(writeChatDraft).not.toHaveBeenCalled();
  });
  it.each(["a", "new-chat"])(
    "drains edits to %s arriving while another chat saves for close",
    async (editedChat) => {
      const draft = controller();
      await draft.refresh("a");
      await draft.refresh("b");
      const pending = deferred<ChatDraft>();
      vi.mocked(writeChatDraft).mockReturnValueOnce(pending.promise);
      draft.setText("b", "B pending");
      const closing = draft.prepareClose();
      await waitFor(() => expect(writeChatDraft).toHaveBeenCalledOnce());
      draft.setText(editedChat, "Typed during close");
      pending.resolve({ text: "B pending", revision: 1 });
      await expect(closing).resolves.toBe(true);
      expect(draft.hasUnsaved()).toBe(false);
      expect(writeChatDraft).toHaveBeenLastCalledWith(editedChat, {
        text: "Typed during close",
        expectedRevision: 0,
      });
    },
  );
});
