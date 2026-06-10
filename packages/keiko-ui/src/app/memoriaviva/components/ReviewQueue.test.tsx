// Issue #211 — tests for ReviewQueue: empty state, accept/reject, error recovery.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { ReviewQueue } from "./ReviewQueue";
import type { MemoryReviewQueueResponse } from "@/lib/memory-api";
import type { MemoryRecord, MemoryId } from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeId(n: number): MemoryId {
  return `mem-q-${n.toString()}` as MemoryId;
}

function makeProposed(id = makeId(1), body = "Proposed memory"): MemoryRecord {
  return {
    id,
    schemaVersion: "1",
    scope: { kind: "global" },
    type: "preference",
    body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 1_700_000_000_000,
      confidence: 0.8,
      sensitivity: "public",
    },
    validity: { validFrom: 1_700_000_000_000 },
    status: "proposed",
    pinned: false,
    tags: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function makeConflicted(id = makeId(2), body = "Conflicted memory"): MemoryRecord {
  return { ...makeProposed(id, body), status: "conflicted" };
}

function queueWith(records: readonly MemoryRecord[]): () => Promise<MemoryReviewQueueResponse> {
  return vi.fn().mockResolvedValue({ memories: records, total: records.length });
}

const emptyQueue = () => vi.fn().mockResolvedValue({ memories: [], total: 0 });

const acceptOk = () => vi.fn().mockResolvedValue({ memory: makeProposed(makeId(1), "accepted") });
const rejectOk = () => vi.fn().mockResolvedValue({ memory: makeProposed(makeId(1), "rejected") });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReviewQueue — empty state", () => {
  it("shows clear queue message when empty", async () => {
    render(<ReviewQueue fetchQueueImpl={emptyQueue()} />);
    await waitFor(() => {
      expect(screen.getByTestId("review-queue-empty")).toBeInTheDocument();
    });
  });
});

