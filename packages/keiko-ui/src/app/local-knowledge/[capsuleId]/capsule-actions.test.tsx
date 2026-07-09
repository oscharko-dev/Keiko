// Issue #198 — unit tests for CapsuleActions component.
// Covers: confirmation modal opens, typed-name gate for delete, focus trap,
// all three actions call the correct injectable impl, and jest-axe on every state.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapsuleActions } from "./capsule-actions";
import type { CapsuleActionsProps } from "./capsule-actions";
import { LOCAL_KNOWLEDGE_FILE_FILTERS } from "@oscharko-dev/keiko-contracts";
import type { CapsuleSetId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type {
  CapsuleActionResponse,
  CapsuleDetail,
  CapsuleDetailResponse,
} from "@/lib/local-knowledge-api";

// Epic #1941 — Browse opens the native OS dialog through the shared client. The capability hook
// and the pick call are mocked; the path-mapping helper stays REAL so the root/relative-files
// folding is exercised.
vi.mock("@/lib/native-file-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/native-file-dialog")>();
  return {
    ...actual,
    nativeFileDialogSupported: vi.fn(async () => true),
    pickWithNativeDialog: vi.fn(async () => ({ kind: "cancelled" }) as const),
  };
});

import { pickWithNativeDialog } from "@/lib/native-file-dialog";

const mockPickWithNativeDialog = vi.mocked(pickWithNativeDialog);

const FILE_FILTER_NAMES = {
  documents: "PDF, Word and Excel",
  structuredData: "Tables and structured data",
  textDocuments: "Text and Markdown",
  webDocuments: "Web documents",
  scripts: "Scripts",
  sourceCode: "Source code",
  configuration: "Configuration files",
} as const;

const NATIVE_DOCUMENT_FILTERS = LOCAL_KNOWLEDGE_FILE_FILTERS.map((filter) => ({
  name: FILE_FILTER_NAMES[filter.id],
  extensions: filter.extensions,
}));

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
  // clearAllMocks keeps implementations; pin the default pick outcome so a persistent override
  // from one test can never leak into the next.
  mockPickWithNativeDialog.mockResolvedValue({ kind: "cancelled" });
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

