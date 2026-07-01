// Issue #198 — unit tests for CapsuleActions component.
// Covers: confirmation modal opens, typed-name gate for delete, focus trap,
// all three actions call the correct injectable impl, and jest-axe on every state.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapsuleActions } from "./capsule-actions";
import type { CapsuleActionsProps } from "./capsule-actions";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type {
  CapsuleActionResponse,
  CapsuleDetail,
  CapsuleDetailResponse,
} from "@/lib/local-knowledge-api";

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
  fetchProjects: vi.fn(),
  fetchFilesTree: vi.fn(),
}));

import { fetchFilesTree, fetchProjects } from "@/lib/api";

const mockFetchProjects = vi.mocked(fetchProjects);
const mockFetchFilesTree = vi.mocked(fetchFilesTree);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCapsuleId(s: string): KnowledgeCapsuleId {
  return `cap-${s}` as KnowledgeCapsuleId;
}

function okAction(capsuleId: KnowledgeCapsuleId): Promise<CapsuleActionResponse> {
  return Promise.resolve({ ok: true, capsuleId });
}

const DEFAULT_ID = makeCapsuleId("42");
const DEFAULT_NAME = "My Knowledge Base";

function progressDetail(overrides: Partial<CapsuleDetail> = {}): CapsuleDetail {
  return {
    capsule: {
      id: DEFAULT_ID,
      displayName: DEFAULT_NAME,
      tags: [],
      sourceIds: ["src-1"],
      retrievalEffort: "default",
      outputMode: "snippets",
      answerGroundingPolicy: "require-citations",
      embeddingModelIdentity: {
        provider: "openai-compatible:test",
        modelId: "text-embedding-3-large",
        vectorDimensions: 3072,
        vectorMetric: "cosine",
      },
      lifecycleState: "indexing",
      storageReference: "capsules/cap-42",
      createdAt: 1,
      updatedAt: 2,
    },
    health: {
      capsuleId: DEFAULT_ID,
      sourceIds: ["src-1"],
      lifecycleState: "indexing",
      storageSizeBytes: 100,
      documentCount: 3,
      chunkCount: 10,
      vectorCount: 4,
      embeddingIdentity: {
        provider: "openai-compatible:test",
        modelId: "text-embedding-3-large",
        vectorDimensions: 3072,
        vectorMetric: "cosine",
      },
      vectorCompatible: true,
      failedDocuments: 0,
      skippedDocuments: 0,
      unsupportedDocuments: 0,
      unsupportedGuidance: [],
      staleReasons: [],
    },
    sources: [],
    parserDiagnostics: [],
    indexingJobs: [
      {
        id: "job-1",
        capsuleId: DEFAULT_ID,
        sourceIds: ["src-1"],
        startedAt: Date.now() - 10_000,
        status: "running",
        totalDocuments: 3,
        processedDocuments: 1,
        failedDocuments: 0,
        skippedDocuments: 0,
      },
    ],
    ...overrides,
  } as CapsuleDetail;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchProjects.mockResolvedValue({ projects: [] });
  mockFetchFilesTree.mockImplementation((root: string, path = "") =>
    Promise.resolve({
      root,
      path,
      entries: [],
      truncated: false,
    }),
  );
});

function defaultProps(overrides: Partial<CapsuleActionsProps> = {}): CapsuleActionsProps {
  return {
    capsuleId: DEFAULT_ID,
    capsuleDisplayName: DEFAULT_NAME,
    sourceCount: 1,
    lifecycleState: "ready",
    onActionComplete: vi.fn(),
    connectCapsuleSourceImpl: vi.fn().mockResolvedValue({} as CapsuleDetailResponse),
    deleteCapsuleImpl: vi.fn().mockImplementation(() => okAction(DEFAULT_ID)),
    refreshCapsuleImpl: vi.fn().mockImplementation(() => okAction(DEFAULT_ID)),
    repairCapsuleImpl: vi.fn().mockImplementation(() => okAction(DEFAULT_ID)),
    reembedCapsuleImpl: vi.fn().mockImplementation(() => okAction(DEFAULT_ID)),
    startIndexingImpl: vi.fn().mockImplementation(() => okAction(DEFAULT_ID)),
    fetchCapsuleDetailImpl: vi.fn().mockResolvedValue(progressDetail()),
    ...overrides,
  };
}

