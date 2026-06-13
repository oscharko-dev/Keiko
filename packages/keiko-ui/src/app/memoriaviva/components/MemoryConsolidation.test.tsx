import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryConsolidation } from "./MemoryConsolidation";
import type { MemoryConsolidationJobResponse } from "@/lib/memory-api";
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

function completedJob(): MemoryConsolidationJobResponse {
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
          staleFlags: [
            {
              memoryId: memoryId("mem-stale"),
              reason: "aged-out",
              detectedAt: 1_700_000_000_500,
            },
          ],
          reviewItems: [
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
          ],
          clustersInspected: 3,
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
    });
    expect(screen.getByRole("status")).toHaveTextContent("completed");
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
});
