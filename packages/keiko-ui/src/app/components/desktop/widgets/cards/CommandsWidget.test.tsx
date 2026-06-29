// Issue #1387 — CommandsWidget tests. Mocks the typed BFF client + EventSource so the panel drives
// the UI through the same paths a real BFF would. Covers: catalog fetch, run-button POST, failure
// surface, cancel via SSE-captured runId, SSE event display, and an axe a11y smoke.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../lib/api";
import {
  cancelCommandRun,
  createCommandRun,
  fetchCommandCatalog,
} from "../../../../../lib/commands-api";
import type { CommandTaskCatalog, CommandTaskRunResult } from "../../../../../lib/types";
import { CommandsWidget } from "./CommandsWidget";

vi.mock("../../../../../lib/commands-api", () => ({
  fetchCommandCatalog: vi.fn(),
  createCommandRun: vi.fn(),
  cancelCommandRun: vi.fn(),
  commandEventsUrl: (): string => "/api/commands/events",
}));

type EsListener = (ev: MessageEvent<string>) => void;

class FakeEventSource {
  public readonly url: string;
  public readonly listeners = new Map<string, EsListener[]>();
  public closed = false;
  public static last: FakeEventSource | null = null;

  public constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }

  public addEventListener(type: string, listener: EsListener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  public close(): void {
    this.closed = true;
  }

  public dispatch(type: string, data: string): void {
    for (const h of this.listeners.get(type) ?? []) h(new MessageEvent(type, { data }));
  }
}

const CATALOG: CommandTaskCatalog = {
  schemaVersion: "1",
  projectId: "/proj",
  tasks: [
    {
      id: "npm-script:test",
      kind: "test",
      label: "npm run test",
      executable: "npm",
      args: ["run", "test"],
      source: "package-json-script",
    },
    {
      id: "npm-script:build",
      kind: "build",
      label: "npm run build",
      executable: "npm",
      args: ["run", "build"],
      source: "package-json-script",
    },
  ],
};