async function chooseConnectSource(
  user: ReturnType<typeof userEvent.setup>,
  sourceLabel: "Folder" | "Repository" | "Files",
): Promise<void> {
  await user.click(screen.getByRole("combobox", { name: /connect source/i }));
  const options = await screen.findAllByRole("option");
  const option = options.find((entry) => entry.textContent?.includes(sourceLabel));
  if (option === undefined) throw new Error(`Missing source option ${sourceLabel}`);
  await user.click(option);
}

// ---------------------------------------------------------------------------
// Connect source
// ---------------------------------------------------------------------------

describe("CapsuleActions — connect source", () => {
  it("connects a folder scope by default", async () => {
    const user = userEvent.setup();
    const connectCapsuleSourceImpl = vi.fn().mockResolvedValue({} as CapsuleDetailResponse);
    const onActionComplete = vi.fn();
    render(<CapsuleActions {...defaultProps({ connectCapsuleSourceImpl, onActionComplete })} />);

    await user.type(screen.getByLabelText(/absolute folder path to connect/i), "/docs/manuals");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(connectCapsuleSourceImpl).toHaveBeenCalledWith(DEFAULT_ID, {
        kind: "folder",
        rootPath: "/docs/manuals",
        recursive: true,
      });
    });
    expect(onActionComplete).toHaveBeenCalledOnce();
  });

  it("connects a repository scope", async () => {
    const user = userEvent.setup();
    const connectCapsuleSourceImpl = vi.fn().mockResolvedValue({} as CapsuleDetailResponse);
    render(<CapsuleActions {...defaultProps({ connectCapsuleSourceImpl })} />);

    await chooseConnectSource(user, "Repository");
    await user.type(screen.getByLabelText(/absolute repository path to connect/i), "/repo/app");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(connectCapsuleSourceImpl).toHaveBeenCalledWith(DEFAULT_ID, {
        kind: "repository",
        repositoryRoot: "/repo/app",
      });
    });
  });

  it("requires files input for files scopes and deduplicates file entries", async () => {
    const user = userEvent.setup();
    const connectCapsuleSourceImpl = vi.fn().mockResolvedValue({} as CapsuleDetailResponse);
    render(<CapsuleActions {...defaultProps({ connectCapsuleSourceImpl })} />);

    await chooseConnectSource(user, "Files");
    const connectButton = screen.getByRole("button", { name: /^connect$/i });
    expect(connectButton).toBeDisabled();

    await user.type(screen.getByLabelText(/absolute root path for the selected files/i), "/repo");
    expect(connectButton).toBeDisabled();

    await user.type(
      screen.getByLabelText(/relative files to connect/i),
      "src/app.ts{enter}README.md{enter}src/app.ts",
    );
    expect(connectButton).not.toBeDisabled();

    await user.click(connectButton);

    await waitFor(() => {
      expect(connectCapsuleSourceImpl).toHaveBeenCalledWith(DEFAULT_ID, {
        kind: "files",
        rootPath: "/repo",
        files: ["src/app.ts", "README.md"],
      });
    });
  });

  it("lets the user browse and select a folder instead of typing the path manually", async () => {
    const user = userEvent.setup();
    const connectCapsuleSourceImpl = vi.fn().mockResolvedValue({} as CapsuleDetailResponse);
    mockFetchProjects.mockResolvedValue({
      projects: [
        {
          path: "/repo",
          name: "Repo",
          available: true,
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 1,
        },
      ],
    });
    mockFetchFilesTree.mockImplementation((root: string, path = "") =>
      Promise.resolve({
        root,
        path,
        entries:
          path.length === 0
            ? [
                {
                  name: "docs",
                  path: "docs",
                  kind: "directory",
                  sizeBytes: 0,
                  modifiedAt: 1,
                  extension: "",
                  readable: true,
                  symlink: false,
                },
              ]
            : [],
        truncated: false,
      }),
    );

    render(<CapsuleActions {...defaultProps({ connectCapsuleSourceImpl })} />);

    await user.click(screen.getByRole("button", { name: /^browse$/i }));
    const dialog = await screen.findByRole("dialog", { name: /choose local source/i });
    await user.click(within(dialog).getByRole("button", { name: "Repo" }));
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: /docs/i })).toBeInTheDocument();
    });
    await user.click(within(dialog).getByRole("button", { name: /docs/i }));
    await user.click(within(dialog).getByRole("button", { name: /use selection/i }));

    expect(screen.getByLabelText(/absolute folder path to connect/i)).toHaveValue("/repo/docs");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(connectCapsuleSourceImpl).toHaveBeenCalledWith(DEFAULT_ID, {
        kind: "folder",
        rootPath: "/repo/docs",
        recursive: true,
      });
    });
  });

  it("lets the user browse and select files while preserving the root-relative file list", async () => {
    const user = userEvent.setup();
    const connectCapsuleSourceImpl = vi.fn().mockResolvedValue({} as CapsuleDetailResponse);
    mockFetchProjects.mockResolvedValue({
      projects: [
        {
          path: "/repo",
          name: "Repo",
          available: true,
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 1,
        },
      ],
    });
    mockFetchFilesTree.mockImplementation((root: string, path = "") =>
      Promise.resolve({
        root,
        path,
        entries:
          path.length === 0
            ? [
                {
                  name: "README.md",
                  path: "README.md",
                  kind: "file",
                  sizeBytes: 12,
                  modifiedAt: 1,
                  extension: ".md",
                  readable: true,
                  symlink: false,
                },
              ]
            : [],
        truncated: false,
      }),
    );

    render(<CapsuleActions {...defaultProps({ connectCapsuleSourceImpl })} />);

    await chooseConnectSource(user, "Files");
    await user.click(screen.getByRole("button", { name: /^browse$/i }));
    const dialog = await screen.findByRole("dialog", { name: /choose local source/i });
    await user.click(within(dialog).getByRole("button", { name: "Repo" }));
    await waitFor(() => {
      expect(within(dialog).getByLabelText(/README.md/i)).toBeInTheDocument();
    });
    await user.click(within(dialog).getByLabelText(/README.md/i));
    await user.click(within(dialog).getByRole("button", { name: /use selection/i }));

    expect(screen.getByLabelText(/absolute root path for the selected files/i)).toHaveValue(
      "/repo",
    );
    expect(screen.getByLabelText(/relative files to connect/i)).toHaveValue("README.md");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(connectCapsuleSourceImpl).toHaveBeenCalledWith(DEFAULT_ID, {
        kind: "files",
        rootPath: "/repo",
        files: ["README.md"],
      });
    });
  });

  it("lets the user pick a single file from the folder browser and converts it to a files scope", async () => {
    const user = userEvent.setup();
    const connectCapsuleSourceImpl = vi.fn().mockResolvedValue({} as CapsuleDetailResponse);
    mockFetchProjects.mockResolvedValue({
      projects: [
        {
          path: "/home/user",
          name: "Home",
          available: true,
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 1,
        },
      ],
    });
    mockFetchFilesTree.mockImplementation((root: string, path = "") =>
      Promise.resolve({
        root,
        path,
        entries:
          path.length === 0
            ? [
                {
                  name: "Desktop",
                  path: "Desktop",
                  kind: "directory",
                  sizeBytes: 0,
                  modifiedAt: 1,
                  extension: "",
                  readable: true,
                  symlink: false,
                },
              ]
            : [
                {
                  name: "Inside Agentic AI.pdf",
                  path: "Desktop/Inside Agentic AI.pdf",
                  kind: "file",
                  sizeBytes: 1024,
                  modifiedAt: 1,
                  extension: ".pdf",
                  readable: true,
                  symlink: false,
                },
              ],
        truncated: false,
      }),
    );

    render(<CapsuleActions {...defaultProps({ connectCapsuleSourceImpl })} />);

    expect(screen.getByRole("combobox", { name: /connect source/i })).toHaveTextContent("Folder");
    await user.click(screen.getByRole("button", { name: /^browse$/i }));
    const dialog = await screen.findByRole("dialog", { name: /choose local source/i });
    await user.click(within(dialog).getByRole("button", { name: "Home" }));
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: /Desktop/i })).toBeInTheDocument();
    });
    await user.click(within(dialog).getByRole("button", { name: /Desktop/i }));
    const fileCheckbox = await within(dialog).findByLabelText(/Inside Agentic AI.pdf/i);
    expect(fileCheckbox).toBeEnabled();
    await user.click(fileCheckbox);
    await user.click(within(dialog).getByRole("button", { name: /use selection/i }));

    expect(screen.getByRole("combobox", { name: /connect source/i })).toHaveTextContent("Files");
    expect(screen.getByLabelText(/absolute root path for the selected files/i)).toHaveValue(
      "/home/user",
    );
    expect(screen.getByLabelText(/relative files to connect/i)).toHaveValue(
      "Desktop/Inside Agentic AI.pdf",
    );
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(connectCapsuleSourceImpl).toHaveBeenCalledWith(DEFAULT_ID, {
        kind: "files",
        rootPath: "/home/user",
        files: ["Desktop/Inside Agentic AI.pdf"],
      });
    });
  });

  it("shows local knowledge limits and blocks oversized files in the folder browser", async () => {
    const user = userEvent.setup();
    mockFetchProjects.mockResolvedValue({
      projects: [
        {
          path: "/home/user",
          name: "Home",
          available: true,
          favorite: false,
          createdAt: 1,
          lastOpenedAt: 1,
        },
      ],
    });
    mockFetchFilesTree.mockResolvedValue({
      root: "/home/user",
      path: "",
      entries: [
        {
          name: "too-large.pdf",
          path: "too-large.pdf",
          kind: "file",
          sizeBytes: 1536 * 1024 * 1024,
          modifiedAt: 1,
          extension: ".pdf",
          readable: true,
          symlink: false,
        },
      ],
      truncated: false,
    });

    render(<CapsuleActions {...defaultProps()} />);

    expect(screen.getByText(/Maximum single file size: 1.0 GB/i)).toBeInTheDocument();
    await chooseConnectSource(user, "Files");
    await user.click(screen.getByRole("button", { name: /^browse$/i }));
    const dialog = await screen.findByRole("dialog", { name: /choose local source/i });
    await user.click(within(dialog).getByRole("button", { name: "Home" }));

    const checkbox = await within(dialog).findByLabelText(/too-large.pdf/i);
    expect(within(dialog).getByText(/1.5 GB · too large/i)).toBeInTheDocument();
    expect(checkbox).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /use selection/i })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Modal open / close
