// Issue #197 — unit tests for the ConnectorGraph component.
// Uses vitest + React Testing Library (jsdom) matching the existing test pattern.
// jest-axe WCAG check at the end per GroundedAnswer.a11y.test.tsx pattern.

import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import type { AnchorHTMLAttributes, ReactNode } from "react";
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

type MockLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  readonly href: string;
  readonly children: ReactNode;
};

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: MockLinkProps) => (
    <a href={href} onClick={(event) => event.preventDefault()} {...props}>
      {children}
    </a>
  ),
}));

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
  it("shows the create-pod call-to-action when there are no pods", async () => {
    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} />);

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });

    // The primary CTA button
    const ctaButton = screen.getByRole("button", {
      name: /create your first Knowledge Pod/i,
    });
    expect(ctaButton).toBeInTheDocument();

    // The permanently-disabled "Connect to existing capsule" placeholder was
    // removed until the feature exists (uiux-fix F032, C149/C227).
    expect(screen.queryByRole("button", { name: /connect to an existing capsule/i })).toBeNull();

    // Header button still present
    expect(screen.getByRole("button", { name: /create a new Knowledge Pod/i })).toBeInTheDocument();
  });

  it("does not render the former pipeline visualization", async () => {
    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} />);

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });

    expect(screen.queryByRole("list", { name: /pipeline nodes/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/connector pipeline diagram/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Files Window")).not.toBeInTheDocument();
    expect(screen.queryByText("Conversation Center")).not.toBeInTheDocument();
  });

  it("opens an in-app create dialog instead of using window.prompt", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt");
    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} />);

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /create your first Knowledge Pod/i }));

    expect(promptSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /create Knowledge Pod/i })).toBeInTheDocument();
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

  it("renders the Knowledge Pod list region with pod count in the status summary", async () => {
    const capsules = [
      makeCapsule({ id: makeCapsuleId("1"), displayName: "A" }),
      makeCapsule({ id: makeCapsuleId("2"), displayName: "B" }),
    ];
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith(capsules)} />);

    await waitFor(() => {
      expect(screen.getByText("A")).toBeInTheDocument();
    });

    expect(screen.getByRole("region", { name: /knowledge pods/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 Knowledge Pods");
  });

  it("exports a capsule drag payload for dropping onto the workspace", async () => {
    const capsule = makeCapsule({ id: makeCapsuleId("drag"), displayName: "First KC" });
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    const row = await screen.findByRole("button", {
      name: "Drag Knowledge Pod First KC to the workspace",
    });
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

    const row = await screen.findByRole("button", {
      name: "Drag Knowledge Pod First KC to the workspace",
    });
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

  it("does not start capsule drag-out from right click or macOS control click", async () => {
    const capsule = makeCapsule({ id: makeCapsuleId("drag-blocked"), displayName: "Blocked KC" });
    const workspace = document.createElement("main");
    workspace.className = "workspace";
    document.body.appendChild(workspace);
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => workspace);
    const dropListener = vi.fn();
    window.addEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    const row = await screen.findByRole("button", {
      name: "Drag Knowledge Pod Blocked KC to the workspace",
    });
    fireEvent.pointerDown(row, { button: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 44 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 140 });
    fireEvent.pointerDown(row, { button: 0, ctrlKey: true, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 44 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 140 });

    expect(dropListener).not.toHaveBeenCalled();

    window.removeEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);
    document.elementFromPoint = originalElementFromPoint;
    workspace.remove();
  });

  it("resets the grabbing cursor and drops window listeners on pointercancel (GEN-PERF-MEMORY-004)", async () => {
    const capsule = makeCapsule({ id: makeCapsuleId("cancel"), displayName: "Cancel KC" });
    const workspace = document.createElement("main");
    workspace.className = "workspace";
    document.body.appendChild(workspace);
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => workspace);
    const dropListener = vi.fn();
    window.addEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);
    const removeSpy = vi.spyOn(window, "removeEventListener");
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    const row = await screen.findByRole("button", {
      name: "Drag Knowledge Pod Cancel KC to the workspace",
    });
    fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
    // Move far enough to enter the dragging state (sets body cursor to grabbing).
    fireEvent.pointerMove(window, { clientX: 60, clientY: 64 });
    expect(document.body.style.cursor).toBe("grabbing");

    // The browser steals the gesture (scroll/zoom/contextmenu): pointercancel must
    // run the same teardown — reset cursor, clear ghost, drop the window listeners —
    // and must NOT emit a drop.
    fireEvent.pointerCancel(window, { clientX: 60, clientY: 64 });
    expect(document.body.style.cursor).toBe("");
    expect(dropListener).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointercancel", expect.any(Function));

    // A stray pointermove after cancel must not resurrect the grabbing cursor
    // (listener was removed).
    fireEvent.pointerMove(window, { clientX: 200, clientY: 200 });
    expect(document.body.style.cursor).toBe("");

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

    const row = await screen.findByRole("button", {
      name: "Drag Knowledge Pod First KC to the workspace",
    });
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

describe("ConnectorGraph — LK-02 keyboard add-to-workspace", () => {
  it("dispatches the connector drop event when 'Add to workspace' is clicked (keyboard path)", async () => {
    const capsule = makeCapsule({ id: makeCapsuleId("kbdrop"), displayName: "KB Capsule" });

    // Set up a fake workspace element so getWorkspaceCenter() finds it
    const workspace = document.createElement("main");
    workspace.className = "workspace";
    // jsdom getBoundingClientRect returns zeros by default; override to a
    // non-zero rect so the button is accepted by the Workspace bounds check.
    workspace.getBoundingClientRect = () =>
      ({
        left: 100,
        right: 900,
        top: 50,
        bottom: 750,
        width: 800,
        height: 700,
        x: 100,
        y: 50,
        toJSON: () => undefined,
      }) as DOMRect;
    document.body.appendChild(workspace);

    const dropListener = vi.fn();
    window.addEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);

    const user = userEvent.setup();
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    await waitFor(() => {
      expect(screen.getByText("KB Capsule")).toBeInTheDocument();
    });

    const addBtn = screen.getByRole("button", {
      name: /add Knowledge Pod KB Capsule to workspace/i,
    });
    await user.click(addBtn);

    expect(dropListener).toHaveBeenCalledTimes(1);
    const event = dropListener.mock.calls[0]?.[0] as CustomEvent<LocalKnowledgeConnectorDropDetail>;
    expect(event.detail.payload).toEqual({
      kind: "capsule",
      id: "cap-kbdrop",
      label: "KB Capsule",
      lifecycleState: "ready",
    });
    // Coordinates should be the workspace center (500, 400)
    expect(event.detail.clientX).toBe(500);
    expect(event.detail.clientY).toBe(400);

    window.removeEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);
    workspace.remove();
  });

  it("does not dispatch the drop event when no workspace element is present", async () => {
    const capsule = makeCapsule({ id: makeCapsuleId("nowspc"), displayName: "No WS Capsule" });

    const dropListener = vi.fn();
    window.addEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);

    const user = userEvent.setup();
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    await waitFor(() => {
      expect(screen.getByText("No WS Capsule")).toBeInTheDocument();
    });

    // No main.workspace in the DOM — click should silently no-op
    const addBtn = screen.getByRole("button", {
      name: /add Knowledge Pod No WS Capsule to workspace/i,
    });
    await user.click(addBtn);

    expect(dropListener).not.toHaveBeenCalled();

    window.removeEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);
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
        screen.getByRole("button", { name: /create a new Knowledge Pod/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /create a new Knowledge Pod/i }));
    await user.type(screen.getByLabelText(/pod display name/i), "  Treasury Docs  ");
    await user.click(screen.getByRole("button", { name: /^create pod$/i }));

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
      name: /start indexing Knowledge Pod index me/i,
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
      name: /start indexing Knowledge Pod empty cap/i,
    });
    expect(indexBtn).not.toBeDisabled();
    expect(indexBtn).toHaveAttribute("aria-disabled", "true");
    expect(indexBtn).toHaveAccessibleDescription("Attach a source before indexing.");
    expect(indexBtn).toHaveAttribute(
      "title",
      "Attach a source before indexing this Knowledge Pod.",
    );

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

    const indexBtn = screen.getByRole("button", {
      name: /start indexing Knowledge Pod slow cap/i,
    });
    await user.click(indexBtn);

    // In flight: the triggered button swaps its label and announces aria-busy
    // (matching the detail page's "Indexing…" pattern).
    expect(indexBtn).toHaveTextContent("Indexing…");
    expect(indexBtn).toHaveAttribute("aria-busy", "true");
    expect(indexBtn).toBeDisabled();

    resolveAction({ ok: true, capsuleId: id });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /start indexing Knowledge Pod slow cap/i }),
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
      name: /cancel indexing for Knowledge Pod running cap/i,
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
      name: /disconnect Knowledge Pod ready cap/i,
    });
    await user.click(disconnectBtn);

    // Row click opens the confirm dialog — nothing is deleted yet (uiux-fix F033, C064).
    expect(disconnectCapsuleImpl).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: /disconnect Knowledge Pod/i });
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

    await user.click(screen.getByRole("button", { name: /disconnect Knowledge Pod keep cap/i }));
    const dialog = screen.getByRole("dialog", { name: /disconnect Knowledge Pod/i });
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(disconnectCapsuleImpl).not.toHaveBeenCalled();
  });

  it("opens capsule details without navigating away when Details is clicked", async () => {
    const id = makeCapsuleId("77");
    const capsule = makeCapsule({ id, displayName: "Health Cap", lifecycleState: "ready" });
    const onOpenCapsule = vi.fn();
    const user = userEvent.setup();

    render(
      <ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} onOpenCapsule={onOpenCapsule} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Health Cap")).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /open details for Knowledge Pod health cap/i }),
    );

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
      const row = screen.getByRole("article", { name: `Knowledge Pod: Cap-${state}` });
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
    expect(
      screen.getByRole("button", { name: /retry loading Knowledge Pods/i }),
    ).toBeInTheDocument();
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
      name: /start indexing Knowledge Pod error cap/i,
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

  it("jest-axe: Knowledge Pod list has no violations", async () => {
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

describe("ConnectorGraph — drag handle keyboard semantics (GEN-UI-KEYBOARD-004 / -INTERACTION-004)", () => {
  it("keeps the pointer-only drag handle out of the Tab order and off the keyboard path", async () => {
    const capsule = makeCapsule({ id: makeCapsuleId("dh"), displayName: "Handle Cap" });
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    const handle = await screen.findByRole("button", {
      name: "Drag Knowledge Pod Handle Cap to the workspace",
    });
    // Removed from the Tab order so it is not a redundant / keyboard-inert stop;
    // the "Add to workspace" button is the keyboard equivalent.
    expect(handle).toHaveAttribute("tabindex", "-1");
    // The keyboard control that actually performs the action is a real button.
    expect(
      screen.getByRole("button", { name: /add Knowledge Pod Handle Cap to workspace/i }),
    ).toBeInTheDocument();
  });
});

describe("ConnectorGraph — CreateCapsuleDialog focus management (test-plan #26)", () => {
  async function openCreateDialog(): Promise<{
    user: ReturnType<typeof userEvent.setup>;
    trigger: HTMLElement;
  }> {
    const user = userEvent.setup();
    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /create a new Knowledge Pod/i }),
      ).toBeInTheDocument();
    });
    const trigger = screen.getByRole("button", { name: /create a new Knowledge Pod/i });
    trigger.focus();
    await user.click(trigger);
    await screen.findByRole("dialog", { name: /create Knowledge Pod/i });
    return { user, trigger };
  }

  it("moves focus into the dialog (the name input) on open", async () => {
    await openCreateDialog();
    expect(document.activeElement).toBe(screen.getByLabelText(/pod display name/i));
  });

  it("traps Tab within the dialog, wrapping last -> first", async () => {
    await openCreateDialog();
    const dialog = screen.getByRole("dialog", { name: /create Knowledge Pod/i });
    const submitBtn = within(dialog).getByRole("button", { name: /^create pod$/i });
    submitBtn.focus();
    // Tab off the last focusable wraps back to the first (the input).
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByLabelText(/pod display name/i));
  });

  it("traps Shift+Tab within the dialog, wrapping first -> last", async () => {
    await openCreateDialog();
    const dialog = screen.getByRole("dialog", { name: /create Knowledge Pod/i });
    const input = within(dialog).getByLabelText(/pod display name/i);
    input.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: /^create pod$/i }),
    );
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const { trigger } = await openCreateDialog();
    const dialog = screen.getByRole("dialog", { name: /create Knowledge Pod/i });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /create Knowledge Pod/i })).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("jest-axe: the create dialog has no violations", async () => {
    await openCreateDialog();
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });
});

