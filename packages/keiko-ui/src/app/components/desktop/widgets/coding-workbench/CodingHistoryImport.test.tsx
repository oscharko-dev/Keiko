import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingHistoryTask,
  CodingTaskImportResponse,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { ApiError } from "@/lib/api";
import { fetchCodingHistory, importCodingTask } from "@/lib/coding-history-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { CodingHistoryPanel } from "./CodingHistoryPanel";

vi.mock("@/lib/coding-history-api", () => ({
  CODING_HISTORY_CHANGED: "keiko:coding-history-changed",
  exportCodingTask: vi.fn(),
  fetchCodingHistory: vi.fn(),
  importCodingTask: vi.fn(),
  saveCodingTaskExport: vi.fn(),
  updateCodingTask: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

const task: CodingHistoryTask = {
  id: "task-imported",
  title: "Generate navigation tests",
  projectPath: "/projects/example",
  branch: "feature/navigation",
  workspaceId: "workspace-one",
  taskId: "task-one",
  modelId: "coding",
  status: "active",
  createdAt: 1,
  updatedAt: 2,
  origin: "imported",
};

function imported(overrides: Partial<CodingTaskImportResponse> = {}): CodingTaskImportResponse {
  return {
    task,
    source: "keiko-task-export",
    messageCount: 2,
    omittedMessageCount: 0,
    skippedMessageCount: 0,
    ...overrides,
  };
}

const file = new File(['{"schema":"keiko-coding-task-export"}'], "task.json", {
  type: "application/json",
});

function pick(chosen: readonly File[]): void {
  fireEvent.change(screen.getByLabelText("Coding task file"), { target: { files: chosen } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchCodingHistory).mockResolvedValue([]);
});

// #3904 AC4: the person picks a saved task on their device; it becomes a new task that opens.
describe("coding task import action", () => {
  it("offers the import beside a new task and says the file stays on the device", async () => {
    const { container } = render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    const action = screen.getByRole("button", { name: "Import task" });
    expect(action).toHaveAttribute("title", expect.stringContaining("stays on this computer"));
    expect(screen.getByLabelText("Coding task file")).toHaveAttribute(
      "accept",
      ".json,application/json",
    );
    await waitFor(() => expect(fetchCodingHistory).toHaveBeenCalled());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("opens the file picker from the action", () => {
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    const input = screen.getByLabelText<HTMLInputElement>("Coding task file");
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "Import task" }));
    expect(click).toHaveBeenCalledOnce();
  });

  it("imports the chosen file and opens the new task", async () => {
    vi.mocked(importCodingTask).mockResolvedValue(imported());
    const onOpen = vi.fn();
    render(<CodingHistoryPanel onOpen={onOpen} onNew={vi.fn()} />);
    pick([file]);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(task));
    expect(importCodingTask).toHaveBeenCalledWith(file);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(reportClientDiagnostic).not.toHaveBeenCalled();
  });

  it("does nothing when the person closes the picker without a file", () => {
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    pick([]);
    expect(importCodingTask).not.toHaveBeenCalled();
  });

  it("blocks a second import while one is running", async () => {
    let finish: (value: CodingTaskImportResponse) => void = () => {
      throw new Error("import not started");
    };
    vi.mocked(importCodingTask).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    pick([file]);
    expect(await screen.findByText("Importing task…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Import task" })).toBeDisabled();
    finish(imported());
    await waitFor(() => expect(screen.getByRole("button", { name: "Import task" })).toBeEnabled());
  });

  it("says when older messages were left out", async () => {
    vi.mocked(importCodingTask).mockResolvedValue(
      imported({ messageCount: 200, omittedMessageCount: 12 }),
    );
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    pick([file]);
    expect(
      await screen.findByText(
        "Older messages were left out. The 200 most recent messages were imported.",
      ),
    ).toBeVisible();
  });

  it.each([
    ["CODING_HISTORY_IMPORT_INVALID", "This file is not a coding task export"],
    ["CODING_HISTORY_IMPORT_UNSUPPORTED_VERSION", "newer Keiko version"],
    ["CODING_HISTORY_IMPORT_TOO_LARGE", "too large to import"],
    ["CODING_HISTORY_IMPORT_EMPTY", "no conversation to import"],
    ["CODING_HISTORY_IMPORT_NO_WORKSPACE", "Open a workspace first"],
    ["INTERNAL", "could not be imported"],
  ])("explains the refusal %s and reports it", async (code, text) => {
    const failure = new ApiError(code, "refused", 400);
    failure.correlationId = "import-correlation";
    vi.mocked(importCodingTask).mockRejectedValue(failure);
    const onOpen = vi.fn();
    render(<CodingHistoryPanel onOpen={onOpen} onNew={vi.fn()} />);
    pick([file]);
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(onOpen).not.toHaveBeenCalled();
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("coding task import failed"),
      { correlationId: "import-correlation" },
    );
  });

  it("explains an unexpected failure without a code", async () => {
    vi.mocked(importCodingTask).mockRejectedValue(new TypeError("network down"));
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    pick([file]);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be imported");
  });
});