// ---------------------------------------------------------------------------

describe("CapsuleActions — modal open and close", () => {
  it("opens the delete modal when Delete is clicked", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /delete capsule/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/delete capsule/i)).toBeInTheDocument();
  });

  it("opens the refresh modal when Refresh changed files is clicked", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /refresh changed files for capsule/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/refresh changed files/i)).toBeInTheDocument();
  });

  it("opens the repair modal when Repair failed files is clicked", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /repair failed files for capsule/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/repair failed files/i)).toBeInTheDocument();
  });

  it("opens the full rebuild modal when Full rebuild / rechunk is clicked", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /full rebuild capsule/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/full rebuild \/ rechunk/i)).toBeInTheDocument();
  });

  it("closes the modal when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /delete capsule/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the modal when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /delete capsule/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delete — typed-name confirmation gate
// ---------------------------------------------------------------------------

describe("CapsuleActions — delete typed-name confirmation", () => {
  it("confirm button is disabled until the capsule name is typed exactly", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /delete capsule/i }));

    const dialog = screen.getByRole("dialog");
    const confirmBtn = within(dialog).getByRole("button", { name: /delete/i });

    // Starts disabled
    expect(confirmBtn).toBeDisabled();

    // Partial match — still disabled
    await user.type(within(dialog).getByRole("textbox"), "My Knowledge");
    expect(confirmBtn).toBeDisabled();

    // Clear and type wrong case — still disabled
    await user.clear(within(dialog).getByRole("textbox"));
    await user.type(within(dialog).getByRole("textbox"), "my knowledge base");
    expect(confirmBtn).toBeDisabled();

    // Exact match — enabled
    await user.clear(within(dialog).getByRole("textbox"));
    await user.type(within(dialog).getByRole("textbox"), DEFAULT_NAME);
    expect(confirmBtn).not.toBeDisabled();
  });

  it("calls deleteCapsuleImpl with the correct ID when confirmed", async () => {
    const user = userEvent.setup();
    const deleteCapsuleImpl = vi.fn().mockImplementation(() => okAction(DEFAULT_ID));
    const onActionComplete = vi.fn();
    render(<CapsuleActions {...defaultProps({ deleteCapsuleImpl, onActionComplete })} />);

    await user.click(screen.getByRole("button", { name: /delete capsule/i }));

    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), DEFAULT_NAME);
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(deleteCapsuleImpl).toHaveBeenCalledWith(DEFAULT_ID);
    });
    expect(onActionComplete).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("routes successful delete through onDeleted instead of reloading the deleted capsule", async () => {
    const user = userEvent.setup();
    const response: CapsuleActionResponse = {
      ok: true,
      capsuleId: DEFAULT_ID,
      cleanupVerified: true,
    };
    const deleteCapsuleImpl = vi.fn().mockResolvedValue(response);
    const onDeleted = vi.fn();
    const onActionComplete = vi.fn();
    render(
      <CapsuleActions {...defaultProps({ deleteCapsuleImpl, onActionComplete, onDeleted })} />,
    );

    await user.click(screen.getByRole("button", { name: /delete capsule/i }));

    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), DEFAULT_NAME);
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledWith(response);
    });
    expect(onActionComplete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows an error banner and keeps the modal open when deleteCapsule rejects", async () => {
    const user = userEvent.setup();
    const deleteCapsuleImpl = vi.fn().mockRejectedValue(new Error("delete failed"));
    render(<CapsuleActions {...defaultProps({ deleteCapsuleImpl })} />);

    await user.click(screen.getByRole("button", { name: /delete capsule/i }));

    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), DEFAULT_NAME);
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toBeInTheDocument();
    });

    expect(within(dialog).getByRole("alert").textContent).toContain("delete failed");
    // Modal stays open
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Refresh action
// ---------------------------------------------------------------------------

