import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchFilesPreview,
  fetchFilesTree,
  fetchProjects,
  updateChatConnectedScope,
} from "../../../../../lib/api";
import type { Chat } from "../../../../../lib/types";
import { ChatSessionProvider } from "../../context/ChatSessionContext";
import type { ChatSessionApi } from "../../hooks/useChatSession";
import { FilePreview } from "./FilePreview";
import { FilesWidget } from "./FilesWidget";

vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchFilesPreview: vi.fn(),
    fetchProjects: vi.fn(),
    fetchFilesTree: vi.fn(),
    updateChatConnectedScope: vi.fn(),
  };
});

const treeEntryBase = {
  sizeBytes: 0,
  modifiedAt: 1,
  extension: null,
  symlink: false,
  readable: true,
};

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/repo",
    title: "t",
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSessionApi> = {}): ChatSessionApi {
  return {
    projects: [],
    chats: [],
    messages: [],
    models: [],
    activeProject: undefined,
    activeChat: makeChat(),
    selectedModel: "example-chat-model",
    noEligibleModels: false,
    draft: "",
    loading: false,
    sending: false,
    sendStatus: "idle",
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn(),
    openProject: vi.fn(),
    openChat: vi.fn(),
    addProject: vi.fn(),
    sendMessage: vi.fn(),
    cancelSend: vi.fn(),
    replaceChat: vi.fn(),
    latestGrounded: undefined,
    cancelGrounded: vi.fn(),
    // Issue #147 — attachment fields
    pendingAttachments: [],
    addPendingAttachment: vi.fn().mockResolvedValue({ ok: true }),
    removePendingAttachment: vi.fn(),
    clearPendingAttachments: vi.fn(),
    budget: undefined,
    clearHistory: vi.fn(),
    launchWorkflowFromConversation: vi.fn().mockResolvedValue({ ok: true, runId: "test-run" }),
    ...overrides,
  };
}

function renderWithSession(ui: ReactElement, session = makeSession()): ChatSessionApi {
  render(<ChatSessionProvider value={session}>{ui}</ChatSessionProvider>);
  return session;
}

