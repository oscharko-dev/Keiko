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
import type { CapsuleActionResponse, CapsuleDetailResponse } from "@/lib/local-knowledge-api";

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
    startIndexingImpl: vi.fn().mockImplementation(() => okAction(DEFAULT_ID)),
    ...overrides,
  };
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

    await user.selectOptions(screen.getByLabelText(/connect source/i), "repository");
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

    await user.selectOptions(screen.getByLabelText(/connect source/i), "files");
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

    await user.selectOptions(screen.getByLabelText(/connect source/i), "files");
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
      <CapsuleActions
        {...defaultProps({ deleteCapsuleImpl, onActionComplete, onDeleted })}
      />,
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
