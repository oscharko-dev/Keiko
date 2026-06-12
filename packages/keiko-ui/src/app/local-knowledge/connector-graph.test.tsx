// Issue #197 — unit tests for the ConnectorGraph component.
// Uses vitest + React Testing Library (jsdom) matching the existing test pattern.
// jest-axe WCAG check at the end per GroundedAnswer.a11y.test.tsx pattern.

import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorGraph } from "./connector-graph";
import {
  LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT,
  LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
  type LocalKnowledgeConnectorDropDetail,
} from "./connector-drag";
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

    // The permanently-disabled "Connect to existing capsule" placeholder was
    // removed until the feature exists (uiux-fix F032, C149/C227).
    expect(screen.queryByRole("button", { name: /connect to an existing capsule/i })).toBeNull();

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

  it("opens an in-app create dialog instead of using window.prompt", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt");
    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} />);

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /create your first knowledge capsule/i }));

    expect(promptSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /create capsule/i })).toBeInTheDocument();
    promptSpy.mockRestore();
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

  it("exports a capsule drag payload for dropping onto the workspace", async () => {
    const capsule = makeCapsule({ id: makeCapsuleId("drag"), displayName: "First KC" });
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    const row = await screen.findByRole("button", { name: "Drag capsule First KC to workspace" });
    const dataTransfer = {
      effectAllowed: "none",
      setData: vi.fn(),
    };

    fireEvent.dragStart(row, { dataTransfer });

    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
      JSON.stringify({
        kind: "capsule",
        id: "cap-drag",
        label: "First KC",
        lifecycleState: "ready",
      }),
    );
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "First KC");
  });

  it("dispatches a connector drop event when the capsule row is dragged out to the workspace", async () => {
    const capsule = makeCapsule({ id: makeCapsuleId("drag-out"), displayName: "First KC" });
    const workspace = document.createElement("main");
    workspace.className = "workspace";
    document.body.appendChild(workspace);
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => workspace);
    const dropListener = vi.fn((event: Event) => {
      expect(event).toBeInstanceOf(CustomEvent);
    });
    window.addEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    const row = await screen.findByRole("button", { name: "Drag capsule First KC to workspace" });
    fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 44 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 140 });

    expect(dropListener).toHaveBeenCalledTimes(1);
    const event = dropListener.mock.calls[0]?.[0] as CustomEvent<LocalKnowledgeConnectorDropDetail>;
    expect(event.detail).toEqual({
      payload: {
        kind: "capsule",
        id: "cap-drag-out",
        label: "First KC",
        lifecycleState: "ready",
      },
      clientX: 120,
      clientY: 140,
    });

    window.removeEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);
    document.elementFromPoint = originalElementFromPoint;
    workspace.remove();
  });

  it("dispatches the same connector drop event from native dragend on the workspace", async () => {
    const capsule = makeCapsule({ id: makeCapsuleId("native"), displayName: "First KC" });
    const workspace = document.createElement("main");
    workspace.className = "workspace";
    document.body.appendChild(workspace);
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => workspace);
    const dropListener = vi.fn();
    window.addEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    const row = await screen.findByRole("button", { name: "Drag capsule First KC to workspace" });
    const dragEnd = createEvent.dragEnd(row);
    Object.defineProperties(dragEnd, {
      clientX: { value: 240 },
      clientY: { value: 260 },
    });
    fireEvent(row, dragEnd);

    expect(dropListener).toHaveBeenCalledTimes(1);
    const event = dropListener.mock.calls[0]?.[0] as CustomEvent<LocalKnowledgeConnectorDropDetail>;
    expect(event.detail.payload).toEqual({
      kind: "capsule",
      id: "cap-native",
      label: "First KC",
      lifecycleState: "ready",
    });
    expect(event.detail.clientX).toBe(240);
    expect(event.detail.clientY).toBe(260);

    window.removeEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);
    document.elementFromPoint = originalElementFromPoint;
    workspace.remove();
  });
});

