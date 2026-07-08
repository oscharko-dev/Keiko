import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryConsolidation } from "./MemoryConsolidation";
import type {
  MemoryConsolidationJobResponse,
  MemoryConsolidationReviewItem,
} from "@/lib/memory-api";
import type { MemoryEdge, MemoryId } from "@oscharko-dev/keiko-contracts";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function memoryId(value: string): MemoryId {
  return value as MemoryId;
}

function edge(overrides: Partial<MemoryEdge> = {}): MemoryEdge {
  return {
    id: "edge-1" as MemoryEdge["id"],
    schemaVersion: "1",
    fromMemoryId: memoryId("mem-a"),
    toMemoryId: memoryId("mem-b"),
    kind: "derived-from",
    createdAt: 1_700_000_000_000,
    provenanceSummary: "consolidation: near-duplicate",
    ...overrides,
  };
}

function runningJob(): MemoryConsolidationJobResponse {
  return {
    job: {
      job: {
        id: "job-1",
        state: "running",
        startedAt: 1_700_000_000_000,
      },
      createdAt: 1_700_000_000_000,
      selection: { scopes: [{ kind: "global" }], includeExpired: false },
      settings: {
        jaccardThreshold: 0.85,
        staleConfidenceThreshold: 0.3,
        maxAgeMs: 7_776_000_000,
        maxClustersPerRun: 100,
        maxRecordsPerRun: 1_000,
      },
      memoryCount: 2,
      cancelRequested: false,
    },
  };
}

function defaultReviewItems(): readonly MemoryConsolidationReviewItem[] {
  return [
    {
      id: "rv-1",
      reason: "potential-conflict",
      relatedMemoryIds: [memoryId("mem-old"), memoryId("mem-new")],
      proposedAction: {
        kind: "supersede",
        older: memoryId("mem-old"),
        newer: memoryId("mem-new"),
      },
      detectedAt: 1_700_000_000_500,
    },
  ];
}

// `reviewItemsOverride` lets Issue #2130 tests exercise a `suggestedResolution`-bearing item
// without duplicating this whole fixture; every other caller keeps the original single item.
function completedJob(
  reviewItemsOverride?: readonly MemoryConsolidationReviewItem[],
): MemoryConsolidationJobResponse {
  return {
    job: {
      job: {
        id: "job-1",
        state: "completed",
        startedAt: 1_700_000_000_000,
        completedAt: 1_700_000_000_500,
        result: {
          state: "completed",
          edgesProposed: [edge()],
          updatesProposed: [],
          summaryStatus: {
            kind: "not-configured",
            updatesProposed: 0,
            skippedMergeClusters: 0,
            fallbacksUsed: 0,
          },
          staleFlags: [
            {
              memoryId: memoryId("mem-stale"),
              reason: "aged-out",
              detectedAt: 1_700_000_000_500,
            },
          ],
          reviewItems: reviewItemsOverride ?? defaultReviewItems(),
          clustersInspected: 3,
          conflictPairsDetected: 1,
          recordsInspected: 2,
          truncated: false,
          elapsedMs: 250,
        },
      },
      createdAt: 1_700_000_000_000,
      selection: { scopes: [{ kind: "global" }], includeExpired: false },
      settings: {
        jaccardThreshold: 0.85,
        staleConfidenceThreshold: 0.3,
        maxAgeMs: 7_776_000_000,
        maxClustersPerRun: 100,
        maxRecordsPerRun: 1_000,
      },
      memoryCount: 2,
      cancelRequested: false,
    },
  };
}

