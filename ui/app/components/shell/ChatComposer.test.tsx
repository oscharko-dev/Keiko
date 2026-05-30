import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ChatComposer } from "./ChatComposer";
import * as api from "@/lib/api";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/api", () => ({
  createChatMessage: vi.fn(),
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
// Tests
// ---------------------------------------------------------------------------

describe("ChatComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders textarea with accessible label", () => {
    render(<ChatComposer chatId="chat-1" onMessageSent={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: /message/i })).toBeInTheDocument();
  });

  it("send button is disabled when textarea is empty", () => {
    render(<ChatComposer chatId="chat-1" onMessageSent={vi.fn()} />);
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("send button becomes enabled when text is entered", async () => {
    const user = userEvent.setup();
    render(<ChatComposer chatId="chat-1" onMessageSent={vi.fn()} />);
    await user.type(screen.getByRole("textbox"), "Hello");
    expect(screen.getByRole("button", { name: /send message/i })).not.toBeDisabled();
  });

  it("send button remains disabled for whitespace-only input", async () => {
    const user = userEvent.setup();
    render(<ChatComposer chatId="chat-1" onMessageSent={vi.fn()} />);
    await user.type(screen.getByRole("textbox"), "   ");
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("clicking Send calls createChatMessage with role=user and correct chatId", async () => {
    const user = userEvent.setup();
    const onMessageSent = vi.fn();
    vi.mocked(api.createChatMessage).mockResolvedValueOnce({
      message: {
        id: "msg-1",
        chatId: "chat-1",
        role: "user",
        content: "Hello world",
        timestamp: 1000,
      },
    });
    render(<ChatComposer chatId="chat-1" onMessageSent={onMessageSent} />);
    await user.type(screen.getByRole("textbox"), "Hello world");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => {
      expect(api.createChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: "chat-1",
          role: "user",
          content: "Hello world",
        }),
      );
    });
    expect(onMessageSent).toHaveBeenCalledOnce();
  });

  it("clears textarea after successful send", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createChatMessage).mockResolvedValueOnce({
      message: {
        id: "msg-1",
        chatId: "chat-1",
        role: "user",
        content: "Hello",
        timestamp: 1000,
      },
    });
    render(<ChatComposer chatId="chat-1" onMessageSent={vi.fn()} />);
    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toHaveValue("");
    });
  });

  it("Enter key sends message (without Shift)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createChatMessage).mockResolvedValueOnce({
      message: {
        id: "msg-1",
        chatId: "chat-1",
        role: "user",
        content: "Enter send",
        timestamp: 1000,
      },
    });
    render(<ChatComposer chatId="chat-1" onMessageSent={vi.fn()} />);
    await user.type(screen.getByRole("textbox"), "Enter send");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(api.createChatMessage).toHaveBeenCalledOnce();
    });
  });

  it("Shift+Enter does not send", async () => {
    const user = userEvent.setup();
    render(<ChatComposer chatId="chat-1" onMessageSent={vi.fn()} />);
    await user.type(screen.getByRole("textbox"), "Line one");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(api.createChatMessage).not.toHaveBeenCalled();
  });

  it("shows error message when createChatMessage fails", async () => {
    const user = userEvent.setup();
    const ApiErrorClass = (await import("@/lib/api")).ApiError;
    vi.mocked(api.createChatMessage).mockRejectedValueOnce(
      new ApiErrorClass("INTERNAL", "Server error", 500),
    );
    render(<ChatComposer chatId="chat-1" onMessageSent={vi.fn()} />);
    await user.type(screen.getByRole("textbox"), "Test");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Server error");
    });
  });

  it("never calls /api/runs or passes workflowId (D2: no workflow execution)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createChatMessage).mockResolvedValueOnce({
      message: {
        id: "m1",
        chatId: "c1",
        role: "user",
        content: "hi",
        timestamp: 1000,
      },
    });
    render(<ChatComposer chatId="c1" onMessageSent={vi.fn()} />);
    await user.type(screen.getByRole("textbox"), "hi");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => {
      expect(api.createChatMessage).toHaveBeenCalled();
    });
    // workflowId must not be set
    expect(api.createChatMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ workflowId: expect.anything() }),
    );
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<ChatComposer chatId="chat-1" onMessageSent={vi.fn()} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
