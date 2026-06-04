// Issue #197 — unit tests for the ConnectorGraph component.
// Uses vitest + React Testing Library (jsdom) matching the existing test pattern.
// jest-axe WCAG check at the end per GroundedAnswer.a11y.test.tsx pattern.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorGraph } from "./connector-graph";
import type {
  CapsulesResponse,
  CapsuleActionResponse,
  CapsuleListEntry,
} from "@/lib/local-knowledge-api";
import type { KnowledgeCapsuleId, CapsuleLifecycleState } from "@oscharko-dev/keiko-contracts";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

beforeEach(() => {
  pushMock.mockReset();
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCapsuleId(suffix: string): KnowledgeCapsuleId {
  return `cap-${suffix}` as KnowledgeCapsuleId;
}

function makeCapsule(overrides: Partial<CapsuleListEntry> = {}): CapsuleListEntry {
  return {
    id: makeCapsuleId("1"),
    displayName: "My Capsule",
    lifecycleState: "ready",
    sourceCount: 2,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

function okAction(capsuleId: KnowledgeCapsuleId): Promise<CapsuleActionResponse> {
  return Promise.resolve({ ok: true, capsuleId });
}

// Default injectable stubs
function emptyFetch(): Promise<CapsulesResponse> {
  return Promise.resolve({ capsules: [] });
}

function fetchWith(capsules: readonly CapsuleListEntry[]): () => Promise<CapsulesResponse> {
  return () => Promise.resolve({ capsules });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConnectorGraph — empty state", () => {
  it("shows the create-capsule call-to-action when there are no capsules", async () => {
    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} />);

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });

    // The primary CTA button
    const ctaButton = screen.getByRole("button", {
      name: /create your first knowledge capsule/i,
    });
    expect(ctaButton).toBeInTheDocument();

    // Secondary CTA
    expect(
      screen.getByRole("button", { name: /connect to an existing capsule/i }),
    ).toBeInTheDocument();

    // Header button still present
    expect(
      screen.getByRole("button", { name: /create a new knowledge capsule/i }),
    ).toBeInTheDocument();
  });

  it("renders pipeline node labels in source-to-consumer order", async () => {
    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} />);

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });

    const nodeList = screen.getByRole("list", { name: /pipeline nodes/i });
    const items = nodeList.querySelectorAll('[role="listitem"]');
    expect(items).toHaveLength(4);

    // Labels appear in order: Files Window, Local Knowledge, Capsules, Conversation Center
    const labels = Array.from(items).map((el) => el.textContent ?? "");
    expect(labels[0]).toContain("Files Window");
    expect(labels[1]).toContain("Local Knowledge");
    expect(labels[2]).toContain("Capsules");
    expect(labels[3]).toContain("Conversation Center");
  });
});

describe("ConnectorGraph — with capsules", () => {
  it("renders one row per capsule with the correct display name", async () => {
    const capsules = [
      makeCapsule({ id: makeCapsuleId("1"), displayName: "Alpha Docs" }),
      makeCapsule({ id: makeCapsuleId("2"), displayName: "Beta Notes", lifecycleState: "stale" }),
    ];
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith(capsules)} />);

    await waitFor(() => {
      expect(screen.getByText("Alpha Docs")).toBeInTheDocument();
    });
    expect(screen.getByText("Beta Notes")).toBeInTheDocument();
  });

  it("does NOT render the empty-state panel when capsules are present", async () => {
    const capsules = [makeCapsule()];
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith(capsules)} />);

    await waitFor(() => {
      expect(screen.getByText("My Capsule")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("renders capsules list region with capsule count in pipeline node sublabel", async () => {
    const capsules = [
      makeCapsule({ id: makeCapsuleId("1"), displayName: "A" }),
      makeCapsule({ id: makeCapsuleId("2"), displayName: "B" }),
    ];
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith(capsules)} />);

    await waitFor(() => {
      expect(screen.getByText("A")).toBeInTheDocument();
    });

    // The pipeline Capsules node sublabel should reflect the count
    const nodeList = screen.getByRole("list", { name: /pipeline nodes/i });
    expect(nodeList.textContent).toContain("2 capsules");
  });
});

