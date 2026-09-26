import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingHistoryTask } from "@oscharko-dev/keiko-contracts/bff-wire";
import { CodingHistoryPanel, CodingHistoryWindowHost } from "./CodingHistoryPanel";
import {
  CODING_HISTORY_CHANGED,
  fetchCodingHistory,
  updateCodingTask,
} from "@/lib/coding-history-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

vi.mock("@/lib/coding-history-api", () => ({
  CODING_HISTORY_CHANGED: "keiko:coding-history-changed",
  fetchCodingHistory: vi.fn(),
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
const completed: CodingHistoryTask = {
  ...task,
  id: "task-two",
  title: "Refactor FAQ",
  branch: "feature/faq",
  status: "completed",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchCodingHistory).mockResolvedValue([task, completed]);
  vi.mocked(updateCodingTask).mockResolvedValue(task);
});

describe("coding history navigation", () => {
  it("opens saved and new tasks through the lazy window host", async () => {
    const openWindow = vi.fn();
    render(<CodingHistoryWindowHost context={{ openWindow }} />);
    fireEvent.click(await screen.findByText(task.title));
    expect(openWindow).toHaveBeenCalledWith("coding", {
      repositoryPath: task.projectPath,
      historySelection: task.id,
    });
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(openWindow).toHaveBeenLastCalledWith("coding", {
      historySelection: expect.stringMatching(/^new:\d+$/u) as string,
    });
  });

  it("opens the selected task, filters by state, title and branch, and creates a fresh task", async () => {
    const open = vi.fn();
    const create = vi.fn();
    render(<CodingHistoryPanel onOpen={open} onNew={create} />);
    fireEvent.click(await screen.findByRole("button", { name: /Generate navigation tests/ }));
    expect(open).toHaveBeenCalledWith(task);
    expect(screen.queryByText("Refactor FAQ")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Completed 1" }));
    expect(screen.getByText("Refactor FAQ")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  FEATURE/FAQ  " } });
    expect(screen.getByText("Refactor FAQ")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unmatched" } });
    expect(screen.getByText(/No tasks match/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(create).toHaveBeenCalledOnce();
  });

  it("shows loading then recovers from a failed fetch through Refresh", async () => {
    vi.mocked(fetchCodingHistory).mockRejectedValueOnce(new Error("unavailable"));
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading task");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(reportClientDiagnostic).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(task.title)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refreshes on a history mutation and unsubscribes when closed", async () => {
    const { unmount } = render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    await screen.findByText(task.title);
    vi.mocked(fetchCodingHistory).mockResolvedValue([]);
    act(() => window.dispatchEvent(new Event(CODING_HISTORY_CHANGED)));
    expect(await screen.findByText(/No tasks match/)).toBeVisible();
    expect(fetchCodingHistory).toHaveBeenCalledTimes(2);
    unmount();
    window.dispatchEvent(new Event(CODING_HISTORY_CHANGED));
    expect(fetchCodingHistory).toHaveBeenCalledTimes(2);
  });

  // #3626: Cancel discards the draft; the next edit starts from the task's current title.
  it("discards an unsaved rename draft after Cancel", async () => {
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Rename" }))[0] as HTMLElement);
    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), {
      target: { value: "Discarded draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[0] as HTMLElement);
    expect(screen.getByRole("textbox", { name: "Task title" })).toHaveValue(task.title);
    expect(updateCodingTask).not.toHaveBeenCalled();
  });

  // #3628: a slow older read must not overwrite the list a newer read already showed.
  it("keeps the latest refresh when an older read answers after it", async () => {
    let answerOlder: ((tasks: readonly CodingHistoryTask[]) => void) | undefined;
    let answerNewer: ((tasks: readonly CodingHistoryTask[]) => void) | undefined;
    vi.mocked(fetchCodingHistory)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerOlder = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerNewer = resolve;
          }),
      );
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    act(() => {
      window.dispatchEvent(new Event(CODING_HISTORY_CHANGED));
    });
    await waitFor(() => expect(fetchCodingHistory).toHaveBeenCalledTimes(2));
    await act(async () => {
      answerNewer?.([{ ...task, title: "New title" }]);
      await Promise.resolve();
    });
    expect(await screen.findByText("New title")).toBeVisible();
    await act(async () => {
      answerOlder?.([{ ...task, title: "Old title" }]);
      await Promise.resolve();
    });
    expect(screen.getByText("New title")).toBeVisible();
    expect(screen.queryByText("Old title")).not.toBeInTheDocument();
  });

  // #3630: a Windows project path names its folder like a POSIX one does.
  it.each([
    ["C:\\work\\repo", "repo"],
    ["C:\\work\\repo\\", "repo"],
    ["/projects/example/", "example"],
  ])("shows the folder name of %s", async (projectPath, folder) => {
    vi.mocked(fetchCodingHistory).mockResolvedValue([{ ...task, projectPath }]);
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    expect(await screen.findByText(`${folder} · ${task.branch}`)).toBeVisible();
  });

  it("validates a rename, preserves an unsuccessful edit and allows retry or cancel", async () => {
    vi.mocked(updateCodingTask).mockRejectedValueOnce(new Error("unavailable"));
    render(<CodingHistoryPanel onOpen={vi.fn()} onNew={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Task title" });
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "  Better title  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(input).toHaveValue("  Better title  ");
    expect(updateCodingTask).toHaveBeenCalledWith(task.id, { title: "Better title" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(updateCodingTask).toHaveBeenCalledTimes(2);
  });
});
