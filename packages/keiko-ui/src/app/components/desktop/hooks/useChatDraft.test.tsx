import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createRef, useEffect, type ReactNode, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatDraft, ChatDraftUpdate } from "@oscharko-dev/keiko-contracts/bff-wire";
import { ApiError } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { readChatDraft, writeChatDraft } from "@/lib/chat-draft-api";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import { ChatDraftController } from "./chat-draft-controller";
import { useChatDraft, useChatDraftUnloadGuard } from "./useChatDraft";
import { MarkdownComposer } from "../composer/MarkdownComposer";
import { ComposerEditorController } from "../composer/composer-editor-controller";
import type { ComposerInputHandle } from "../composer/composer-editor-types";

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
  it("publishes a child edit before the parent passive subscription mounts", async () => {
    const initialRead = deferred<ChatDraft>();
    vi.mocked(readChatDraft).mockReturnValue(initialRead.promise);
    const observed: { controller?: ChatDraftController } = {};
    function PublishDraft({ publish }: { readonly publish: (text: string) => void }): ReactNode {
      useEffect(() => publish("Immediate child edit"), [publish]);
      return null;
    }
    function DraftOwner(): ReactNode {
      const draft = useChatDraft("a");
      observed.controller = draft.controller;
      return (
        <>
          <output aria-label="Current draft">{draft.text}</output>
          <PublishDraft publish={draft.setText} />
        </>
      );
    }
    const rendered = render(<DraftOwner />);
    try {
      expect(observed.controller?.entry("a").text).toBe("Immediate child edit");
      expect(screen.getByLabelText("Current draft")).toHaveTextContent("Immediate child edit");
      expect(reportClientDiagnostic).toHaveBeenCalledWith(
        "Private chat draft notifications ready.",
        { composerActivity: "draft-notifications-ready" },
      );
    } finally {
      initialRead.resolve({ text: "", revision: 0 });
      await waitFor(() => expect(readChatDraft).toHaveBeenCalled());
      await waitFor(() => expect(observed.controller?.entry("a").pending).toBe(false));
      rendered.unmount();
      observed.controller?.forget("a");
    }
  });

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

interface DraftComposerObservation {
  controller?: ChatDraftController;
}
const admissionLabels = {
  code: "Code",
  plainText: "Plain text",
  language: "Language",
  continueText: "Continue",
  loading: "Loading",
  unavailable: "Unavailable",
  limit: "Limit",
  hint: "Markdown",
};

function DraftComposer({
  admit,
  inputRef,
  observed,
}: {
  readonly admit: boolean;
  readonly inputRef: RefObject<ComposerInputHandle | null>;
  readonly observed: DraftComposerObservation;
}): ReactNode {
  const draft = useChatDraft("admission");
  observed.controller = draft.controller;
  return (
    <>
      <output aria-label="Committed draft">{draft.text}</output>
      <MarkdownComposer
        value={draft.text}
        inputRef={inputRef}
        documentKey="admission"
        placeholder="Ask"
        ariaLabel="Admission message"
        maxLength={10000}
        onChange={draft.setText}
        onSelect={vi.fn()}
        labels={admissionLabels}
        onKeyDown={(): void => {
          if (admit) draft.setText("");
        }}
      />
    </>
  );
}

async function draftComposerFixture(admit: boolean): Promise<{
  readonly editor: ComposerEditorController;
  readonly observed: DraftComposerObservation;
  readonly cleanup: () => Promise<void>;
}> {
  const initialRead = deferred<ChatDraft>();
  vi.mocked(readChatDraft).mockReturnValue(initialRead.promise);
  const inputRef = createRef<ComposerInputHandle>();
  const observed: DraftComposerObservation = {};
  const rendered = render(<DraftComposer admit={admit} inputRef={inputRef} observed={observed} />);
  await waitFor(() => expect(readChatDraft).toHaveBeenCalled());
  const editor = inputRef.current;
  if (!(editor instanceof ComposerEditorController)) throw new TypeError("Missing composer");
  return {
    editor,
    observed,
    cleanup: async (): Promise<void> => {
      vi.clearAllTimers();
      vi.useRealTimers();
      initialRead.resolve({ text: "", revision: 0 });
      await waitFor(() => expect(observed.controller?.entry("admission").pending).toBe(false));
      rendered.unmount();
      observed.controller?.forget("admission");
    },
  };
}

function publishPendingDraft(editor: ComposerEditorController): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  act(() => editor.view.dispatch(editor.view.state.tr.insertText("Immediate admitted draft")));
}

describe("private draft Composer admission", () => {
  it("clears an admitted Enter after an uncommitted deferred publication", async (): Promise<void> => {
    const { editor, observed, cleanup } = await draftComposerFixture(true);
    try {
      publishPendingDraft(editor);
      expect(observed.controller?.entry("admission").text).toBe("");
      act(() => {
        vi.runOnlyPendingTimers();
        expect(observed.controller?.entry("admission").text).toBe("Immediate admitted draft");
        expect(screen.getByLabelText("Committed draft").textContent).toBe("");
        fireEvent.keyDown(editor.view.dom, { key: "Enter" });
      });
      expect(screen.getByLabelText("Committed draft").textContent).toBe("");
      expect(editor.currentMarkdown).toBe("");
      expect(reportClientDiagnostic).toHaveBeenCalledWith(
        "Keiko composer external draft resynchronized.",
        { composerActivity: "draft-resynchronized" },
      );
    } finally {
      await cleanup();
    }
  });

  it.each([false, true])(
    "retains refused Enter and newer native input: %s",
    async (editAgain): Promise<void> => {
      const { editor, observed, cleanup } = await draftComposerFixture(false);
      try {
        publishPendingDraft(editor);
        vi.mocked(reportClientDiagnostic).mockClear();
        act(() => {
          vi.runOnlyPendingTimers();
          expect(observed.controller?.entry("admission").text).toBe("Immediate admitted draft");
          expect(screen.getByLabelText("Committed draft").textContent).toBe("");
          fireEvent.keyDown(editor.view.dom, { key: "Enter" });
          if (editAgain) editor.view.dispatch(editor.view.state.tr.insertText(" newer"));
        });
        expect(screen.getByLabelText("Committed draft").textContent).toBe(
          "Immediate admitted draft",
        );
        expect(editor.currentMarkdown).toBe(
          editAgain ? "Immediate admitted draft newer" : "Immediate admitted draft",
        );
        expect(reportClientDiagnostic).not.toHaveBeenCalledWith(
          "Keiko composer external draft resynchronized.",
          { composerActivity: "draft-resynchronized" },
        );
      } finally {
        await cleanup();
      }
    },
  );

  it("notifies an equal publication without another edit or persistence schedule", (): void => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const draft = new ChatDraftController(changed);
    draft.setText("same", "Repeated publication");
    const entry = draft.entry("same");
    const version = entry.editVersion;
    const timer = entry.timer;
    const phase = entry.phase;
    const timers = vi.getTimerCount();
    changed.mockClear();
    try {
      draft.setText("same", "Repeated publication");
      expect(changed).toHaveBeenCalledOnce();
      expect(entry.editVersion).toBe(version);
      expect(entry.phase).toBe(phase);
      expect(entry.timer).toBe(timer);
      expect(vi.getTimerCount()).toBe(timers);
      expect(writeChatDraft).not.toHaveBeenCalled();
    } finally {
      draft.forget("same");
    }
  });
});
