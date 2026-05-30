// Tests for FilesPanel (issue #67).
// Covers: loading skeleton, data render, error state, close button, context entries, no excerpt.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ApiError } from "@/lib/api";
import type { WorkspaceSummary, ProjectWithAvailability } from "@/lib/types";
import { FilesPanel } from "./FilesPanel";
import * as api from "@/lib/api";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof api>("@/lib/api");
  return {
    ...actual,
    fetchWorkspaceSummary: vi.fn(),
    ApiError: class ApiError extends Error {
      code: string;
      status: number;
      constructor(code: string, msg: string, status: number) {
        super(msg);
        this.code = code;
        this.status = status;
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const project: ProjectWithAvailability = {
  path: "/workspace/foo",
  name: "Foo Project",
  available: true,
  favorite: false,
  createdAt: 1000,
  lastOpenedAt: 2000,
};

const baseSummary: WorkspaceSummary = {
  root: "/workspace/foo",
  name: "foo",
  version: "1.0.0",
  testFramework: "vitest",
  sourceDirs: ["src"],
  testDirs: ["tests"],
  languages: ["typescript"],
  counts: { discovered: 42, denied: 2, ignored: 5 },
  context: undefined,
};

const summaryWithContext: WorkspaceSummary = {
  ...baseSummary,
  context: {
    totalCandidates: 10,
    usedBytes: 4096,
    budgetBytes: 8192,
    droppedForBudget: 0,
    entries: [
      { path: "src/index.ts", sizeBytes: 512, excerptBytes: 256, selectionReason: "entrypoint", truncated: false, excerpt: "SECRET CONTENT" },
      { path: "src/lib/util.ts", sizeBytes: 1024, excerptBytes: 512, selectionReason: "source", truncated: false, excerpt: "MORE SECRETS" },
      { path: "src/components/A.tsx", sizeBytes: 256, excerptBytes: 128, selectionReason: "source", truncated: false, excerpt: "PRIVATE" },
      { path: "src/components/B.tsx", sizeBytes: 256, excerptBytes: 128, selectionReason: "source", truncated: false, excerpt: "PRIVATE" },
      { path: "src/components/C.tsx", sizeBytes: 256, excerptBytes: 128, selectionReason: "source", truncated: false, excerpt: "PRIVATE" },
      { path: "src/components/D.tsx", sizeBytes: 256, excerptBytes: 128, selectionReason: "source", truncated: false, excerpt: "OVERFLOW ENTRY" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FilesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  it("renders loading skeleton with role=status and aria-live=polite", () => {
    vi.mocked(api.fetchWorkspaceSummary).mockReturnValue(new Promise(() => { /* pending */ }));
    render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Loading project files");
  });

  // ── Data state ────────────────────────────────────────────────────────────

  it("renders workspace summary after fetch resolves", async () => {
    vi.mocked(api.fetchWorkspaceSummary).mockResolvedValue({ summary: baseSummary });
    render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);

    await waitFor(() => {
      expect(screen.getByText("foo")).toBeInTheDocument();
    });

    expect(screen.getByText("1.0.0")).toBeInTheDocument();
    expect(screen.getByText("vitest")).toBeInTheDocument();
    expect(screen.getByText("typescript")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("tests")).toBeInTheDocument();
    expect(screen.getByText(/42 discovered/)).toBeInTheDocument();
  });

  it("renders 'Files' as the panel heading", async () => {
    vi.mocked(api.fetchWorkspaceSummary).mockResolvedValue({ summary: baseSummary });
    render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Files" })).toBeInTheDocument();
    });
  });

  // ── Context pack entries ──────────────────────────────────────────────────

  it("renders first 5 context entries when context pack is present", async () => {
    vi.mocked(api.fetchWorkspaceSummary).mockResolvedValue({ summary: summaryWithContext });
    render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);

    await waitFor(() => {
      expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    });

    // 6 entries in fixture but only first 5 should be rendered
    expect(screen.queryByText("src/components/D.tsx")).not.toBeInTheDocument();
    expect(screen.queryByText(/OVERFLOW ENTRY/)).not.toBeInTheDocument();
  });

  it("never renders excerpt content from context entries", async () => {
    vi.mocked(api.fetchWorkspaceSummary).mockResolvedValue({ summary: summaryWithContext });
    render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);

    await waitFor(() => {
      expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    });

    expect(screen.queryByText(/SECRET CONTENT/)).not.toBeInTheDocument();
    expect(screen.queryByText(/MORE SECRETS/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument();
  });

  it("shows context pack summary line with size info", async () => {
    vi.mocked(api.fetchWorkspaceSummary).mockResolvedValue({ summary: summaryWithContext });
    render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);

    await waitFor(() => {
      // summaryWithContext has 6 entries and usedBytes=4096, budgetBytes=8192
      expect(screen.getByText(/6 entries/)).toBeInTheDocument();
    });
  });

  // ── Error state ───────────────────────────────────────────────────────────

  it("renders role=alert with friendly message when fetch fails with ApiError", async () => {
    vi.mocked(api.fetchWorkspaceSummary).mockRejectedValue(
      new ApiError("WORKSPACE_NOT_FOUND", "workspace not found", 404),
    );
    render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert").textContent).toMatch(
      /project directory could not be found/i,
    );
  });

  it("renders role=alert with fallback message for unknown errors", async () => {
    vi.mocked(api.fetchWorkspaceSummary).mockRejectedValue(new Error("network failure"));
    render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  // ── Close button ─────────────────────────────────────────────────────────

  it("calls onClose when close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(api.fetchWorkspaceSummary).mockReturnValue(new Promise(() => { /* pending */ }));
    render(<FilesPanel project={project} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: /close files panel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // ── Axe ──────────────────────────────────────────────────────────────────

  it("has no axe violations in loading state", async () => {
    vi.mocked(api.fetchWorkspaceSummary).mockReturnValue(new Promise(() => { /* pending */ }));
    const { container } = render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations in data state", async () => {
    vi.mocked(api.fetchWorkspaceSummary).mockResolvedValue({ summary: summaryWithContext });
    const { container } = render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);
    await waitFor(() => {
      expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations in error state", async () => {
    vi.mocked(api.fetchWorkspaceSummary).mockRejectedValue(
      new ApiError("INTERNAL", "error", 500),
    );
    const { container } = render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // ── Re-fetch on project path change ──────────────────────────────────────

  it("refetches when project.path changes", async () => {
    vi.mocked(api.fetchWorkspaceSummary).mockResolvedValue({ summary: baseSummary });

    const { rerender } = render(<FilesPanel project={project} onClose={() => { /* noop */ }} />);

    await waitFor(() => {
      expect(screen.getByText("foo")).toBeInTheDocument();
    });

    expect(api.fetchWorkspaceSummary).toHaveBeenCalledTimes(1);

    const otherProject = { ...project, path: "/workspace/bar", name: "Bar" };
    rerender(<FilesPanel project={otherProject} onClose={() => { /* noop */ }} />);

    await waitFor(() => {
      expect(api.fetchWorkspaceSummary).toHaveBeenCalledTimes(2);
    });
  });
});