describe("FilesWidget", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the root tree and opens a text preview on file click", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo space",
      path: "",
      truncated: false,
      entries: [
        { ...treeEntryBase, name: "src", path: "src", kind: "directory" },
        {
          ...treeEntryBase,
          name: "package.json",
          path: "package.json",
          kind: "file",
          sizeBytes: 18,
          extension: "json",
        },
      ],
    });
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo space",
      path: "package.json",
      name: "package.json",
      sizeBytes: 18,
      modifiedAt: 1,
      extension: "json",
      mime: "application/json",
      symlink: false,
      kind: "text",
      content: '{"name":"keiko"}\n',
      truncated: false,
      maxBytes: 1_000_000,
    });

    const onActiveFileChange = vi.fn();
    render(<FilesWidget root="/repo space" onActiveFileChange={onActiveFileChange} />);

    expect(await screen.findByText("package.json")).toBeInTheDocument();
    expect(fetchFilesTree).toHaveBeenCalledWith("/repo space", "");
    expect(onActiveFileChange).toHaveBeenCalledWith(null, "/repo space");

    await userEvent.click(screen.getByRole("button", { name: /package\.json/i }));

    await waitFor(() =>
      expect(fetchFilesPreview).toHaveBeenCalledWith("/repo space", "package.json"),
    );
    expect(onActiveFileChange).toHaveBeenCalledWith("package.json", "/repo space");
    expect(await screen.findByText('"keiko"')).toBeInTheDocument();
  });

  it("connects the repository root scope from the Files window", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [],
    });
    const updated = makeChat({
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 100 },
    });
    vi.mocked(updateChatConnectedScope).mockResolvedValueOnce({ chat: updated });
    const session = renderWithSession(<FilesWidget root="/repo" />);

    await screen.findByText("Empty folder.");
    await userEvent.click(screen.getByRole("button", { name: "Connect repository" }));

    await waitFor(() => {
      expect(updateChatConnectedScope).toHaveBeenCalledWith("chat-1", {
        kind: "workspace-root",
        relativePaths: [],
        connectedAtMs: expect.any(Number),
      });
    });
    expect(session.replaceChat).toHaveBeenCalledWith(updated);
  });

  it("connects a readable folder scope from a directory row", async () => {
    vi.mocked(fetchFilesTree).mockResolvedValueOnce({
      root: "/repo",
      path: "",
      truncated: false,
      entries: [{ ...treeEntryBase, name: "src", path: "src", kind: "directory" }],
    });
    const updated = makeChat({
      connectedScope: { kind: "directory", relativePaths: ["src"], connectedAtMs: 101 },
    });
    vi.mocked(updateChatConnectedScope).mockResolvedValueOnce({ chat: updated });
    const session = renderWithSession(<FilesWidget root="/repo" />);

    await screen.findByRole("button", { name: /src/i });
    await userEvent.click(screen.getByRole("button", { name: "Connect folder" }));

    await waitFor(() => {
      expect(updateChatConnectedScope).toHaveBeenCalledWith("chat-1", {
        kind: "directory",
        relativePaths: ["src"],
        connectedAtMs: expect.any(Number),
      });
    });
    expect(session.replaceChat).toHaveBeenCalledWith(updated);
  });

  it("shows the empty-workspace state without a repository connector", async () => {
    vi.mocked(fetchProjects).mockResolvedValueOnce({ projects: [] });

    renderWithSession(<FilesWidget />);

    expect(await screen.findByText("No registered project is available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect repository" })).toBeNull();
  });

  it("renders tree loading errors", async () => {
    vi.mocked(fetchFilesTree).mockRejectedValueOnce(new Error("access denied"));

    render(<FilesWidget root="/repo" />);

    expect(await screen.findByText("access denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("FilePreview", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders binary preview metadata instead of code", async () => {
    vi.mocked(fetchFilesPreview).mockResolvedValueOnce({
      root: "/repo",
      path: "archive.bin",
      name: "archive.bin",
      sizeBytes: 6,
      modifiedAt: 1,
      extension: "bin",
      mime: "text/plain",
      symlink: false,
      kind: "binary",
      reason: "unsupported",
    });

    render(<FilePreview root="/repo" path="archive.bin" onClose={() => undefined} />);

    expect(
      await screen.findByText("No safe text or image preview is available for this file type."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("archive.bin").length).toBeGreaterThan(0);
  });

  it("renders a generic safety alert when the BFF returns 403 DENIED", async () => {
    // The BFF message must NOT be rendered verbatim — it is replaced by a
    // generic, non-probing safety message. The matched server-side pattern is
    // never disclosed; the message lists common deny categories as examples
    // only.
    const bffMessage = "secret bff diagnostic that should never reach the user";
    vi.mocked(fetchFilesPreview).mockRejectedValueOnce(new ApiError("DENIED", bffMessage, 403));

    const { container } = render(
      <FilePreview root="/repo" path="some/secret.pem" onClose={() => undefined} />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/excluded from the read surface for safety/i);
    expect(alert.textContent ?? "").not.toContain(bffMessage);
    expect(alert.textContent ?? "").not.toContain("some/secret.pem");
    // The requested path must not be visible anywhere in the rendered tree
    // (the header still renders, but with a generic "Hidden file" label so the
    // path is not leaked via the document or any title attribute).
    expect(container.textContent ?? "").not.toContain("some/secret.pem");
    expect(container.innerHTML).not.toContain("some/secret.pem");
  });

  it("does not render the requested path while a denied preview is still loading", async () => {
    let rejectPreview: ((error: unknown) => void) | undefined;
    vi.mocked(fetchFilesPreview).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPreview = reject;
      }),
    );

    const { container } = render(
      <FilePreview root="/repo" path="some/secret.pem" onClose={() => undefined} />,
    );

    expect(container.textContent ?? "").not.toContain("some/secret.pem");
    expect(container.innerHTML).not.toContain("some/secret.pem");

    rejectPreview?.(new ApiError("DENIED", "hidden", 403));
    await screen.findByRole("alert");
  });

  it("renders the raw error message for non-denied errors", async () => {
    vi.mocked(fetchFilesPreview).mockRejectedValueOnce(new Error("boom"));

    render(<FilePreview root="/repo" path="hello.txt" onClose={() => undefined} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("boom");
    expect(alert.textContent ?? "").not.toMatch(/excluded from the read surface for safety/i);
  });
});
