// ADR-0018 D11 — TerminalWidget tests. Mocks the typed BFF client + EventSource so the panel
// drives the UI through the same paths a real BFF would. Covers: policy fetch, run-button POST,
// denied-command surface, abort, SSE event display.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../lib/api";
import {
  abortTerminalExecution,
  createTerminalExecution,
  fetchTerminalDirectories,
  fetchTerminalPolicy,
} from "../../../../../lib/terminal-api";
import { TerminalWidget } from "./TerminalWidget";

vi.mock("../../../../../lib/terminal-api", () => ({
  fetchTerminalPolicy: vi.fn(),
  createTerminalExecution: vi.fn(),
  abortTerminalExecution: vi.fn(),
  fetchTerminalDirectories: vi.fn(),
  terminalEventsUrl: (): string => "/api/terminal/events",
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
    const handlers = this.listeners.get(type) ?? [];
    for (const h of handlers) h(new MessageEvent(type, { data }));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "req-own") });
  FakeEventSource.last = null;
  vi.mocked(fetchTerminalPolicy).mockResolvedValue({
    commands: ["ls", "git", "grep"],
    limits: { maxOutputBytes: 262144, defaultTimeoutMs: 30000 },
  });
  vi.mocked(fetchTerminalDirectories).mockResolvedValue({
    path: "",
    parent: null,
    entries: [],
    roots: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TerminalWidget", () => {
  it("renders the form with project, command, args and cwd inputs", async () => {
    render(<TerminalWidget />);
    await screen.findByRole("combobox", { name: /command/i });
    expect(screen.getByLabelText(/project path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/args/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/working directory/i)).toBeInTheDocument();
  });

  it("populates the command dropdown from the policy", async () => {
    render(<TerminalWidget />);
    const select = await screen.findByRole("combobox", { name: /command/i });
    await waitFor(() => {
      expect(select.querySelectorAll("option")).toHaveLength(3);
    });
    expect(screen.getByRole("option", { name: "git" })).toBeInTheDocument();
  });

  it("submits the run, displays exit code + stdout, result has role=status (B2)", async () => {
    vi.mocked(createTerminalExecution).mockResolvedValue({
      executionId: "e1",
      exitCode: 0,
      stdout: "hello\nworld",
      stderr: "",
      durationMs: 12,
      truncated: false,
      timedOut: false,
    });
    render(<TerminalWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /command/i });
    await userEvent.type(screen.getByLabelText(/args/i), "-la");
    await userEvent.click(screen.getByRole("button", { name: /run/i }));
    // uiux-fix F018 C124: the visible badge plus the persistent sr-only live-region
    // mirror both carry "exit 0" — the mirror exists before the result arrives so
    // AT reliably announce it (WCAG 4.1.3).
    const exitTexts = await screen.findAllByText(/exit 0/i);
    expect(exitTexts.length).toBeGreaterThan(0);
    expect(screen.getByText(/hello/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/command finished: exit 0/i);
    expect(createTerminalExecution).toHaveBeenCalledWith({
      projectId: "/proj",
      command: "ls",
      args: ["-la"],
      requestId: "req-own",
    });
  });

  it("surfaces a COMMAND_DENIED error with the code", async () => {
    vi.mocked(createTerminalExecution).mockRejectedValue(
      new ApiError("COMMAND_DENIED", "Command is not in the allowlist.", 403),
    );
    render(<TerminalWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /command/i });
    await userEvent.click(screen.getByRole("button", { name: /run/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("COMMAND_DENIED");
  });

  it("B3 — error alert is dismissible via the Dismiss button", async () => {
    vi.mocked(createTerminalExecution).mockRejectedValue(
      new ApiError("COMMAND_DENIED", "Command is not in the allowlist.", 403),
    );
    render(<TerminalWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /command/i });
    await userEvent.click(screen.getByRole("button", { name: /run/i }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: /dismiss error/i }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("appends SSE events to the recent events list in live order", async () => {
    render(<TerminalWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /command/i });
    await waitFor(() => {
      expect(FakeEventSource.last).not.toBeNull();
    });
    FakeEventSource.last?.dispatch(
      "terminal:execution-started",
      JSON.stringify({
        kind: "execution-started",
        executionId: "e8",
        payload: {
          projectId: "/proj",
          command: "ls",
          argCount: 0,
          startedAt: 1700000000000,
          requestId: "req-1",
        },
      }),
    );
    FakeEventSource.last?.dispatch(
      "terminal:execution-completed",
      JSON.stringify({
        kind: "execution-completed",
        executionId: "e8",
        payload: { exitCode: 0, durationMs: 7, requestId: "req-1" },
      }),
    );
    await waitFor(() => {
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/completed/);
    expect(items[1]).toHaveTextContent(/started/);
  });

  it("closes the EventSource when unmounted", async () => {
    const { unmount } = render(<TerminalWidget />);
    await screen.findByRole("combobox", { name: /command/i });
    await waitFor(() => {
      expect(FakeEventSource.last).not.toBeNull();
    });
    unmount();
    expect(FakeEventSource.last?.closed).toBe(true);
  });

  it("Finding 1 — Cancel becomes enabled after SSE execution-started arrives, triggers abort on click", async () => {
    vi.mocked(createTerminalExecution).mockImplementation(
      () => new Promise<never>(() => undefined), // never resolves — simulates in-flight
    );
    vi.mocked(abortTerminalExecution).mockResolvedValue(undefined);
    render(<TerminalWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /command/i });
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    // Submit — running becomes true, Cancel appears (aria-disabled until started event;
    // uiux-fix F018 C124: aria-disabled keeps the button focusable so focus never drops).
    await userEvent.click(screen.getByRole("button", { name: /run/i }));
    const cancel = await screen.findByRole("button", { name: /cancel/i });
    expect(cancel).toHaveAttribute("aria-disabled", "true");
    // Dispatch the SSE execution-started event — Cancel should become enabled.
    FakeEventSource.last?.dispatch(
      "terminal:execution-started",
      JSON.stringify({
        kind: "execution-started",
        executionId: "exec-abc",
        payload: {
          projectId: "/proj",
          command: "ls",
          argCount: 0,
          startedAt: Date.now(),
          requestId: "req-own",
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /cancel/i })).toHaveAttribute(
        "aria-disabled",
        "false",
      ),
    );
    // Click Cancel — should call abortTerminalExecution with the captured executionId.
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(abortTerminalExecution).toHaveBeenCalledWith("exec-abc");
  });

  it("ignores foreign SSE execution-started events when deciding whether Cancel should enable", async () => {
    vi.mocked(createTerminalExecution).mockImplementation(
      () => new Promise<never>(() => undefined), // never resolves — simulates in-flight
    );
    vi.mocked(abortTerminalExecution).mockResolvedValue(undefined);
    render(<TerminalWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /command/i });
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /run/i }));
    const cancel = await screen.findByRole("button", { name: /cancel/i });
    expect(cancel).toHaveAttribute("aria-disabled", "true");
    FakeEventSource.last?.dispatch(
      "terminal:execution-started",
      JSON.stringify({
        kind: "execution-started",
        executionId: "exec-foreign",
        payload: {
          projectId: "/other-project",
          command: "ls",
          argCount: 0,
          startedAt: Date.now(),
          requestId: "req-foreign",
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /cancel/i })).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    expect(abortTerminalExecution).not.toHaveBeenCalled();
  });

  it("Finding 2 — cwd datalist is populated from fetchTerminalDirectories", async () => {
    vi.mocked(fetchTerminalDirectories).mockResolvedValue({
      path: "/proj",
      parent: null,
      entries: [
        { name: "src", path: "/proj/src" },
        { name: "tests", path: "/proj/tests" },
      ],
      roots: [{ label: "Project root", path: "/proj" }],
    });
    render(<TerminalWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /command/i });
    // Wait for the datalist to be populated.
    await waitFor(() => {
      const datalist = document.getElementById("tm-cwd-suggestions");
      expect(datalist).not.toBeNull();
      expect(datalist?.querySelectorAll("option")).toHaveLength(2);
    });
    const options = document.getElementById("tm-cwd-suggestions")?.querySelectorAll("option");
    expect(options?.[0]?.value).toBe("/proj/src");
    expect(options?.[1]?.value).toBe("/proj/tests");
    // Select an option by updating the cwd input state.
    const cwdInput = screen.getByLabelText(/working directory/i);
    await userEvent.clear(cwdInput);
    await userEvent.type(cwdInput, "/proj/src");
    expect(cwdInput).toHaveValue("/proj/src");
  });
});

// Silence: abortTerminalExecution and fetchTerminalDirectories are imported at the top to ensure
// vi.mock receives a stable shape across the full module surface.
void abortTerminalExecution;
void fetchTerminalDirectories;
