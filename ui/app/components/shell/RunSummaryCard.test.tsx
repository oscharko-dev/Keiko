// Issue #66 — RunSummaryCard tests. Renders every status × kind, verifies link encoding,
// disables links in the unavailable state, and runs jest-axe across all states.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { axe } from "jest-axe";
import * as api from "@/lib/api";
import { ApiError } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";
import { RunSummaryCard } from "./RunSummaryCard";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof api>("@/lib/api");
  return {
    ...actual,
    fetchRunReport: vi.fn(),
    fetchEvidenceManifest: vi.fn(),
    patchChatMessage: vi.fn(),
  };
});

// next/link delegates to <a> in tests; the default mock already does the right thing.
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

interface MessageOverrides {
  workflowStatus?: ChatMessage["workflowStatus"] | undefined;
  workflowId?: string | undefined;
  taskType?: string | undefined;
  shortResult?: string | undefined;
  runId?: string | undefined;
}

function makeMessage(overrides: MessageOverrides = {}): ChatMessage {
  const base: ChatMessage = {
    id: "msg-1",
    chatId: "chat-1",
    role: "system",
    content: "Verify started",
    timestamp: 1,
    runId: "11111111-2222-3333-4444-555555555555",
    workflowStatus: "running",
    taskType: "verify",
  };
  // Build a result object that strips explicit-undefined keys so exactOptionalPropertyTypes is
  // satisfied (a key with the literal value `undefined` is not assignable to an optional field).
  const result = { ...base };
  if ("workflowStatus" in overrides) {
    if (overrides.workflowStatus === undefined) delete result.workflowStatus;
    else result.workflowStatus = overrides.workflowStatus;
  }
  if ("workflowId" in overrides) {
    if (overrides.workflowId === undefined) delete result.workflowId;
    else result.workflowId = overrides.workflowId;
  }
  if ("taskType" in overrides) {
    if (overrides.taskType === undefined) delete result.taskType;
    else result.taskType = overrides.taskType;
  }
  if ("shortResult" in overrides) {
    if (overrides.shortResult === undefined) delete result.shortResult;
    else result.shortResult = overrides.shortResult;
  }
  if ("runId" in overrides) {
    if (overrides.runId === undefined) delete result.runId;
    else result.runId = overrides.runId;
  }
  return result;
}

beforeEach(() => {
  vi.mocked(api.fetchRunReport).mockReset();
  vi.mocked(api.fetchEvidenceManifest).mockReset();
  vi.mocked(api.patchChatMessage).mockReset();
  // Default: pretend the run is still running so the sync hook doesn't PATCH.
  vi.mocked(api.fetchRunReport).mockResolvedValue({ report: { status: "running" } as never });
});

afterEach(() => {
  cleanup();
});

describe("RunSummaryCard — per-status rendering", () => {
  it("renders the running badge with the verify label", () => {
    render(<RunSummaryCard message={makeMessage()} onPatched={vi.fn()} />);
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Verify")).toBeInTheDocument();
  });

  it("renders the completed badge with the unit-tests label", () => {
    render(
      <RunSummaryCard
        message={makeMessage({
          workflowStatus: "completed",
          workflowId: "unit-test-generation",
          taskType: undefined,
          shortResult: "Generated 3 test files; 9 tests proposed.",
        })}
        onPatched={vi.fn()}
      />,
    );
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Generate Tests")).toBeInTheDocument();
    expect(screen.getByText("Generated 3 test files; 9 tests proposed.")).toBeInTheDocument();
  });

  it("renders the failed badge", () => {
    render(
      <RunSummaryCard
        message={makeMessage({ workflowStatus: "failed", shortResult: "Run failed: tsc errors." })}
        onPatched={vi.fn()}
      />,
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Run failed: tsc errors.")).toBeInTheDocument();
  });

  it("renders the cancelled badge", () => {
    render(
      <RunSummaryCard
        message={makeMessage({ workflowStatus: "cancelled", shortResult: "Run cancelled." })}
        onPatched={vi.fn()}
      />,
    );
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("renders pending badge for never-started runs", () => {
    render(
      <RunSummaryCard message={makeMessage({ workflowStatus: "pending" })} onPatched={vi.fn()} />,
    );
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("renders the workflow label for bug-investigation", () => {
    render(
      <RunSummaryCard
        message={makeMessage({
          workflowId: "bug-investigation",
          taskType: undefined,
          workflowStatus: "completed",
        })}
        onPatched={vi.fn()}
      />,
    );
    expect(screen.getByText("Investigate Bug")).toBeInTheDocument();
  });

  it("falls back to 'Workflow run' for unknown kind", () => {
    render(
      <RunSummaryCard
        message={makeMessage({
          workflowId: undefined,
          taskType: undefined,
          workflowStatus: "completed",
        })}
        onPatched={vi.fn()}
      />,
    );
    expect(screen.getByText("Workflow run")).toBeInTheDocument();
  });
});

describe("RunSummaryCard — link hrefs", () => {
  it("links to the canonical run + evidence pages with encoded runId", () => {
    render(<RunSummaryCard message={makeMessage()} onPatched={vi.fn()} />);
    const runLink = screen.getByLabelText("View run details");
    const evidenceLink = screen.getByLabelText("View evidence manifest");
    expect(runLink.getAttribute("href")).toBe(
      "/run?id=11111111-2222-3333-4444-555555555555",
    );
    expect(evidenceLink.getAttribute("href")).toBe(
      "/evidence/detail?id=11111111-2222-3333-4444-555555555555",
    );
  });

  it("encodes a runId that contains URI-special characters", () => {
    render(
      <RunSummaryCard
        message={makeMessage({ runId: "run id/with spaces" })}
        onPatched={vi.fn()}
      />,
    );
    const href = screen.getByLabelText("View run details").getAttribute("href");
    expect(href).toBe("/run?id=run%20id%2Fwith%20spaces");
  });
});

describe("RunSummaryCard — unavailable state", () => {
  it("shows the unavailable hint and disables links when run + evidence are 404", async () => {
    vi.mocked(api.fetchRunReport).mockRejectedValue(new ApiError("NOT_FOUND", "x", 404));
    vi.mocked(api.fetchEvidenceManifest).mockRejectedValue(new ApiError("NOT_FOUND", "x", 404));
    render(<RunSummaryCard message={makeMessage()} onPatched={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Run details no longer available.")).toBeInTheDocument();
    });
    const runLink = screen.getByLabelText("View run details");
    const evidenceLink = screen.getByLabelText("View evidence manifest");
    expect(runLink.getAttribute("aria-disabled")).toBe("true");
    expect(evidenceLink.getAttribute("aria-disabled")).toBe("true");
    expect(runLink.getAttribute("tabindex")).toBe("-1");
  });
});

describe("RunSummaryCard — a11y", () => {
  it.each([
    ["running"] as const,
    ["completed"] as const,
    ["failed"] as const,
    ["cancelled"] as const,
    ["pending"] as const,
  ])("has no axe violations in the %s state", async (status) => {
    const { container } = render(
      <RunSummaryCard
        message={makeMessage({
          workflowStatus: status,
          shortResult: status === "running" ? undefined : "result text",
        })}
        onPatched={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations in the unavailable state", async () => {
    vi.mocked(api.fetchRunReport).mockRejectedValue(new ApiError("NOT_FOUND", "x", 404));
    vi.mocked(api.fetchEvidenceManifest).mockRejectedValue(new ApiError("NOT_FOUND", "x", 404));
    const { container } = render(<RunSummaryCard message={makeMessage()} onPatched={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Run details no longer available.")).toBeInTheDocument();
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