async function openMaintenance(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByText("Maintenance and deletion"));
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

    await user.type(screen.getByLabelText(/source path/i), "/docs/manuals");
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

  it("builds a file-list source when relative document paths are provided", async () => {
    const user = userEvent.setup();
    const connectCapsuleSourceImpl = vi.fn().mockResolvedValue({} as CapsuleDetailResponse);
    render(<CapsuleActions {...defaultProps({ connectCapsuleSourceImpl })} />);

    await user.click(screen.getByText("Index only specific documents"));
    await user.type(screen.getByLabelText(/source path/i), "/repo");
    await user.type(
      screen.getByLabelText(/relative document paths/i),
      "src/app.ts{enter}README.md{enter}src/app.ts",
    );
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(connectCapsuleSourceImpl).toHaveBeenCalledWith(DEFAULT_ID, {
        kind: "files",
        rootPath: "/repo",
        files: ["src/app.ts", "README.md"],
      });
    });
  });

  it("lets the user browse a folder natively instead of typing the path manually", async () => {
    const user = userEvent.setup();
    const connectCapsuleSourceImpl = vi.fn().mockResolvedValue({} as CapsuleDetailResponse);
    mockPickWithNativeDialog.mockResolvedValueOnce({ kind: "picked", paths: ["/repo/docs"] });

    render(<CapsuleActions {...defaultProps({ connectCapsuleSourceImpl })} />);

    const browse = screen.getByRole("button", { name: /^select folder$/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);

    await waitFor(() =>
      expect(mockPickWithNativeDialog).toHaveBeenCalledWith({
        mode: "open-directory",
        title: "Choose a folder for this Knowledge Pod",
      }),
    );
    expect(screen.getByLabelText(/source path/i)).toHaveValue("/repo/docs");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(connectCapsuleSourceImpl).toHaveBeenCalledWith(DEFAULT_ID, {
        kind: "folder",
        rootPath: "/repo/docs",
        recursive: true,
      });
    });
  });

  it("folds natively picked files into a shared root and relative file list", async () => {
    const user = userEvent.setup();
    const connectCapsuleSourceImpl = vi.fn().mockResolvedValue({} as CapsuleDetailResponse);
    mockPickWithNativeDialog.mockResolvedValueOnce({
      kind: "picked",
      paths: ["/repo/README.md", "/repo/CHANGELOG.md"],
    });

    render(<CapsuleActions {...defaultProps({ connectCapsuleSourceImpl })} />);

    const browse = screen.getByRole("button", { name: /^select documents$/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);

    await waitFor(() =>
      expect(mockPickWithNativeDialog).toHaveBeenCalledWith({
        mode: "open-files",
        title: "Choose documents for this Knowledge Pod",
        filters: NATIVE_DOCUMENT_FILTERS,
      }),
    );
    expect(screen.getByLabelText(/source path/i)).toHaveValue("/repo");
    expect(screen.getByLabelText(/relative document paths/i)).toHaveValue(
      "README.md\nCHANGELOG.md",
    );
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(connectCapsuleSourceImpl).toHaveBeenCalledWith(DEFAULT_ID, {
        kind: "files",
        rootPath: "/repo",
        files: ["README.md", "CHANGELOG.md"],
      });
    });
  });

  it("uses the picked file's parent folder as the shared root for the files scope", async () => {
    const user = userEvent.setup();
    const connectCapsuleSourceImpl = vi.fn().mockResolvedValue({} as CapsuleDetailResponse);
    mockPickWithNativeDialog.mockResolvedValueOnce({
      kind: "picked",
      paths: ["/home/user/Desktop/Inside Agentic AI.pdf"],
    });

    render(<CapsuleActions {...defaultProps({ connectCapsuleSourceImpl })} />);

    const browse = screen.getByRole("button", { name: /^select documents$/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);

    await waitFor(() =>
      expect(screen.getByLabelText(/source path/i)).toHaveValue("/home/user/Desktop"),
    );
    expect(screen.getByLabelText(/relative document paths/i)).toHaveValue("Inside Agentic AI.pdf");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(connectCapsuleSourceImpl).toHaveBeenCalledWith(DEFAULT_ID, {
        kind: "files",
        rootPath: "/home/user/Desktop",
        files: ["Inside Agentic AI.pdf"],
      });
    });
  });

  it("shows the local knowledge limits next to the connect form", () => {
    render(<CapsuleActions {...defaultProps()} />);
    expect(screen.getByText(/Maximum single file size: 1 GB/i)).toBeInTheDocument();
  });

  it("surfaces a calm message when the native dialog fails and keeps manual entry usable", async () => {
    const user = userEvent.setup();
    mockPickWithNativeDialog.mockResolvedValueOnce({ kind: "busy" });

    render(<CapsuleActions {...defaultProps()} />);

    const browse = screen.getByRole("button", { name: /^select folder$/i });
    await waitFor(() => expect(browse).not.toBeDisabled());
    await user.click(browse);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A native dialog is already open. Close it first.",
    );
    const manualInput = screen.getByLabelText(/source path/i);
    await user.type(manualInput, "/manual/path");
    expect(manualInput).toHaveValue("/manual/path");
  });
});

// ---------------------------------------------------------------------------
// Modal open / close
// ---------------------------------------------------------------------------

