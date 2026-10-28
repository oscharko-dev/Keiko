import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingHistoryTask,
  CodingTaskExportResponse,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { ApiError } from "@/lib/api";
import {
  exportCodingTask,
  fetchCodingHistory,
  saveCodingTaskExport,
} from "@/lib/coding-history-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { CodingHistoryPanel } from "./CodingHistoryPanel";

vi.mock("@/lib/coding-history-api", () => ({
  CODING_HISTORY_CHANGED: "keiko:coding-history-changed",
  exportCodingTask: vi.fn(),
  fetchCodingHistory: vi.fn(),
  saveCodingTaskExport: vi.fn(),
  updateCodingTask: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const task: CodingHistoryTask = {
  id: "task-one",
  title: "Generate navigation tests",
  projectPath: "/projects/example",
  branch: "feature/navigation",
  workspaceId: "workspace-one",
  taskId: "task-one",
  modelId: "coding",
  status: "active",
  createdAt: 1,
  updatedAt: 2,
};

const file: CodingTaskExportResponse = {
  format: "json",
  fileName: "keiko-coding-task-task-one.json",
  mediaType: "application/json",
  content: "{}\n",
  messageCount: 2,
  byteCount: 3,
  truncated: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchCodingHistory).mockResolvedValue([task]);
});

describe("coding task export action", () => {
  it("offers both formats and says nothing leaves the device", async () => {
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    const json = await screen.findByRole("button", { name: "Export JSON" });
    const markdown = screen.getByRole("button", { name: "Export Markdown" });
    expect(json).toBeEnabled();
    expect(markdown).toHaveAttribute("title", expect.stringContaining("Nothing is uploaded"));
    expect(exportCodingTask).not.toHaveBeenCalled();
    expect(saveCodingTaskExport).not.toHaveBeenCalled();
  });

  it("exports the chosen task in the chosen format and hands the file to the browser", async () => {
    vi.mocked(exportCodingTask).mockResolvedValue({ ...file, format: "markdown" });
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Export Markdown" }));
    await waitFor(() => expect(saveCodingTaskExport).toHaveBeenCalledOnce());
    expect(exportCodingTask).toHaveBeenCalledWith(task.id, "markdown");
    expect(saveCodingTaskExport).toHaveBeenCalledWith({ ...file, format: "markdown" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeEnabled();
  });

  it("blocks a second request while one is being prepared", async () => {
    let finish: (value: CodingTaskExportResponse) => void = () => {
      throw new Error("export not started");
    };
    vi.mocked(exportCodingTask).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Export JSON" }));
    expect(await screen.findByText("Preparing export…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export Markdown" })).toBeDisabled();
    await act(async () => {
      finish(file);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Export JSON" })).toBeEnabled());
    expect(saveCodingTaskExport).toHaveBeenCalledOnce();
    expect(screen.queryByText("Preparing export…")).not.toBeInTheDocument();
  });

  it("shows a failure, saves nothing and reports a body-free diagnostic with its correlation", async () => {
    vi.mocked(exportCodingTask).mockRejectedValueOnce(
      Object.assign(new ApiError("INTERNAL", "disk said no at /private/secret", 500), {
        correlationId: "ui_export-failure-0001",
      }),
    );
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Export JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be exported");
    expect(saveCodingTaskExport).not.toHaveBeenCalled();
    expect(reportClientDiagnostic).toHaveBeenCalledOnce();
    const [message, meta] = vi.mocked(reportClientDiagnostic).mock.calls[0] ?? [];
    expect(message).toMatch(/^\[keiko\] coding task export failed: /u);
    expect(message).not.toContain("secret");
    expect(meta).toMatchObject({ correlationId: "ui_export-failure-0001" });
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeEnabled();
    vi.mocked(exportCodingTask).mockResolvedValueOnce(file);
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    await waitFor(() => expect(saveCodingTaskExport).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a failure of the browser save itself the same way", async () => {
    vi.mocked(exportCodingTask).mockResolvedValue(file);
    vi.mocked(saveCodingTaskExport).mockImplementation(() => {
      throw new TypeError("blocked");
    });
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Export JSON" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(vi.mocked(reportClientDiagnostic).mock.calls[0]?.[0]).toBe(
      "[keiko] coding task export failed: TypeError",
    );
  });

  it("has no serious or critical axe violations, idle or failed", async () => {
    vi.mocked(exportCodingTask).mockRejectedValueOnce(new Error("unavailable"));
    const { container } = render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    const idle = await axe(container);
    fireEvent.click(await screen.findByRole("button", { name: "Export JSON" }));
    await screen.findByRole("alert");
    const failed = await axe(container);
    const blocking = new Set(["serious", "critical"]);
    for (const report of [idle, failed]) {
      expect(report.violations.filter((violation) => blocking.has(violation.impact ?? ""))).toEqual(
        [],
      );
    }
  });
});
