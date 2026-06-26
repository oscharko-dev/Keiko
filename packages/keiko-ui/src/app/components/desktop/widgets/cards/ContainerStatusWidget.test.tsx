// Issue #1388 (ADR-0070) — ContainerStatusWidget tests. Mocks the typed BFF client + EventSource so
// the panel drives through the same paths a real BFF would. Covers: the graceful-degradation
// unavailable state (role=status + remediation hint + NO run control — AC1/AC2), the available
// state (catalog tasks + run control), api errors rendered as a muted code-tagged message that never
// leaks URLs/credentials, and an axe a11y assertion (zero serious/critical).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../lib/api";
import {
  createContainerRun,
  fetchContainerCapability,
  fetchContainerCatalog,
} from "../../../../../lib/container-api";
import type {
  ContainerCapabilityResponse,
  ContainerRunResult,
  ContainerTaskCatalog,
} from "../../../../../lib/types";
import { ContainerStatusWidget } from "./ContainerStatusWidget";

vi.mock("../../../../../lib/container-api", () => ({
  fetchContainerCapability: vi.fn(),
  fetchContainerCatalog: vi.fn(),
  createContainerRun: vi.fn(),
  cancelContainerRun: vi.fn(),
  containerEventsUrl: (): string => "/api/containers/events",
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

const UNAVAILABLE: ContainerCapabilityResponse = {
  schemaVersion: "1",
  generatedAtMs: 1,
  deadlineMs: 4000,
  anyAvailable: false,
  engines: [
    {
      engine: "docker",
      state: "missing",
      unavailableReason: "executable-not-found",
      remediationHint: "Install Docker Desktop or the docker CLI to enable container diagnostics.",
    },
    {
      engine: "podman",
      state: "not-running",
      unavailableReason: "daemon-not-running",
      remediationHint: "Start the podman service.",
    },
  ],
};

const AVAILABLE: ContainerCapabilityResponse = {
  schemaVersion: "1",
  generatedAtMs: 1,
  deadlineMs: 4000,
  anyAvailable: true,
  engines: [{ engine: "docker", state: "available", version: "26.1.0" }],
};

const CATALOG: ContainerTaskCatalog = {
  schemaVersion: "1",
  projectId: "/proj",
  engineAvailable: true,
  tasks: [
    {
      id: "diag:docker-info",
      kind: "diagnostic",
      label: "Engine self-check",
      image: "ghcr.io/keiko/diagnostic@sha256:deadbeef",
      args: ["true"],
      engine: "docker",
    },
  ],
};

const RESULT: ContainerRunResult = {
  schemaVersion: "1",
  runId: "run-1",
  taskId: "diag:docker-info",
  kind: "diagnostic",
  engine: "docker",
  exitCode: 0,
  durationMs: 18,
  truncated: false,
  timedOut: false,
  failureReason: "none",
  stdout: "diagnostic ok",
  stderr: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "req-own") });
  FakeEventSource.last = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ContainerStatusWidget", () => {
  it("renders the structured unavailable state with role=status and the remediation hint, and NO run control (AC1/AC2)", async () => {
    vi.mocked(fetchContainerCapability).mockResolvedValue(UNAVAILABLE);
    render(<ContainerStatusWidget projectPath="/proj" />);

    // The status region is a polite live region (graceful degradation, never an error boundary).
    const statusRegion = await screen.findByRole("status", { name: /container engine status/i });
    expect(statusRegion).toBeInTheDocument();

    // The structured engine-state label + the static remediation hint are both shown.
    expect(await screen.findByText(/not installed/i)).toBeInTheDocument();
    expect(screen.getByText(/engine not running/i)).toBeInTheDocument();
    expect(screen.getByText(/install docker desktop or the docker cli/i)).toBeInTheDocument();

    // AC2: no run control whatsoever when no engine is available.
    expect(screen.queryByRole("button", { name: /run diagnostic/i })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    // The catalog route is never called when no engine is available (it would 503 by contract).
    expect(fetchContainerCatalog).not.toHaveBeenCalled();
  });

  it("renders the available state with the allowlisted catalog tasks and a run control", async () => {
    vi.mocked(fetchContainerCapability).mockResolvedValue(AVAILABLE);
    vi.mocked(fetchContainerCatalog).mockResolvedValue(CATALOG);
    render(<ContainerStatusWidget projectPath="/proj" />);

    expect(await screen.findByText(/available/i)).toBeInTheDocument();
    const select = await screen.findByRole("combobox", { name: /diagnostic task/i });
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run diagnostic/i })).toBeInTheDocument();
  });

  it("runs the selected diagnostic and shows the structured result", async () => {
    vi.mocked(fetchContainerCapability).mockResolvedValue(AVAILABLE);
    vi.mocked(fetchContainerCatalog).mockResolvedValue(CATALOG);
    vi.mocked(createContainerRun).mockResolvedValue(RESULT);
    render(<ContainerStatusWidget projectPath="/proj" />);

    const runButton = await screen.findByRole("button", { name: /run diagnostic/i });
    await waitFor(() => expect(runButton).toHaveAttribute("aria-disabled", "false"));
    await userEvent.click(runButton);

    expect((await screen.findAllByText(/exit 0/i)).length).toBeGreaterThan(0);
    expect(screen.getByText("run run-1")).toBeInTheDocument();
    expect(screen.getByText("task diag:docker-info")).toBeInTheDocument();
    expect(screen.getByText(/diagnostic ok/)).toBeInTheDocument();
    expect(createContainerRun).toHaveBeenCalledWith({
      projectId: "/proj",
      taskId: "diag:docker-info",
      requestId: "req-own",
    });
  });

  it("renders a capability fetch error as a muted, code-tagged message that never leaks a URL", async () => {
    vi.mocked(fetchContainerCapability).mockRejectedValue(
      new ApiError("WORKSPACE_NOT_REGISTERED", "Project is not registered.", 403),
    );
    render(<ContainerStatusWidget projectPath="/proj" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("WORKSPACE_NOT_REGISTERED");
    expect(alert.textContent).toContain("Project is not registered.");
    // The message never carries the same-origin api path or any credential-shaped token.
    expect(alert.textContent).not.toContain("/api/containers");
    expect(alert.textContent).not.toMatch(/https?:\/\//);
  });

  it("still renders the unavailable status panel when the catalog fetch fails", async () => {
    vi.mocked(fetchContainerCapability).mockResolvedValue(AVAILABLE);
    vi.mocked(fetchContainerCatalog).mockRejectedValue(
      new ApiError("CONTAINER_ENGINE_UNAVAILABLE", "Engine vanished.", 503),
    );
    render(<ContainerStatusWidget projectPath="/proj" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("CONTAINER_ENGINE_UNAVAILABLE");
    // The engine status region keeps rendering — the surface is never blocked.
    expect(screen.getByRole("status", { name: /container engine status/i })).toBeInTheDocument();
  });

  it("closes the EventSource when unmounted", async () => {
    vi.mocked(fetchContainerCapability).mockResolvedValue(UNAVAILABLE);
    const { unmount } = render(<ContainerStatusWidget projectPath="/proj" />);
    await screen.findByRole("status", { name: /container engine status/i });
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    unmount();
    expect(FakeEventSource.last?.closed).toBe(true);
  });

  it("has no axe violations in the unavailable state", async () => {
    vi.mocked(fetchContainerCapability).mockResolvedValue(UNAVAILABLE);
    const { container } = render(<ContainerStatusWidget projectPath="/proj" />);
    await screen.findByText(/not installed/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations in the available state with a run control", async () => {
    vi.mocked(fetchContainerCapability).mockResolvedValue(AVAILABLE);
    vi.mocked(fetchContainerCatalog).mockResolvedValue(CATALOG);
    const { container } = render(<ContainerStatusWidget projectPath="/proj" />);
    await screen.findByRole("button", { name: /run diagnostic/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