describe("ConnectorGraph — DisconnectConfirmDialog focus management (test-plan #27)", () => {
  async function openDisconnectDialog(): Promise<{
    user: ReturnType<typeof userEvent.setup>;
    trigger: HTMLElement;
  }> {
    const capsule = makeCapsule({ id: makeCapsuleId("dc"), displayName: "Ready Cap" });
    const user = userEvent.setup();
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);
    await waitFor(() => {
      expect(screen.getByText("Ready Cap")).toBeInTheDocument();
    });
    const trigger = screen.getByRole("button", { name: /disconnect Knowledge Pod ready cap/i });
    trigger.focus();
    await user.click(trigger);
    await screen.findByRole("dialog", { name: /disconnect Knowledge Pod/i });
    return { user, trigger };
  }

  it("moves focus into the dialog (first focusable) on open", async () => {
    await openDisconnectDialog();
    const dialog = screen.getByRole("dialog", { name: /disconnect Knowledge Pod/i });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: /cancel/i }));
  });

  it("traps Tab within the dialog, wrapping last -> first", async () => {
    await openDisconnectDialog();
    const dialog = screen.getByRole("dialog", { name: /disconnect Knowledge Pod/i });
    const confirmBtn = within(dialog).getByRole("button", { name: /^disconnect$/i });
    confirmBtn.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: /cancel/i }));
  });

  it("traps Shift+Tab within the dialog, wrapping first -> last", async () => {
    await openDisconnectDialog();
    const dialog = screen.getByRole("dialog", { name: /disconnect Knowledge Pod/i });
    const cancelBtn = within(dialog).getByRole("button", { name: /cancel/i });
    cancelBtn.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: /^disconnect$/i }),
    );
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const { trigger } = await openDisconnectDialog();
    const dialog = screen.getByRole("dialog", { name: /disconnect Knowledge Pod/i });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /disconnect Knowledge Pod/i })).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("jest-axe: the disconnect dialog has no violations", async () => {
    await openDisconnectDialog();
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });
});
