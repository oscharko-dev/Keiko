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
  // Issue #66 — RunSummaryCard reads these via useRunStatusSync. Keep them as resolving
  // no-ops so the cards never PATCH during ChatView tests.
  fetchRunReport: vi.fn(),
  fetchEvidenceManifest: vi.fn(),
  patchChatMessage: vi.fn(),
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

// next/link → plain <a> for jsdom.
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
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
    // Default for the run-sync mocks: stay running forever so cards render but never PATCH.
    vi.mocked(api.fetchRunReport).mockReturnValue(new Promise(() => { /* never resolves */ }));
    vi.mocked(api.fetchEvidenceManifest).mockReturnValue(
      new Promise(() => { /* never resolves */ }),
    );
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

  // Issue #66 — system messages with runId render the RunSummaryCard surface.
  it("renders RunSummaryCard for a system message with runId (#66)", async () => {
    vi.mocked(api.fetchChatMessages).mockResolvedValueOnce({
      messages: [
        {
          id: "u1",
          chatId: "c1",
          role: "user",
          content: "go",
          timestamp: 1000,
        },
        {
          id: "s1",
          chatId: "c1",
          role: "system",
          content: "Verify started",
          timestamp: 1001,
          runId: "11111111-2222-3333-4444-555555555555",
          taskType: "verify",
          workflowStatus: "running",
        },
      ],
    });
    render(<ChatView chatId="c1" project={availableProject} />);
    await waitFor(() => {
      // Card label
      expect(screen.getByText("Verify")).toBeInTheDocument();
      // Badge for running
      expect(screen.getByText("Running")).toBeInTheDocument();
      // Both nav links present
      expect(screen.getByLabelText("View run details")).toBeInTheDocument();
      expect(screen.getByLabelText("View evidence manifest")).toBeInTheDocument();
    });
  });

  it("renders the plain panel for a system message without runId (#66)", async () => {
    vi.mocked(api.fetchChatMessages).mockResolvedValueOnce({
      messages: [
        {
          id: "s2",
          chatId: "c1",
          role: "system",
          content: "system note",
          timestamp: 1,
        },
      ],
    });
    render(<ChatView chatId="c1" project={availableProject} />);
    await waitFor(() => {
      expect(screen.getByText("system note")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("View run details")).toBeNull();
  });

  it("PATCHed message reflects in DOM without a refetch (#66)", async () => {
    // First fetch returns the running message; the polling hook will receive a 'completed'
    // report; the PATCH mock returns the completed row; the card should re-render from props.
    vi.mocked(api.fetchChatMessages).mockResolvedValueOnce({
      messages: [
        {
          id: "s1",
          chatId: "c1",
          role: "system",
          content: "Verify started",
          timestamp: 1,
          runId: "11111111-2222-3333-4444-555555555555",
          taskType: "verify",
          workflowStatus: "running",
        },
      ],
    });
    vi.mocked(api.fetchRunReport).mockResolvedValue({
      report: {
        status: "completed",
        verificationSummary: { results: [{}, {}, {}] },
      } as never,
    });
    vi.mocked(api.patchChatMessage).mockResolvedValue({
      message: {
        id: "s1",
        chatId: "c1",
        role: "system",
        content: "Verify started",
        timestamp: 1,
        runId: "11111111-2222-3333-4444-555555555555",
        taskType: "verify",
        workflowStatus: "completed",
        shortResult: "Verification passed: 3 classifications.",
      },
    });
    const initialFetchCalls = vi.mocked(api.fetchChatMessages).mock.calls.length;
    render(<ChatView chatId="c1" project={availableProject} />);
    await waitFor(() => {
      expect(screen.getByText("Completed")).toBeInTheDocument();
      expect(screen.getByText("Verification passed: 3 classifications.")).toBeInTheDocument();
    });
    // No second list-fetch — handlePatched mutates local state by id.
    expect(vi.mocked(api.fetchChatMessages).mock.calls.length).toBe(initialFetchCalls + 1);
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