const RESULT: CommandTaskRunResult = {
  schemaVersion: "1",
  runId: "run-1",
  taskId: "npm-script:test",
  kind: "test",
  exitCode: 0,
  durationMs: 12,
  truncated: false,
  timedOut: false,
  failureReason: "none",
  stdout: "all good",
  stderr: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "req-own") });
  FakeEventSource.last = null;
  vi.mocked(fetchCommandCatalog).mockResolvedValue(CATALOG);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CommandsWidget", () => {
  it("renders the form with project and task controls", async () => {
    render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    expect(screen.getByLabelText(/project path/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run task/i })).toBeInTheDocument();
  });

  it("reloads the discovered task catalog when the window project path changes", async () => {
    const view = render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    vi.mocked(fetchCommandCatalog).mockClear();

    view.rerender(<CommandsWidget projectPath="/proj-next" />);

    await waitFor(() => expect(fetchCommandCatalog).toHaveBeenCalledWith("/proj-next"));
    expect(screen.getByLabelText(/project path/i)).toHaveValue("/proj-next");
  });

  it("populates the task dropdown from the discovered catalog", async () => {
    const user = userEvent.setup();
    render(<CommandsWidget projectPath="/proj" />);
    const select = await screen.findByRole("combobox", { name: /task/i });
    await user.click(select);
    expect(await screen.findByRole("option", { name: /test · npm run test/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /build · npm run build/i })).toBeInTheDocument();
  });

  it("runs the selected task and displays the structured result (role=status)", async () => {
    vi.mocked(createCommandRun).mockResolvedValue(RESULT);
    render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run task/i })).toHaveAttribute(
        "aria-disabled",
        "false",
      );
    });
    await userEvent.click(screen.getByRole("button", { name: /run task/i }));
    expect((await screen.findAllByText(/exit 0/i)).length).toBeGreaterThan(0);
    expect(screen.getByText("run run-1")).toBeInTheDocument();
    expect(screen.getByText("task npm-script:test")).toBeInTheDocument();
    expect(screen.getByText(/all good/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/run finished: exit 0/i);
    expect(createCommandRun).toHaveBeenCalledWith({
      projectId: "/proj",
      taskId: "npm-script:test",
      requestId: "req-own",
    });
  });

  it("guards against duplicate submissions before React rerenders the running state", async () => {
    vi.mocked(createCommandRun).mockImplementation(() => new Promise<never>(() => undefined));
    render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    const runButton = screen.getByRole("button", { name: /run task/i });
    await waitFor(() => expect(runButton).toHaveAttribute("aria-disabled", "false"));

    fireEvent.click(runButton);
    fireEvent.click(runButton);

    expect(createCommandRun).toHaveBeenCalledTimes(1);
    expect(runButton).toBeDisabled();
  });

  it("surfaces a failure reason badge for a non-zero exit", async () => {
    vi.mocked(createCommandRun).mockResolvedValue({
      ...RESULT,
      exitCode: 1,
      failureReason: "non-zero-exit",
      stdout: "",
      stderr: "1 failing",
    });
    render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    await userEvent.click(screen.getByRole("button", { name: /run task/i }));
    expect((await screen.findAllByText(/non-zero-exit/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 failing/)).toBeInTheDocument();
  });

  it("surfaces a TASK_NOT_FOUND error and lets the user dismiss it", async () => {
    vi.mocked(createCommandRun).mockRejectedValue(
      new ApiError("TASK_NOT_FOUND", "Task is not in the discovered catalog.", 404),
    );
    render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    await userEvent.click(screen.getByRole("button", { name: /run task/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("TASK_NOT_FOUND");
    await userEvent.click(screen.getByRole("button", { name: /dismiss error/i }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces a catalog discovery failure as an error", async () => {
    vi.mocked(fetchCommandCatalog).mockRejectedValue(
      new ApiError("PROJECT_NOT_FOUND", "Project not found.", 404),
    );
    render(<CommandsWidget projectPath="/proj" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("PROJECT_NOT_FOUND");
  });

  it("labels run-failed and run-cancelled SSE events", async () => {
    render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.dispatch(
      "command:run-failed",
      JSON.stringify({
        kind: "run-failed",
        runId: "r1",
        payload: { failureReason: "spawn-error", durationMs: 3 },
      }),
    );
    FakeEventSource.last?.dispatch(
      "command:run-cancelled",
      JSON.stringify({ kind: "run-cancelled", runId: "r2", payload: {} }),
    );
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getByText(/cancelled/)).toBeInTheDocument();
    expect(screen.getByText(/failed/)).toBeInTheDocument();
  });

  it("shows an empty-catalog notice when no tasks are discovered", async () => {
    vi.mocked(fetchCommandCatalog).mockResolvedValue({
      schemaVersion: "1",
      projectId: "/proj",
      tasks: [],
    });
    render(<CommandsWidget projectPath="/proj" />);
    expect(await screen.findByText(/no runnable test, build, or run tasks/i)).toBeInTheDocument();
  });

  it("appends SSE events to the recent events list in live order", async () => {
    render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last?.dispatch(
      "command:run-started",
      JSON.stringify({ kind: "run-started", runId: "r8", payload: { requestId: "x" } }),
    );
    FakeEventSource.last?.dispatch(
      "command:run-completed",
      JSON.stringify({
        kind: "run-completed",
        runId: "r8",
        payload: { failureReason: "none", durationMs: 7, requestId: "x" },
      }),
    );
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/completed/);
    expect(items[1]).toHaveTextContent(/started/);
  });

  it("closes the EventSource when unmounted", async () => {
    const { unmount } = render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    unmount();
    expect(FakeEventSource.last?.closed).toBe(true);
  });

  it("enables Cancel after the owned run-started SSE arrives and aborts on click", async () => {
    vi.mocked(createCommandRun).mockImplementation(
      () => new Promise<never>(() => undefined), // never resolves — simulates in-flight
    );
    vi.mocked(cancelCommandRun).mockResolvedValue(undefined);
    render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /run task/i }));
    const cancel = await screen.findByRole("button", { name: /cancel/i });
    expect(cancel).toHaveAttribute("aria-disabled", "true");
    FakeEventSource.last?.dispatch(
      "command:run-started",
      JSON.stringify({ kind: "run-started", runId: "run-77", payload: { requestId: "req-own" } }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /cancel/i })).toHaveAttribute(
        "aria-disabled",
        "false",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(cancelCommandRun).toHaveBeenCalledWith("run-77");
  });

  it("ignores a foreign run-started SSE when deciding whether Cancel should enable", async () => {
    vi.mocked(createCommandRun).mockImplementation(() => new Promise<never>(() => undefined));
    render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /run task/i }));
    await screen.findByRole("button", { name: /cancel/i });
    FakeEventSource.last?.dispatch(
      "command:run-started",
      JSON.stringify({
        kind: "run-started",
        runId: "run-foreign",
        payload: { requestId: "other" },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /cancel/i })).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    expect(cancelCommandRun).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    vi.mocked(createCommandRun).mockResolvedValue(RESULT);
    const { container } = render(<CommandsWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /task/i });
    await userEvent.click(screen.getByRole("button", { name: /run task/i }));
    await screen.findAllByText(/exit 0/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
