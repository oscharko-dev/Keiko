import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ChatView } from "./ChatView";
import * as api from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/api", () => ({
  fetchChatMessages: vi.fn(),
  createChatMessage: vi.fn(),
  fetchChats: vi.fn(),
  fetchModels: vi.fn(),
  updateChat: vi.fn(),
  startRun: vi.fn(),
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

const availableProject: ProjectWithAvailability = {
  path: "/workspace/foo",
  name: "Foo Project",
  available: true,
  favorite: false,
  createdAt: 1000,
  lastOpenedAt: 2000,
};

const unavailableProject: ProjectWithAvailability = {
  ...availableProject,
  available: false,
};

const baseChat = {
  id: "c1",
  projectPath: "/workspace/foo",
  title: "t",
  selectedModel: "Mistral-Small-3.1-24B-Instruct-2503",
  createdAt: 0,
  updatedAt: 0,
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ChatView now fetches the chat record so ChatComposer can read selectedModel (issue #65).
    // The default keeps fetchChats pending forever so the composer stays in its loading state
    // and individual existing tests stay focused on the message-list surface. Tests that need
    // the composer rendered override `fetchChats` with `mockResolvedValueOnce`.
    vi.mocked(api.fetchChats).mockReturnValue(new Promise(() => { /* never resolves */ }));
    vi.mocked(api.fetchModels).mockResolvedValue({ models: [] });
  });

  it("renders loading state initially", () => {
    vi.mocked(api.fetchChatMessages).mockReturnValue(new Promise(() => { /* never resolves */ }));
    render(<ChatView chatId="c1" project={availableProject} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders error state when fetch fails", async () => {
    vi.mocked(api.fetchChatMessages).mockRejectedValueOnce(new Error("Network error"));
    render(<ChatView chatId="c1" project={availableProject} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("renders empty state when no messages", async () => {
    vi.mocked(api.fetchChatMessages).mockResolvedValueOnce({ messages: [] });
    render(<ChatView chatId="c1" project={availableProject} />);
    await waitFor(() => {
      expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
    });
  });

  it("renders messages when loaded", async () => {
    vi.mocked(api.fetchChatMessages).mockResolvedValueOnce({
      messages: [
        {
          id: "m1",
          chatId: "c1",
          role: "user",
          content: "Hello there",
          timestamp: 1000,
        },
        {
          id: "m2",
          chatId: "c1",
          role: "assistant",
          content: "Hi back",
          timestamp: 2000,
        },
      ],
    });
    render(<ChatView chatId="c1" project={availableProject} />);
    await waitFor(() => {
      expect(screen.getByText("Hello there")).toBeInTheDocument();
      expect(screen.getByText("Hi back")).toBeInTheDocument();
    });
  });

  it("shows project name and path in header", async () => {
    vi.mocked(api.fetchChatMessages).mockResolvedValueOnce({ messages: [] });
    render(<ChatView chatId="c1" project={availableProject} />);
    await waitFor(() => {
      expect(screen.getByText("Foo Project")).toBeInTheDocument();
      expect(screen.getByText("/workspace/foo")).toBeInTheDocument();
    });
  });

  it("shows composer for available project", async () => {
    vi.mocked(api.fetchChatMessages).mockResolvedValueOnce({ messages: [] });
    vi.mocked(api.fetchChats).mockResolvedValueOnce({ chats: [baseChat] });
    render(<ChatView chatId="c1" project={availableProject} />);
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /message/i })).toBeInTheDocument();
    });
  });

  it("hides composer for unavailable project (D6)", async () => {
    vi.mocked(api.fetchChatMessages).mockResolvedValueOnce({ messages: [] });
    render(<ChatView chatId="c1" project={unavailableProject} />);
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: /message/i })).toBeNull();
    });
  });

  it("shows unavailable banner for unavailable project (D6)", async () => {
    vi.mocked(api.fetchChatMessages).mockResolvedValueOnce({ messages: [] });
    render(<ChatView chatId="c1" project={unavailableProject} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(/no longer available/i);
    });
  });

  it("sending a message re-fetches messages", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(api.fetchChats).mockResolvedValueOnce({ chats: [baseChat] });
    vi.mocked(api.fetchModels).mockResolvedValueOnce({
      models: [
        {
          id: "Mistral-Small-3.1-24B-Instruct-2503",
          kind: "chat",
          contextWindow: 128_000,
          maxOutputTokens: 8_000,
          toolCalling: true,
          structuredOutput: true,
          streaming: true,
          costClass: "medium",
          latencyClass: "medium",
          throughputHint: "ok",
          preferredUseCases: [],
          knownLimitations: [],
        },
      ],
    });
    vi.mocked(api.createChatMessage).mockResolvedValue({
      message: {
        id: "m1",
        chatId: "c1",
        role: "user",
        content: "Test",
        timestamp: 1000,
      },
    });
    vi.mocked(api.startRun).mockResolvedValueOnce({ runId: "r1", fingerprint: "f" });
    render(<ChatView chatId="c1" project={availableProject} />);
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /model/i })).toBeInTheDocument();
    });
    // The composer now requires a workflow mode to be selected before submit is enabled.
    // Pick Verify (no textarea content required) and submit.
    await user.click(screen.getByRole("radio", { name: /verify/i }));
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => {
      // fetchChatMessages called at least twice: initial load + after send
      expect(api.fetchChatMessages).toHaveBeenCalledTimes(2);
    });
  });

  it("has no axe-detectable accessibility violations (available project)", async () => {
    vi.mocked(api.fetchChatMessages).mockResolvedValueOnce({ messages: [] });
    vi.mocked(api.fetchChats).mockResolvedValueOnce({ chats: [baseChat] });
    const { container } = render(<ChatView chatId="c1" project={availableProject} />);
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: /loading messages/i })).toBeNull();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe-detectable accessibility violations (unavailable project)", async () => {
    vi.mocked(api.fetchChatMessages).mockResolvedValueOnce({ messages: [] });
    const { container } = render(<ChatView chatId="c1" project={unavailableProject} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
