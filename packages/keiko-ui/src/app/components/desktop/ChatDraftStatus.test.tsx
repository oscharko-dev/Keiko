import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { readChatDraft, writeChatDraft } from "@/lib/chat-draft-api";
import { ChatDraftStatus } from "./ChatDraftStatus";
import { useChatDraft, type ChatDraftPersistence } from "./hooks/useChatDraft";

vi.mock("@/lib/chat-draft-api", () => ({ readChatDraft: vi.fn(), writeChatDraft: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

beforeEach(() => {
  vi.mocked(readChatDraft).mockReset().mockResolvedValue({ text: "", revision: 0 });
  vi.mocked(writeChatDraft).mockReset().mockRejectedValue(new TypeError("offline"));
});

function persistence(overrides: Partial<ChatDraftPersistence> = {}): ChatDraftPersistence {
  return {
    phase: "saved",
    pending: false,
    hasUnsavedChanges: false,
    retry: vi.fn(),
    prepareClose: vi.fn(),
    isCloseReady: vi.fn(),
    keepLocal: vi.fn(),
    restoreSaved: vi.fn(),
    ...overrides,
  };
}

function DraftHarness(): React.JSX.Element {
  const state = useChatDraft("chat");
  return (
    <>
      <textarea
        aria-label="Message"
        value={state.text}
        onChange={(event) => state.setText(event.target.value)}
      />
      <ChatDraftStatus persistence={state.persistence} />
      <button type="button" onClick={() => void state.controller.save("chat")}>
        Flush
      </button>
    </>
  );
}

describe("quiet private draft persistence", () => {
  it.each(["loading", "saved", "unsaved", "saving"] as const)(
    "does not announce routine autosave phase %s, including retained text",
    (phase) => {
      const { container } = render(
        <ChatDraftStatus persistence={persistence({ phase, hasUnsavedChanges: true })} />,
      );
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it.each([401, 403, 404])(
    "does not claim an empty unconnected draft was lost (%s)",
    async (status) => {
      vi.mocked(readChatDraft).mockRejectedValue(new ApiError("NOT_FOUND", "Unavailable", status));
      render(<DraftHarness />);
      await waitFor(() => expect(readChatDraft).toHaveBeenCalledOnce());
      await act(async () => {});
      expect(screen.getByRole("textbox")).toHaveValue("");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry draft save" })).toBeNull();
      expect(writeChatDraft).not.toHaveBeenCalled();
    },
  );

  it("reports an ordinary hydration failure as a read failure and retries the read", async () => {
    vi.mocked(readChatDraft).mockRejectedValueOnce(new TypeError("offline"));
    render(<DraftHarness />);
    expect(await screen.findByRole("alert")).toHaveTextContent("saved draft could not be loaded");
    expect(screen.queryByText(/could not be saved/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry loading draft" }));
    await waitFor(() => expect(readChatDraft).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(writeChatDraft).not.toHaveBeenCalled();
  });

  it("keeps a failed edited draft visible with one persistent retry and no second connect flow", async () => {
    const user = userEvent.setup();
    render(<DraftHarness />);
    await waitFor(() => expect(readChatDraft).toHaveBeenCalledOnce());
    await user.type(screen.getByRole("textbox"), "Keep this private prompt");
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Flush" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("could not be saved");
    expect(screen.getByRole("textbox")).toHaveValue("Keep this private prompt");
    expect(screen.getAllByRole("button", { name: "Retry draft save" })).toHaveLength(1);
    expect(screen.queryByText(/connect this browser|launcher/i)).toBeNull();
    expect(writeChatDraft).toHaveBeenCalledOnce();
    await user.type(screen.getByRole("textbox"), " with more detail");
    expect(screen.getByRole("alert")).toBe(alert);
    expect(screen.getAllByRole("button", { name: "Retry draft save" })).toHaveLength(1);
    expect(writeChatDraft).toHaveBeenCalledOnce();
  });

  it("retains the unsaved warning after an unavailable read followed by typing", async () => {
    vi.mocked(readChatDraft).mockRejectedValue(new ApiError("NOT_FOUND", "Unavailable", 404));
    const user = userEvent.setup();
    render(<DraftHarness />);
    await waitFor(() => expect(readChatDraft).toHaveBeenCalledOnce());
    await act(async () => {});
    await user.type(screen.getByRole("textbox"), "Local prompt");
    expect(screen.getByRole("alert")).toHaveTextContent("has not been saved");
    expect(screen.getByRole("textbox")).toHaveValue("Local prompt");
    expect(screen.queryByText(/connect this browser|launcher/i)).toBeNull();
    expect(writeChatDraft).not.toHaveBeenCalled();
  });

  it("still warns when clearing an existing draft could not be saved", async () => {
    vi.mocked(readChatDraft).mockResolvedValue({ text: "Old saved prompt", revision: 4 });
    const user = userEvent.setup();
    render(<DraftHarness />);
    const textbox = screen.getByRole("textbox");
    await waitFor(() => expect(textbox).toHaveValue("Old saved prompt"));
    await user.clear(textbox);
    await user.click(screen.getByRole("button", { name: "Flush" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(textbox).toHaveValue("");
    expect(writeChatDraft).toHaveBeenCalledExactlyOnceWith("chat", {
      text: "",
      expectedRevision: 4,
    });
    expect(screen.getByRole("button", { name: "Retry draft save" })).toBeVisible();
  });

  it("keeps a failed save visible until recovery even after reverting the local edit", async () => {
    const user = userEvent.setup();
    render(<DraftHarness />);
    await waitFor(() => expect(readChatDraft).toHaveBeenCalledOnce());
    await user.type(screen.getByRole("textbox"), "Changed prompt");
    await user.click(screen.getByRole("button", { name: "Flush" }));
    const alert = await screen.findByRole("alert");
    await user.clear(screen.getByRole("textbox"));
    expect(screen.getByRole("alert")).toBe(alert);
    expect(screen.getByRole("button", { name: "Retry draft save" })).toBeVisible();
  });
});