describe("CapsuleActions — refresh action", () => {
  it("keeps long-running direct indexing visibly active with live progress", async () => {
    const user = userEvent.setup();
    let finishIndexing: ((value: CapsuleActionResponse) => void) | undefined;
    const startIndexingImpl = vi.fn(
      () =>
        new Promise<CapsuleActionResponse>((resolve) => {
          finishIndexing = resolve;
        }),
    );
    const fetchCapsuleDetailImpl = vi.fn().mockResolvedValue(progressDetail());
    const onActionComplete = vi.fn();

    render(
      <CapsuleActions
        {...defaultProps({
          fetchCapsuleDetailImpl,
          lifecycleState: "draft",
          onActionComplete,
          startIndexingImpl,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /index this capsule now/i }));

    expect(await screen.findByText("Indexing documents")).toBeInTheDocument();
    expect(screen.getByText(/Still working/i)).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(screen.getByText("4 / 10")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchCapsuleDetailImpl).toHaveBeenCalledWith(DEFAULT_ID);
    });

    finishIndexing?.({ ok: true, capsuleId: DEFAULT_ID });
    await waitFor(() => {
      expect(onActionComplete).toHaveBeenCalledOnce();
    });
  });

  it("calls refreshCapsuleImpl when confirmed", async () => {
    const user = userEvent.setup();
    const refreshCapsuleImpl = vi.fn().mockImplementation(() => okAction(DEFAULT_ID));
    const onActionComplete = vi.fn();
    render(<CapsuleActions {...defaultProps({ refreshCapsuleImpl, onActionComplete })} />);

    await user.click(screen.getByRole("button", { name: /refresh changed files for capsule/i }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /refresh/i }));

    await waitFor(() => {
      expect(refreshCapsuleImpl).toHaveBeenCalledWith(DEFAULT_ID);
    });
    expect(onActionComplete).toHaveBeenCalledOnce();
  });

  it("keeps long-running refreshes visibly active with live indexing progress", async () => {
    const user = userEvent.setup();
    let finishRefresh: ((value: CapsuleActionResponse) => void) | undefined;
    const refreshCapsuleImpl = vi.fn(
      () =>
        new Promise<CapsuleActionResponse>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const fetchCapsuleDetailImpl = vi.fn().mockResolvedValue(progressDetail());
    const onActionComplete = vi.fn();

    render(
      <CapsuleActions
        {...defaultProps({ fetchCapsuleDetailImpl, onActionComplete, refreshCapsuleImpl })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /refresh changed files for capsule/i }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^refresh$/i }));

    expect(await within(dialog).findByText("Refreshing changed files")).toBeInTheDocument();
    expect(within(dialog).getByText(/Still working/i)).toBeInTheDocument();
    expect(within(dialog).getByText("running")).toBeInTheDocument();
    expect(within(dialog).getByText("1 / 3")).toBeInTheDocument();
    expect(within(dialog).getByText("4 / 10")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchCapsuleDetailImpl).toHaveBeenCalledWith(DEFAULT_ID);
    });

    finishRefresh?.({ ok: true, capsuleId: DEFAULT_ID });
    await waitFor(() => {
      expect(onActionComplete).toHaveBeenCalledOnce();
    });
  });

  it("refresh confirm button is enabled without typing a name", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /refresh changed files for capsule/i }));

    const dialog = screen.getByRole("dialog");
    const confirmBtn = within(dialog).getByRole("button", { name: /refresh/i });
    expect(confirmBtn).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Repair action
