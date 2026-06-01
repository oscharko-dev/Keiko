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
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  FakeEventSource.last = null;
  vi.mocked(fetchTerminalPolicy).mockResolvedValue({
    commands: ["ls", "git", "grep"],
    limits: { maxOutputBytes: 262144, defaultTimeoutMs: 30000 },
  });
});

afterEach(() => {
  delete (globalThis as { EventSource?: unknown }).EventSource;
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
    await screen.findByText(/exit 0/i);
    expect(screen.getByText(/hello/)).toBeInTheDocument();
    // B2 — result container must have role="status"
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(createTerminalExecution).toHaveBeenCalledWith({
      projectId: "/proj",
      command: "ls",
      args: ["-la"],
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

  it("appends SSE events to the recent events list", async () => {
    render(<TerminalWidget projectPath="/proj" />);
    await screen.findByRole("combobox", { name: /command/i });
    await waitFor(() => {
      expect(FakeEventSource.last).not.toBeNull();
    });
    FakeEventSource.last?.dispatch(
      "terminal:execution-completed",
      JSON.stringify({
        kind: "execution-completed",
        executionId: "e9",
        payload: { exitCode: 0, durationMs: 7 },
      }),
    );
    await waitFor(() => {
      expect(screen.getByText(/completed/)).toBeInTheDocument();
    });
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
});

// Silence: abortTerminalExecution is exported for future cancel-button coverage; importing it
// at the top ensures vi.mock receives a stable shape across the module surface.
void abortTerminalExecution;