describe("MemoryConsolidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the initial empty job state", () => {
    render(
      <MemoryConsolidation startJobImpl={vi.fn()} fetchJobImpl={vi.fn()} cancelJobImpl={vi.fn()} />,
    );

    expect(screen.getByText("No consolidation job started yet.")).toBeInTheDocument();
  });

  it("steps numeric settings on wheel hover without focusing first", () => {
    render(
      <MemoryConsolidation startJobImpl={vi.fn()} fetchJobImpl={vi.fn()} cancelJobImpl={vi.fn()} />,
    );

    const maxAgeInput = screen.getByRole("spinbutton", { name: /max age \(days\)/i });
    expect(maxAgeInput).not.toHaveFocus();

    fireEvent.wheel(maxAgeInput, { deltaY: -100 });
    expect(maxAgeInput).toHaveValue(91);
    expect(maxAgeInput).not.toHaveFocus();

    fireEvent.wheel(maxAgeInput, { deltaY: 100 });
    expect(maxAgeInput).toHaveValue(90);

    fireEvent.click(screen.getByRole("button", { name: "Increase max age (days)" }));
    expect(maxAgeInput).toHaveValue(91);

    fireEvent.click(screen.getByRole("button", { name: "Decrease max age (days)" }));
    expect(maxAgeInput).toHaveValue(90);
  });

  it("starts a job with explicit settings and renders polled results", async () => {
    const startJobImpl = vi.fn().mockResolvedValue(runningJob());
    const fetchJobImpl = vi.fn().mockResolvedValue(completedJob());
    const cancelJobImpl = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryConsolidation
        startJobImpl={startJobImpl}
        fetchJobImpl={fetchJobImpl}
        cancelJobImpl={cancelJobImpl}
        pollIntervalMs={5}
      />,
    );

    await user.click(screen.getByRole("button", { name: /start consolidation/i }));

    expect(startJobImpl).toHaveBeenCalledWith({
      jaccardThreshold: 0.85,
      staleConfidenceThreshold: 0.3,
      maxAgeMs: 7_776_000_000,
      maxClustersPerRun: 100,
      maxRecordsPerRun: 1_000,
    });

    await waitFor(() => {
      expect(fetchJobImpl).toHaveBeenCalledWith("job-1");
    });
    await waitFor(() => {
      expect(screen.getByText(/potential conflict/i)).toBeInTheDocument();
      expect(screen.getByText(/mem-stale/i)).toBeInTheDocument();
      expect(screen.getByText(/derived-from/i)).toBeInTheDocument();
      expect(screen.getByText(/summaries were not configured/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Consolidation job status")).not.toHaveAttribute("aria-live");
    expect(screen.getByRole("status")).toHaveTextContent("completed");
  });

  it("announces the results section politely when results arrive (MV-03)", async () => {
    const startJobImpl = vi.fn().mockResolvedValue(runningJob());
    const fetchJobImpl = vi.fn().mockResolvedValue(completedJob());
    const cancelJobImpl = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryConsolidation
        startJobImpl={startJobImpl}
        fetchJobImpl={fetchJobImpl}
        cancelJobImpl={cancelJobImpl}
        pollIntervalMs={5}
      />,
    );

    await user.click(screen.getByRole("button", { name: /start consolidation/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Consolidation results")).toHaveAttribute("aria-live", "polite");
    });
  });

  it("resolves a proposed supersede conflict through the conflict-resolution route", async () => {
    const startJobImpl = vi.fn().mockResolvedValue(runningJob());
    const fetchJobImpl = vi.fn().mockResolvedValue(completedJob());
    const cancelJobImpl = vi.fn();
    const resolveConflictImpl = vi.fn().mockResolvedValue({
      resolved: true,
      winner: memoryId("mem-new"),
      losers: [memoryId("mem-old")],
      supersessionEdgeIds: ["edge-1"],
      transitions: [],
    });
    const user = userEvent.setup();

    render(
      <MemoryConsolidation
        startJobImpl={startJobImpl}
        fetchJobImpl={fetchJobImpl}
        cancelJobImpl={cancelJobImpl}
        resolveConflictImpl={resolveConflictImpl}
        pollIntervalMs={5}
      />,
    );

    await user.click(screen.getByRole("button", { name: /start consolidation/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /resolve conflict/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /resolve conflict/i }));

    await waitFor(() => {
      expect(resolveConflictImpl).toHaveBeenCalledWith({
        winner: memoryId("mem-new"),
        losers: [memoryId("mem-old")],
        reason: "resolved from consolidation review item rv-1",
      });
      expect(screen.queryByText(/potential conflict/i)).not.toBeInTheDocument();
      expect(screen.getByText(/no review items returned/i)).toBeInTheDocument();
    });
  });

  it("cancels an active job", async () => {
    const startJobImpl = vi.fn().mockResolvedValue(runningJob());
    const fetchJobImpl = vi.fn();
    const cancelJobImpl = vi.fn().mockResolvedValue({
      job: {
        job: {
          id: "job-1",
          state: "canceled",
          startedAt: 1_700_000_000_000,
          completedAt: 1_700_000_000_100,
        },
        createdAt: 1_700_000_000_000,
        selection: { scopes: [{ kind: "global" }], includeExpired: false },
        settings: {
          jaccardThreshold: 0.85,
          staleConfidenceThreshold: 0.3,
          maxAgeMs: 7_776_000_000,
          maxClustersPerRun: 100,
          maxRecordsPerRun: 1_000,
        },
        memoryCount: 2,
        cancelRequested: true,
      },
    } satisfies MemoryConsolidationJobResponse);
    const user = userEvent.setup();

    render(
      <MemoryConsolidation
        startJobImpl={startJobImpl}
        fetchJobImpl={fetchJobImpl}
        cancelJobImpl={cancelJobImpl}
      />,
    );

    await user.click(screen.getByRole("button", { name: /start consolidation/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel job/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel job/i }));

    await waitFor(() => {
      expect(cancelJobImpl).toHaveBeenCalledWith("job-1");
      expect(screen.getByRole("status")).toHaveTextContent("canceled");
    });
  });

  // Issue #2130 / ADR-0120 — advisory suggestion is off by default (byte-identical, AC1) and,
  // when present, renders distinct from and never pre-selecting the resolve control (AC2).
  it("renders no advisory annotation when suggestedResolution is absent (flag off / AC1)", async () => {
    const startJobImpl = vi.fn().mockResolvedValue(runningJob());
    const fetchJobImpl = vi.fn().mockResolvedValue(completedJob());
    const user = userEvent.setup();

    render(
      <MemoryConsolidation
        startJobImpl={startJobImpl}
        fetchJobImpl={fetchJobImpl}
        cancelJobImpl={vi.fn()}
        pollIntervalMs={5}
      />,
    );

    await user.click(screen.getByRole("button", { name: /start consolidation/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /resolve conflict/i })).toBeInTheDocument();
    });
    expect(screen.queryByText("AI-generated suggestion:")).not.toBeInTheDocument();
  });

  it("renders the recommended id and rationale distinctly from the resolve control (AC2)", async () => {
    const suggestedItem: MemoryConsolidationReviewItem = {
      ...defaultReviewItems()[0]!,
      suggestedResolution: {
        recommendedWinnerId: memoryId("mem-new"),
        rationale: "The newer record corrects an outdated region value.",
      },
    };
    const startJobImpl = vi.fn().mockResolvedValue(runningJob());
    const fetchJobImpl = vi.fn().mockResolvedValue(completedJob([suggestedItem]));
    const user = userEvent.setup();

    render(
      <MemoryConsolidation
        startJobImpl={startJobImpl}
        fetchJobImpl={fetchJobImpl}
        cancelJobImpl={vi.fn()}
        pollIntervalMs={5}
      />,
    );

    await user.click(screen.getByRole("button", { name: /start consolidation/i }));

    expect(await screen.findByText("AI-generated suggestion:")).toBeInTheDocument();
    expect(
      screen.getByText(/The newer record corrects an outdated region value\./),
    ).toBeInTheDocument();
    // The suggestion never pre-selects: the reviewer's own resolve control is still present
    // and requires its own explicit click (unaffected by the annotation above it).
    const resolveButton = screen.getByRole("button", { name: /resolve conflict/i });
    expect(resolveButton).toBeInTheDocument();
    expect(resolveButton).not.toHaveAttribute("aria-disabled", "true");
  });
});