// ---------------------------------------------------------------------------

describe("CapsuleActions — repair action", () => {
  it("calls repairCapsuleImpl when confirmed", async () => {
    const user = userEvent.setup();
    const repairCapsuleImpl = vi.fn().mockImplementation(() => okAction(DEFAULT_ID));
    const onActionComplete = vi.fn();
    render(<CapsuleActions {...defaultProps({ repairCapsuleImpl, onActionComplete })} />);

    await user.click(screen.getByRole("button", { name: /repair failed files for capsule/i }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /repair/i }));

    await waitFor(() => {
      expect(repairCapsuleImpl).toHaveBeenCalledWith(DEFAULT_ID);
    });
    expect(onActionComplete).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Full re-embed action
// ---------------------------------------------------------------------------

describe("CapsuleActions — full re-embed action", () => {
  it("keeps the full re-embed button visible and marks it recommended when vectors are incompatible", () => {
    const { rerender } = render(<CapsuleActions {...defaultProps()} />);
    expect(screen.getByRole("button", { name: /current embedding model/i })).toHaveAttribute(
      "data-recommended",
      "false",
    );

    rerender(<CapsuleActions {...defaultProps({ vectorCompatible: false })} />);
    expect(screen.getByRole("button", { name: /current embedding model/i })).toHaveAttribute(
      "data-recommended",
      "true",
    );
  });

  it("calls reembedCapsuleImpl when confirmed", async () => {
    const user = userEvent.setup();
    const reembedCapsuleImpl = vi.fn().mockImplementation(() => okAction(DEFAULT_ID));
    const onActionComplete = vi.fn();
    render(
      <CapsuleActions
        {...defaultProps({ reembedCapsuleImpl, onActionComplete, vectorCompatible: false })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /current embedding model/i }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /re-embed/i }));

    await waitFor(() => {
      expect(reembedCapsuleImpl).toHaveBeenCalledWith(DEFAULT_ID);
    });
    expect(onActionComplete).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Full rebuild action
// ---------------------------------------------------------------------------

describe("CapsuleActions — full rebuild action", () => {
  it("calls rebuildCapsuleImpl when confirmed", async () => {
    const user = userEvent.setup();
    const rebuildCapsuleImpl = vi.fn().mockImplementation(() => okAction(DEFAULT_ID));
    const onActionComplete = vi.fn();
    render(<CapsuleActions {...defaultProps({ rebuildCapsuleImpl, onActionComplete })} />);

    await user.click(screen.getByRole("button", { name: /full rebuild capsule/i }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /rebuild/i }));

    await waitFor(() => {
      expect(rebuildCapsuleImpl).toHaveBeenCalledWith(DEFAULT_ID);
    });
    expect(onActionComplete).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Keyboard focus trap
// ---------------------------------------------------------------------------

describe("CapsuleActions — focus trap", () => {
  it("Tab cycles focus within the delete modal", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /delete capsule/i }));

    const dialog = screen.getByRole("dialog");
    // Focus should be inside dialog after opening
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled])"),
    );
    expect(focusables.length).toBeGreaterThanOrEqual(2);

    // Tab through all focusable elements — no focus should escape to document.body
    for (let i = 0; i < focusables.length + 1; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("Shift+Tab cycles backwards within the refresh modal", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /refresh changed files for capsule/i }));

    const dialog = screen.getByRole("dialog");
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled])"),
    );
    expect(focusables.length).toBeGreaterThanOrEqual(2);

    // Shift+Tab from first focusable should wrap to last
    for (let i = 0; i < focusables.length + 1; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe("CapsuleActions — a11y", () => {
  it("jest-axe: action buttons (no modal) have no violations", async () => {
    const { container } = render(<CapsuleActions {...defaultProps()} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: delete modal (before name input) has no violations", async () => {
    const user = userEvent.setup();
    const { container } = render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /delete capsule/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: refresh modal has no violations", async () => {
    const user = userEvent.setup();
    const { container } = render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /refresh changed files for capsule/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: repair modal has no violations", async () => {
    const user = userEvent.setup();
    const { container } = render(<CapsuleActions {...defaultProps()} />);

    await user.click(screen.getByRole("button", { name: /repair failed files for capsule/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