describe("CapsuleActions — modal open and close", () => {
  it("opens the delete modal when Delete is clicked", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /delete Knowledge Pod/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/delete Knowledge Pod/i)).toBeInTheDocument();
  });

  it("opens the refresh modal when Refresh changed files is clicked", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await openMaintenance(user);
    await user.click(
      screen.getByRole("button", { name: /refresh changed files for Knowledge Pod/i }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/refresh changed files/i)).toBeInTheDocument();
  });

  it("opens the repair modal when Repair failed files is clicked", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await openMaintenance(user);
    await user.click(
      screen.getByRole("button", { name: /repair failed files for Knowledge Pod/i }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/repair failed files/i)).toBeInTheDocument();
  });

  it("opens the full rebuild modal when Full rebuild / rechunk is clicked", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /full rebuild Knowledge Pod/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/full rebuild \/ rechunk/i)).toBeInTheDocument();
  });

  it("closes the modal when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /delete Knowledge Pod/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the modal when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /delete Knowledge Pod/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delete — typed-name confirmation gate
// ---------------------------------------------------------------------------

describe("CapsuleActions — delete typed-name confirmation", () => {
  it("confirm button is disabled until the pod name is typed exactly", async () => {
    const user = userEvent.setup();
    render(<CapsuleActions {...defaultProps()} />);

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /delete Knowledge Pod/i }));

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

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /delete Knowledge Pod/i }));

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

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /delete Knowledge Pod/i }));

    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), DEFAULT_NAME);
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledWith(response);
    });
    expect(onActionComplete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("AUDIT-E1821-001: warns before navigating away when delete affects Knowledge Pod Sets", async () => {
    const user = userEvent.setup();
    const response: CapsuleActionResponse = {
      ok: true,
      capsuleId: DEFAULT_ID,
      affectedCapsuleSetIds: ["set-y" as CapsuleSetId],
      cleanupVerified: true,
    };
    const deleteCapsuleImpl = vi.fn().mockResolvedValue(response);
    const onDeleted = vi.fn();
    render(<CapsuleActions {...defaultProps({ deleteCapsuleImpl, onDeleted })} />);

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /delete Knowledge Pod/i }));

    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), DEFAULT_NAME);
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    const notice = await screen.findByRole("alertdialog");
    expect(notice.textContent).toContain("removed from 1 Knowledge Pod Set");
    // onDeleted must not fire until the notice is acknowledged — otherwise the
    // caller navigates away before the user ever sees the warning.
    expect(onDeleted).not.toHaveBeenCalled();

    await user.click(within(notice).getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledWith(response);
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows an error banner and keeps the modal open when deleteCapsule rejects", async () => {
    const user = userEvent.setup();
    const deleteCapsuleImpl = vi.fn().mockRejectedValue(new Error("delete failed"));
    render(<CapsuleActions {...defaultProps({ deleteCapsuleImpl })} />);

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /delete Knowledge Pod/i }));

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

    await user.click(screen.getByRole("button", { name: /index this Knowledge Pod now/i }));

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

    await openMaintenance(user);
    await user.click(
      screen.getByRole("button", { name: /refresh changed files for Knowledge Pod/i }),
    );

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

    await openMaintenance(user);
    await user.click(
      screen.getByRole("button", { name: /refresh changed files for Knowledge Pod/i }),
    );

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

    await openMaintenance(user);
    await user.click(
      screen.getByRole("button", { name: /refresh changed files for Knowledge Pod/i }),
    );

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

    await openMaintenance(user);
    await user.click(
      screen.getByRole("button", { name: /repair failed files for Knowledge Pod/i }),
    );

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
  it("keeps the full re-embed button visible and marks it recommended when vectors are incompatible", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CapsuleActions {...defaultProps()} />);
    await openMaintenance(user);
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

    await openMaintenance(user);
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

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /full rebuild Knowledge Pod/i }));

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

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /delete Knowledge Pod/i }));

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

    await openMaintenance(user);
    await user.click(
      screen.getByRole("button", { name: /refresh changed files for Knowledge Pod/i }),
    );

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

    await openMaintenance(user);
    await user.click(screen.getByRole("button", { name: /delete Knowledge Pod/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: refresh modal has no violations", async () => {
    const user = userEvent.setup();
    const { container } = render(<CapsuleActions {...defaultProps()} />);

    await openMaintenance(user);
    await user.click(
      screen.getByRole("button", { name: /refresh changed files for Knowledge Pod/i }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: repair modal has no violations", async () => {
    const user = userEvent.setup();
    const { container } = render(<CapsuleActions {...defaultProps()} />);

    await openMaintenance(user);
    await user.click(
      screen.getByRole("button", { name: /repair failed files for Knowledge Pod/i }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
