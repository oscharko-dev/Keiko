import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ChatList } from "./ChatList";
import * as api from "@/lib/api";
import type { Chat } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/api", () => ({
  fetchChats: vi.fn(),
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, msg: string, status: number) {
      super(msg);
      this.name = "ApiError";
      this.code = code;
      this.status = status;
    }
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChat(overrides: Partial<Chat> & { id: string }): Chat {
  return {
    projectPath: "/workspace/foo",
    title: `Chat ${overrides.id}`,
    selectedModel: "model",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

const projectPath = "/workspace/foo";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading state initially", () => {
    vi.mocked(api.fetchChats).mockReturnValue(new Promise(() => { /* never resolves */ }));
    render(
      <ChatList
        projectPath={projectPath}
        selectedChatId={null}
        onSelectChat={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders error state when fetch fails", async () => {
    vi.mocked(api.fetchChats).mockRejectedValueOnce(new Error("Network error"));
    render(
      <ChatList
        projectPath={projectPath}
        selectedChatId={null}
        onSelectChat={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("renders empty state when no chats", async () => {
    vi.mocked(api.fetchChats).mockResolvedValueOnce({ chats: [] });
    render(
      <ChatList
        projectPath={projectPath}
        selectedChatId={null}
        onSelectChat={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/no chats yet/i)).toBeInTheDocument();
    });
  });

  it("renders chat titles when loaded", async () => {
    vi.mocked(api.fetchChats).mockResolvedValueOnce({
      chats: [
        makeChat({ id: "a", title: "First Chat", updatedAt: 200 }),
        makeChat({ id: "b", title: "Second Chat", updatedAt: 100 }),
      ],
    });
    render(
      <ChatList
        projectPath={projectPath}
        selectedChatId={null}
        onSelectChat={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("First Chat")).toBeInTheDocument();
      expect(screen.getByText("Second Chat")).toBeInTheDocument();
    });
  });

  it("sorts chats by updatedAt descending", async () => {
    vi.mocked(api.fetchChats).mockResolvedValueOnce({
      chats: [
        makeChat({ id: "a", title: "Older", updatedAt: 100 }),
        makeChat({ id: "b", title: "Newer", updatedAt: 300 }),
        makeChat({ id: "c", title: "Middle", updatedAt: 200 }),
      ],
    });
    render(
      <ChatList
        projectPath={projectPath}
        selectedChatId={null}
        onSelectChat={vi.fn()}
      />,
    );
    await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      const labels = buttons.map((b) => b.textContent);
      const newerIdx = labels.findIndex((l) => l?.includes("Newer"));
      const middleIdx = labels.findIndex((l) => l?.includes("Middle"));
      const olderIdx = labels.findIndex((l) => l?.includes("Older"));
      expect(newerIdx).toBeLessThan(middleIdx);
      expect(middleIdx).toBeLessThan(olderIdx);
    });
  });

  it("clicking a chat calls onSelectChat with the chat id", async () => {
    const user = userEvent.setup();
    const onSelectChat = vi.fn();
    vi.mocked(api.fetchChats).mockResolvedValueOnce({
      chats: [makeChat({ id: "chat-1", title: "My Chat" })],
    });
    render(
      <ChatList
        projectPath={projectPath}
        selectedChatId={null}
        onSelectChat={onSelectChat}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("My Chat")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "My Chat" }));
    expect(onSelectChat).toHaveBeenCalledWith("chat-1");
  });

  it("selected chat has aria-current=true", async () => {
    vi.mocked(api.fetchChats).mockResolvedValueOnce({
      chats: [makeChat({ id: "chat-1", title: "My Chat" })],
    });
    render(
      <ChatList
        projectPath={projectPath}
        selectedChatId="chat-1"
        onSelectChat={vi.fn()}
      />,
    );
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: "My Chat" });
      expect(btn).toHaveAttribute("aria-current", "true");
    });
  });

  it("re-fetches when refreshKey prop changes", async () => {
    vi.mocked(api.fetchChats).mockResolvedValue({ chats: [] });
    const { rerender } = render(
      <ChatList
        projectPath={projectPath}
        selectedChatId={null}
        onSelectChat={vi.fn()}
        refreshKey={0}
      />,
    );
    await waitFor(() => {
      expect(api.fetchChats).toHaveBeenCalledTimes(1);
    });
    rerender(
      <ChatList
        projectPath={projectPath}
        selectedChatId={null}
        onSelectChat={vi.fn()}
        refreshKey={1}
      />,
    );
    await waitFor(() => {
      expect(api.fetchChats).toHaveBeenCalledTimes(2);
    });
  });

  it("has no axe-detectable accessibility violations", async () => {
    vi.mocked(api.fetchChats).mockResolvedValueOnce({
      chats: [makeChat({ id: "a", title: "Chat A" })],
    });
    const { container } = render(
      <ChatList
        projectPath={projectPath}
        selectedChatId={null}
        onSelectChat={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Chat A")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