describe("ReviewQueue — populated state", () => {
  it("renders proposed memory with Accept and Reject buttons", async () => {
    const record = makeProposed(makeId(1), "Use camelCase for variables");
    render(
      <ReviewQueue
        fetchQueueImpl={queueWith([record])}
        acceptImpl={acceptOk()}
        rejectImpl={rejectOk()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Use camelCase for variables")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("renders conflicted memory with Reject conflict button (no Accept)", async () => {
    const record = makeConflicted(makeId(3), "Conflicting preference");
    render(
      <ReviewQueue
        fetchQueueImpl={queueWith([record])}
        acceptImpl={acceptOk()}
        rejectImpl={rejectOk()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Conflicting preference")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    // Honest label (uiux-fix F035): the action permanently rejects the
    // conflicted memory — it is not a mere queue dismissal.
    expect(screen.getByRole("button", { name: "Reject conflict" })).toBeInTheDocument();
  });

  it("links each row to the memory detail page", async () => {
    const record = makeProposed(makeId(12), "Linked proposal");
    render(
      <ReviewQueue
        fetchQueueImpl={queueWith([record])}
        acceptImpl={acceptOk()}
        rejectImpl={rejectOk()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "View details" })).toHaveAttribute(
        "href",
        "/memoriaviva/detail?id=mem-q-12",
      );
    });
  });

  it("removes row from queue after Accept", async () => {
    const record = makeProposed(makeId(4), "Memory to accept");
    const user = userEvent.setup();
    render(
      <ReviewQueue
        fetchQueueImpl={queueWith([record])}
        acceptImpl={acceptOk()}
        rejectImpl={rejectOk()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Memory to accept")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      expect(screen.queryByText("Memory to accept")).toBeNull();
    });
  });

  it("removes row from queue after Reject", async () => {
    const record = makeProposed(makeId(5), "Memory to reject");
    const user = userEvent.setup();
    render(
      <ReviewQueue
        fetchQueueImpl={queueWith([record])}
        acceptImpl={acceptOk()}
        rejectImpl={rejectOk()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Memory to reject")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => {
      expect(screen.queryByText("Memory to reject")).toBeNull();
    });
  });

  it("announces the result and moves focus to the next row after an action (uiux-fix F035)", async () => {
    const records = [
      makeProposed(makeId(20), "First in queue"),
      makeProposed(makeId(21), "Second in queue"),
    ];
    const user = userEvent.setup();
    render(
      <ReviewQueue
        fetchQueueImpl={queueWith(records)}
        acceptImpl={acceptOk()}
        rejectImpl={rejectOk()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("First in queue")).toBeInTheDocument();
    });

    const [firstAccept] = screen.getAllByRole("button", { name: "Accept" });
    expect(firstAccept).toBeDefined();
    if (firstAccept === undefined) throw new Error("Expected an Accept button.");
    await user.click(firstAccept);

    await waitFor(() => {
      expect(screen.queryByText("First in queue")).toBeNull();
    });
    // Focus lands on the next row's first action button instead of <body>.
    expect(screen.getByRole("button", { name: "Accept" })).toHaveFocus();
    // The dedicated status region announces the outcome.
    expect(screen.getByText("Memory accepted")).toBeInTheDocument();
  });

  it("moves focus to the heading when the last row is removed (uiux-fix F035)", async () => {
    const record = makeProposed(makeId(22), "Only entry");
    const user = userEvent.setup();
    render(
      <ReviewQueue
        fetchQueueImpl={queueWith([record])}
        acceptImpl={acceptOk()}
        rejectImpl={rejectOk()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Only entry")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      expect(screen.queryByText("Only entry")).toBeNull();
    });
    expect(screen.getByRole("heading", { name: "Review queue" })).toHaveFocus();
  });

  it("shows row-level error when accept fails", async () => {
    const record = makeProposed(makeId(6), "Fail to accept");
    const failAccept = vi.fn().mockRejectedValue(new Error("accept failed"));
    const user = userEvent.setup();
    render(
      <ReviewQueue
        fetchQueueImpl={queueWith([record])}
        acceptImpl={failAccept}
        rejectImpl={rejectOk()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Fail to accept")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/accept failed/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
  });

  it("keeps other rows interactive while one row is busy", async () => {
    let resolveAccept: (() => void) | undefined;
    const slowAccept = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccept = () => resolve({ memory: makeProposed(makeId(7), "accepted") });
        }),
    );
    const records = [
      makeProposed(makeId(7), "First proposal"),
      makeProposed(makeId(8), "Second proposal"),
    ];
    const user = userEvent.setup();
    render(
      <ReviewQueue
        fetchQueueImpl={queueWith(records)}
        acceptImpl={slowAccept}
        rejectImpl={rejectOk()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("First proposal")).toBeInTheDocument();
      expect(screen.getByText("Second proposal")).toBeInTheDocument();
    });

    const acceptButtons = screen.getAllByRole("button", { name: "Accept" });
    expect(acceptButtons).toHaveLength(2);
    const [firstAcceptButton, secondAcceptButton] = acceptButtons;
    expect(firstAcceptButton).toBeDefined();
    expect(secondAcceptButton).toBeDefined();
    if (firstAcceptButton === undefined || secondAcceptButton === undefined) {
      throw new Error("Expected both review queue accept buttons to be rendered.");
    }
    await user.click(firstAcceptButton);
    // aria-disabled (not native disabled) keeps the busy button focusable so
    // keyboard focus is not thrown to <body> mid-action (uiux-fix F005).
    expect(firstAcceptButton).toHaveAttribute("aria-disabled", "true");
    expect(secondAcceptButton).toHaveAttribute("aria-disabled", "false");

    resolveAccept?.();
    await waitFor(() => {
      expect(screen.queryByText("First proposal")).toBeNull();
    });
  });
});

describe("ReviewQueue — load error", () => {
  it("shows alert and retry button when fetch fails", async () => {
    const failFetch = vi.fn().mockRejectedValue(new Error("queue load failed"));
    render(<ReviewQueue fetchQueueImpl={failFetch} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/queue load failed/i)).toBeInTheDocument();
    });
  });
});

describe("ReviewQueue — a11y", () => {
  it("jest-axe: empty queue has no violations", async () => {
    const { container } = render(<ReviewQueue fetchQueueImpl={emptyQueue()} />);
    await waitFor(() => {
      expect(screen.getByTestId("review-queue-empty")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: populated queue has no violations", async () => {
    const records = [
      makeProposed(makeId(10), "Alpha proposal"),
      makeConflicted(makeId(11), "Beta conflict"),
    ];
    const { container } = render(
      <ReviewQueue
        fetchQueueImpl={queueWith(records)}
        acceptImpl={acceptOk()}
        rejectImpl={rejectOk()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Alpha proposal")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