describe("ConnectorGraph — action buttons fire correct fetch calls", () => {
  it("calls startIndexing with the right capsule ID when Index is clicked", async () => {
    const id = makeCapsuleId("42");
    const capsule = makeCapsule({ id, displayName: "Index Me", lifecycleState: "draft" });
    const startIndexingImpl = vi.fn().mockImplementation(() => okAction(id));
    const user = userEvent.setup();

    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([capsule])}
        startIndexingImpl={startIndexingImpl}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Index Me")).toBeInTheDocument();
    });

    const indexBtn = screen.getByRole("button", {
      name: /start indexing capsule index me/i,
    });
    await user.click(indexBtn);

    await waitFor(() => {
      expect(startIndexingImpl).toHaveBeenCalledWith(id);
    });
  });

  it("calls cancelIndexing with the right capsule ID when Cancel is clicked", async () => {
    const id = makeCapsuleId("99");
    const capsule = makeCapsule({ id, displayName: "Running Cap", lifecycleState: "indexing" });
    const cancelIndexingImpl = vi.fn().mockImplementation(() => okAction(id));
    const user = userEvent.setup();

    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([capsule])}
        cancelIndexingImpl={cancelIndexingImpl}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Running Cap")).toBeInTheDocument();
    });

    const cancelBtn = screen.getByRole("button", {
      name: /cancel indexing for capsule running cap/i,
    });
    await user.click(cancelBtn);

    await waitFor(() => {
      expect(cancelIndexingImpl).toHaveBeenCalledWith(id);
    });
  });

  it("calls disconnectCapsule when Disconnect is clicked", async () => {
    const id = makeCapsuleId("55");
    const capsule = makeCapsule({ id, displayName: "Ready Cap", lifecycleState: "ready" });
    const disconnectCapsuleImpl = vi.fn().mockImplementation(() => okAction(id));
    const user = userEvent.setup();

    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([capsule])}
        disconnectCapsuleImpl={disconnectCapsuleImpl}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Ready Cap")).toBeInTheDocument();
    });

    const disconnectBtn = screen.getByRole("button", {
      name: /disconnect capsule ready cap/i,
    });
    await user.click(disconnectBtn);

    await waitFor(() => {
      expect(disconnectCapsuleImpl).toHaveBeenCalledWith(id);
    });
  });

  it("navigates to the capsule health view when Health is clicked", async () => {
    const id = makeCapsuleId("77");
    const capsule = makeCapsule({ id, displayName: "Health Cap", lifecycleState: "ready" });
    const user = userEvent.setup();

    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    await waitFor(() => {
      expect(screen.getByText("Health Cap")).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /open health view for capsule health cap/i }),
    );

    expect(pushMock).toHaveBeenCalledWith("/local-knowledge/capsule?capsuleId=cap-77");
  });
});

describe("ConnectorGraph — status badges", () => {
  const stateCases: Array<{ state: CapsuleLifecycleState; expectedLabel: string }> = [
    { state: "draft", expectedLabel: "Draft" },
    { state: "indexing", expectedLabel: "Indexing" },
    { state: "ready", expectedLabel: "Indexed" },
    { state: "stale", expectedLabel: "Stale" },
    { state: "deleting", expectedLabel: "Deleting" },
    { state: "error", expectedLabel: "Failed" },
  ];

  for (const { state, expectedLabel } of stateCases) {
    it(`renders "${expectedLabel}" badge for lifecycle state "${state}"`, async () => {
      const capsule = makeCapsule({ lifecycleState: state, displayName: `Cap-${state}` });
      render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

      await waitFor(() => {
        expect(screen.getByText(`Cap-${state}`)).toBeInTheDocument();
      });

      // The status badge with role="status" should contain the expected label
      const badge = screen.getByRole("status", {
        name: new RegExp(`Status: ${expectedLabel}`, "i"),
      });
      expect(badge).toBeInTheDocument();
      expect(badge.textContent).toBe(expectedLabel);
    });
  }
});

describe("ConnectorGraph — error states", () => {
  it("renders an alert when fetchCapsules rejects", async () => {
    const fetchCapsulesImpl = vi.fn().mockRejectedValue(new Error("network error"));

    render(<ConnectorGraph fetchCapsulesImpl={fetchCapsulesImpl} />);

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("network error");
    });

    // Retry button is reachable
    expect(screen.getByRole("button", { name: /retry loading capsules/i })).toBeInTheDocument();
  });

  it("renders an alert when an action rejects", async () => {
    const id = makeCapsuleId("err");
    const capsule = makeCapsule({ id, displayName: "Error Cap", lifecycleState: "draft" });
    const startIndexingImpl = vi.fn().mockRejectedValue(new Error("index failed"));
    const user = userEvent.setup();

    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([capsule])}
        startIndexingImpl={startIndexingImpl}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Error Cap")).toBeInTheDocument();
    });

    const indexBtn = screen.getByRole("button", {
      name: /start indexing capsule error cap/i,
    });
    await user.click(indexBtn);

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      const hasError = alerts.some((el) => el.textContent?.includes("index failed") === true);
      expect(hasError).toBe(true);
    });
  });
});

describe("ConnectorGraph — a11y", () => {
  it("jest-axe: empty state has no violations", async () => {
    const { container } = render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} />);
    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: capsule list has no violations", async () => {
    const capsules = [
      makeCapsule({ id: makeCapsuleId("1"), displayName: "A Doc", lifecycleState: "ready" }),
      makeCapsule({ id: makeCapsuleId("2"), displayName: "B Doc", lifecycleState: "indexing" }),
      makeCapsule({ id: makeCapsuleId("3"), displayName: "C Doc", lifecycleState: "stale" }),
      makeCapsule({ id: makeCapsuleId("4"), displayName: "D Doc", lifecycleState: "error" }),
    ];
    const { container } = render(<ConnectorGraph fetchCapsulesImpl={fetchWith(capsules)} />);
    await waitFor(() => {
      expect(screen.getByText("A Doc")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
