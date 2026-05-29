import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import PatchPage from "./page";
import * as api from "@/lib/api";

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (key: string) => key === "id" ? "run-patch-456" : null }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  fetchRunReport: vi.fn(),
  applyRun: vi.fn(),
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, msg: string, status: number) {
      super(msg);
      this.code = code;
      this.status = status;
    }
  },
}));

const dryRunReport = {
  report: {
    status: "dry-run" as const,
    proposedDiff: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,2 +1,3 @@\n const x = 1;\n+const y = 2;\n",
    changedFiles: [{
      path: "src/foo.ts",
      kind: "modified",
      addedLines: 1,
      removedLines: 0,
      elevatedReview: false,
    }],
  },
};

describe("PatchPage (/run/patch?id=)", () => {
  beforeEach(() => {
    vi.mocked(api.fetchRunReport).mockResolvedValue(dryRunReport);
    vi.mocked(api.applyRun).mockResolvedValue({ report: { status: "completed" } });
  });

  it("renders the patch review heading after loading", async () => {
    render(<PatchPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: /patch review/i })).toBeInTheDocument();
    });
  });

  it("renders the diff viewer", async () => {
    render(<PatchPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /proposed diff/i })).toBeInTheDocument();
    });
  });

  it("Apply patch button is reachable by keyboard", async () => {
    render(<PatchPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /apply patch/i })).toBeInTheDocument();
    });
    const applyBtn = screen.getByRole("button", { name: /apply patch/i });
    applyBtn.focus();
    expect(document.activeElement).toBe(applyBtn);
  });

  it("shows confirmation before applying", async () => {
    const user = userEvent.setup();
    render(<PatchPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /apply patch/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /apply patch/i }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm apply/i })).toBeInTheDocument();
  });

  it("calls applyRun after confirmation", async () => {
    const user = userEvent.setup();
    render(<PatchPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /apply patch/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /apply patch/i }));
    await user.click(screen.getByRole("button", { name: /confirm apply/i }));
    await waitFor(() => {
      expect(api.applyRun).toHaveBeenCalledWith("run-patch-456");
    });
  });

  it("Escape key on the apply confirm dismisses and returns focus to Apply button", async () => {
    const user = userEvent.setup();
    render(<PatchPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /apply patch/i })).toBeInTheDocument();
    });
    // Open the confirm dialog
    await user.click(screen.getByRole("button", { name: /apply patch/i }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    // The confirm button should be focused
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /confirm apply/i }));
    // Press Escape — dialog should close
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // Focus should return to the Apply patch button
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /apply patch/i }));
  });

  it("alertdialog has aria-modal=true", async () => {
    const user = userEvent.setup();
    render(<PatchPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /apply patch/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /apply patch/i }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<PatchPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