describe("ConnectorGraph — action buttons fire correct fetch calls", () => {
  it("submits a trimmed display name from the create dialog", async () => {
    const createCapsuleImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, capsuleId: makeCapsuleId("create") });
    const user = userEvent.setup();

    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} createCapsuleImpl={createCapsuleImpl} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /create a new knowledge capsule/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /create a new knowledge capsule/i }));
    await user.type(screen.getByLabelText(/capsule display name/i), "  Treasury Docs  ");
    await user.click(screen.getByRole("button", { name: /^create capsule$/i }));

    await waitFor(() => {
      expect(createCapsuleImpl).toHaveBeenCalledWith({ displayName: "Treasury Docs" });
    });
  });

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

  it("disables indexing for capsules without attached sources", async () => {
    const id = makeCapsuleId("empty");
    const capsule = makeCapsule({
      id,
      displayName: "Empty Cap",
      lifecycleState: "draft",
      sourceCount: 0,
    });
    const startIndexingImpl = vi.fn().mockImplementation(() => okAction(id));

    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([capsule])}
        startIndexingImpl={startIndexingImpl}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Empty Cap")).toBeInTheDocument();
    });

    const indexBtn = screen.getByRole("button", {
      name: /start indexing capsule empty cap/i,
    });
    expect(indexBtn).not.toBeDisabled();
    expect(indexBtn).toHaveAttribute("aria-disabled", "true");
    expect(indexBtn).toHaveAccessibleDescription("Attach a source before indexing.");
    expect(indexBtn).toHaveAttribute("title", "Attach a source before indexing this capsule.");

    await userEvent.setup().click(indexBtn);
    expect(startIndexingImpl).not.toHaveBeenCalled();
  });

  it("shows busy feedback on the triggered row button while the action is in flight (uiux-fix F048, C233)", async () => {
    const id = makeCapsuleId("43");
    const capsule = makeCapsule({ id, displayName: "Slow Cap", lifecycleState: "draft" });
    let resolveAction: (value: CapsuleActionResponse) => void = () => undefined;
    const startIndexingImpl = vi.fn().mockImplementation(
      () =>
        new Promise<CapsuleActionResponse>((resolve) => {
          resolveAction = resolve;
        }),
    );
    const user = userEvent.setup();

    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([capsule])}
        startIndexingImpl={startIndexingImpl}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Slow Cap")).toBeInTheDocument();
    });

    const indexBtn = screen.getByRole("button", { name: /start indexing capsule slow cap/i });
    await user.click(indexBtn);

    // In flight: the triggered button swaps its label and announces aria-busy
    // (matching the detail page's "Indexing…" pattern).
    expect(indexBtn).toHaveTextContent("Indexing…");
    expect(indexBtn).toHaveAttribute("aria-busy", "true");
    expect(indexBtn).toBeDisabled();

    resolveAction({ ok: true, capsuleId: id });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /start indexing capsule slow cap/i }),
      ).toHaveTextContent(/^Index$/);
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

  it("asks for confirmation before calling disconnectCapsule (destructive, no undo)", async () => {
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

    // Row click opens the confirm dialog — nothing is deleted yet (uiux-fix F033, C064).
    expect(disconnectCapsuleImpl).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: /disconnect capsule/i });
    expect(dialog.textContent).toContain("Ready Cap");

    await user.click(within(dialog).getByRole("button", { name: /^disconnect$/i }));

    await waitFor(() => {
      expect(disconnectCapsuleImpl).toHaveBeenCalledWith(id);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does NOT call disconnectCapsule when the confirmation is cancelled", async () => {
    const id = makeCapsuleId("56");
    const capsule = makeCapsule({ id, displayName: "Keep Cap", lifecycleState: "ready" });
    const disconnectCapsuleImpl = vi.fn().mockImplementation(() => okAction(id));
    const user = userEvent.setup();

    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([capsule])}
        disconnectCapsuleImpl={disconnectCapsuleImpl}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Keep Cap")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /disconnect capsule keep cap/i }));
    const dialog = screen.getByRole("dialog", { name: /disconnect capsule/i });
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(disconnectCapsuleImpl).not.toHaveBeenCalled();
  });

  it("opens capsule details without navigating away when Details is clicked", async () => {
    const id = makeCapsuleId("77");
    const capsule = makeCapsule({ id, displayName: "Health Cap", lifecycleState: "ready" });
    const onOpenCapsule = vi.fn();
    const user = userEvent.setup();

    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} onOpenCapsule={onOpenCapsule} />);

    await waitFor(() => {
      expect(screen.getByText("Health Cap")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /open details for capsule health cap/i }));

    expect(onOpenCapsule).toHaveBeenCalledWith(id);
    expect(pushMock).not.toHaveBeenCalled();
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

      // Static badge text — no per-row live region: every aria-live badge made
      // screen readers re-announce the whole list on reload (uiux-fix F032, C226).
      const row = screen.getByRole("article", { name: `Capsule: Cap-${state}` });
      const badge = within(row).getByText(expectedLabel);
      expect(badge).toHaveClass("lk-badge");
      expect(badge).not.toHaveAttribute("aria-live");
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
