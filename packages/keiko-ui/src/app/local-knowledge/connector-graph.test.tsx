// Issue #197 — unit tests for the ConnectorGraph component.
// Uses vitest + React Testing Library (jsdom) matching the existing test pattern.
// jest-axe WCAG check at the end per GroundedAnswer.a11y.test.tsx pattern.

import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorGraph } from "./connector-graph";
import {
  LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT,
  LOCAL_KNOWLEDGE_CONNECTOR_DRAG_TYPE,
  type LocalKnowledgeConnectorDropDetail,
} from "./connector-drag";
import type {
  CapsulesResponse,
  CapsuleSetsResponse,
  CapsuleActionResponse,
  CapsuleSetActionResponse,
  CapsuleListEntry,
  CapsuleSetListEntry,
} from "@/lib/local-knowledge-api";
import type {
  CapsuleSetId,
  KnowledgeCapsuleId,
  CapsuleLifecycleState,
} from "@oscharko-dev/keiko-contracts";
import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";

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

afterEach(() => {
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCapsuleId(suffix: string): KnowledgeCapsuleId {
  return `cap-${suffix}` as KnowledgeCapsuleId;
}

function makeCapsuleSetId(suffix: string): CapsuleSetId {
  return `set-${suffix}` as CapsuleSetId;
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

function makeCapsuleSet(overrides: Partial<CapsuleSetListEntry> = {}): CapsuleSetListEntry {
  return {
    id: makeCapsuleSetId("1"),
    displayName: "Release Set",
    capsuleCount: 2,
    composedAt: 1_000_001,
    ...overrides,
  };
}

function okAction(capsuleId: KnowledgeCapsuleId): Promise<CapsuleActionResponse> {
  return Promise.resolve({ ok: true, capsuleId });
}

function okSetAction(capsuleSetId: CapsuleSetId): Promise<CapsuleSetActionResponse> {
  return Promise.resolve({ ok: true, capsuleSetId });
}

// Default injectable stubs
function emptyFetch(): Promise<CapsulesResponse> {
  return Promise.resolve({ capsules: [] });
}

function fetchWith(capsules: readonly CapsuleListEntry[]): () => Promise<CapsulesResponse> {
  return () => Promise.resolve({ capsules });
}

function fetchSetsWith(
  capsuleSets: readonly CapsuleSetListEntry[],
): () => Promise<CapsuleSetsResponse> {
  return () => Promise.resolve({ capsuleSets });
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
    expect(screen.getByRole("button", { name: /^create Knowledge Pod$/i })).toBeInTheDocument();
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

  it("renders the create dialog in German while keeping Knowledge Pod as feature name", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <ConnectorGraph fetchCapsulesImpl={emptyFetch} />
      </I18nProvider>,
    );

    const createButton = await screen.findByRole("button", {
      name: "Ersten Knowledge Pod erstellen",
    });
    await user.click(createButton);

    const dialog = await screen.findByRole("dialog", { name: "Knowledge Pod erstellen" });
    await waitFor(() => {
      expect(within(dialog).getByText(/Benenne diesen Knowledge Pod/i)).toBeInTheDocument();
    });
    expect(within(dialog).getByLabelText(/Anzeigename des Knowledge Pod/i)).toBeInTheDocument();
    expect(within(dialog).getByText("Zugriff")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /^Lokal$/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Teilbar/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      within(dialog).getByRole("button", { name: "Knowledge Pod erstellen" }),
    ).toBeInTheDocument();
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

  it("renders redacted embedding reindex guidance when Knowledge Pod metadata is present", async () => {
    const capsule = makeCapsule({
      displayName: "Legacy Vectors",
      knowledgePod: {
        readiness: "degraded",
        embeddingCompatibilityStatus: "unknown",
        embeddingCompatibilityReason: "legacy-unverified-profile",
        reindexRecommended: true,
        queryEmbeddingAllowed: false,
        guidance: {
          label: "Reindex recommended",
          description: "Compatibility is unverified; lexical fallback remains available.",
          tone: "warning",
        },
      },
    });
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    const badge = await screen.findByText("Reindex recommended");
    const description =
      "Knowledge Pod guidance: Reindex recommended. Compatibility is unverified; lexical fallback remains available.";
    const row = screen.getByRole("article", { name: "Knowledge Pod: Legacy Vectors" });
    const dragHandle = screen.getByRole("button", {
      name: "Drag Knowledge Pod Legacy Vectors to the workspace",
    });

    expect(badge).not.toHaveAttribute("title");
    expect(screen.getByText(description)).toBeInTheDocument();
    expect(row).toHaveAccessibleDescription(description);
    expect(dragHandle).toHaveAccessibleDescription(description);
  });

  it("renders the danger-tone embedding mismatch guidance for an incompatible Knowledge Pod", async () => {
    const capsule = makeCapsule({
      displayName: "Mismatched Vectors",
      knowledgePod: {
        readiness: "degraded",
        embeddingCompatibilityStatus: "incompatible",
        embeddingCompatibilityReason: "fingerprint-mismatch",
        reindexRecommended: true,
        queryEmbeddingAllowed: false,
        guidance: {
          label: "Embedding mismatch",
          description: "Semantic retrieval is disabled for this pod until it is reindexed locally.",
          tone: "danger",
        },
      },
    });
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    const badge = await screen.findByText("Embedding mismatch");
    const description =
      "Knowledge Pod guidance: Embedding mismatch. Semantic retrieval is disabled for this pod until it is reindexed locally.";
    const row = screen.getByRole("article", { name: "Knowledge Pod: Mismatched Vectors" });
    const dragHandle = screen.getByRole("button", {
      name: "Drag Knowledge Pod Mismatched Vectors to the workspace",
    });

    expect(badge).not.toHaveAttribute("title");
    expect(screen.getByText(description)).toBeInTheDocument();
    expect(row).toHaveAccessibleDescription(description);
    expect(dragHandle).toHaveAccessibleDescription(description);
  });

  it("renders the policy-denied guidance for a sealed Knowledge Pod", async () => {
    const capsule = makeCapsule({
      displayName: "Sealed Pod",
      knowledgePod: {
        readiness: "degraded",
        sealed: true,
        reindexRecommended: false,
        queryEmbeddingAllowed: false,
        guidance: {
          label: "Policy denied",
          description:
            "This Knowledge Pod blocks grounded answer synthesis or raw-content release; Keiko will return a policy-denied state instead of sending excerpts to a model.",
          tone: "danger",
        },
      },
    });
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    const badge = await screen.findByText("Policy denied");
    const description =
      "Knowledge Pod guidance: Policy denied. This Knowledge Pod blocks grounded answer synthesis or raw-content release; Keiko will return a policy-denied state instead of sending excerpts to a model.";
    const row = screen.getByRole("article", { name: "Knowledge Pod: Sealed Pod" });

    expect(badge).not.toHaveAttribute("title");
    expect(screen.getByText(description)).toBeInTheDocument();
    expect(row).toHaveAccessibleDescription(description);
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

  it("renders Knowledge Pod Sets with readiness counts and workspace add", async () => {
    const capsule = makeCapsule({ id: makeCapsuleId("alpha"), displayName: "Alpha Docs" });
    const capsuleSet = makeCapsuleSet({
      id: makeCapsuleSetId("release"),
      displayName: "Release Readiness",
      knowledgePod: {
        readiness: "degraded",
        counts: {
          capsuleCount: 3,
          sourceCount: 3,
          documentCount: 4,
          chunkCount: 5,
          vectorCount: 6,
        },
        setReadiness: {
          readyCount: 0,
          draftCount: 0,
          degradedCount: 1,
          unavailableCount: 1,
          deniedCount: 1,
          indexingCount: 1,
          staleCount: 0,
          errorCount: 0,
          missingCount: 1,
          reasonCodes: [
            "member-indexing",
            "member-unavailable",
            "missing-member",
            "policy-denied",
            "embedding-incompatible",
            "no-vectors",
          ],
        },
        sourceKinds: ["files"],
        degradationReasons: ["legacy-unverified-profile"],
        reindexRecommended: true,
        queryEmbeddingAllowed: false,
        guidance: {
          label: "Reindex recommended",
          description: "Compatibility is unverified; lexical fallback remains available.",
          tone: "warning",
        },
      },
    });
    const workspace = document.createElement("main");
    workspace.className = "workspace";
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
    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([capsule])}
        fetchCapsuleSetsImpl={fetchSetsWith([capsuleSet])}
      />,
    );

    const row = await screen.findByRole("article", {
      name: "Knowledge Pod Set: Release Readiness",
    });
    expect(within(row).getByText("Degraded")).toBeInTheDocument();
    expect(within(row).getByText("Reindex recommended")).toBeInTheDocument();
    expect(row).toHaveAccessibleDescription(
      /pods:? 3.*sources:? 3.*docs:? 4.*chunks:? 5.*vectors:? 6.*ready:? 0.*degraded:? 1.*unavailable:? 1.*policy denied:? 1.*indexing:? 1.*stale:? 0.*error:? 0.*missing:? 1.*reasons: indexing, unavailable, missing, policy denied, embedding mismatch, no vectors/i,
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 Knowledge Pod, 1 Knowledge Pod Set");

    const addButton = screen.getByRole("button", {
      name: /add Knowledge Pod Set Release Readiness to workspace/i,
    });
    expect(addButton).toHaveAccessibleDescription(/embedding mismatch, no vectors/i);

    await user.click(addButton);

    expect(dropListener).toHaveBeenCalledTimes(1);
    const event = dropListener.mock.calls[0]?.[0] as CustomEvent<LocalKnowledgeConnectorDropDetail>;
    expect(event.detail.payload).toEqual({
      kind: "capsule-set",
      id: "set-release",
      label: "Release Readiness",
      lifecycleState: "degraded",
    });
    expect(event.detail.clientX).toBe(500);
    expect(event.detail.clientY).toBe(400);

    window.removeEventListener(LOCAL_KNOWLEDGE_CONNECTOR_DROP_EVENT, dropListener);
    workspace.remove();
  });

  it("asks for confirmation before calling deleteCapsuleSet (destructive, no undo)", async () => {
    const id = makeCapsuleSetId("delete-me");
    const capsuleSet = makeCapsuleSet({ id, displayName: "Quarterly Review" });
    const deleteCapsuleSetImpl = vi.fn().mockImplementation(() => okSetAction(id));
    const user = userEvent.setup();

    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([makeCapsule()])}
        fetchCapsuleSetsImpl={fetchSetsWith([capsuleSet])}
        deleteCapsuleSetImpl={deleteCapsuleSetImpl}
      />,
    );

    const deleteBtn = await screen.findByRole("button", {
      name: /delete Knowledge Pod Set Quarterly Review/i,
    });
    await user.click(deleteBtn);

    // The confirm dialog opens first — nothing is deleted yet (AUDIT-E1821-003).
    expect(deleteCapsuleSetImpl).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: /delete Knowledge Pod Set/i });
    expect(dialog.textContent).toContain("Quarterly Review");

    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(deleteCapsuleSetImpl).toHaveBeenCalledWith(id);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does NOT call deleteCapsuleSet when the confirmation is cancelled", async () => {
    const id = makeCapsuleSetId("keep-me");
    const capsuleSet = makeCapsuleSet({ id, displayName: "Keep Set" });
    const deleteCapsuleSetImpl = vi.fn().mockImplementation(() => okSetAction(id));
    const user = userEvent.setup();

    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([makeCapsule()])}
        fetchCapsuleSetsImpl={fetchSetsWith([capsuleSet])}
        deleteCapsuleSetImpl={deleteCapsuleSetImpl}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: /delete Knowledge Pod Set Keep Set/i }),
    );
    const dialog = screen.getByRole("dialog", { name: /delete Knowledge Pod Set/i });
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(deleteCapsuleSetImpl).not.toHaveBeenCalled();
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
  it("submits a trimmed display name without a create-time model-use policy", async () => {
    const createCapsuleImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, capsuleId: makeCapsuleId("create") });
    const user = userEvent.setup();

    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} createCapsuleImpl={createCapsuleImpl} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^create Knowledge Pod$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^create Knowledge Pod$/i }));
    await user.type(screen.getByLabelText(/pod display name/i), "  Treasury Docs  ");
    await user.click(
      within(screen.getByRole("dialog", { name: /create Knowledge Pod/i })).getByRole("button", {
        name: /^create Knowledge Pod$/i,
      }),
    );

    await waitFor(() => {
      expect(createCapsuleImpl).toHaveBeenCalledWith({
        displayName: "Treasury Docs",
      });
    });
  });

  it("shows local access as the active create option and shareable access as disabled", async () => {
    const createCapsuleImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, capsuleId: makeCapsuleId("create") });
    const user = userEvent.setup();

    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} createCapsuleImpl={createCapsuleImpl} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^create Knowledge Pod$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^create Knowledge Pod$/i }));
    const dialog = screen.getByRole("dialog", { name: /create Knowledge Pod/i });
    const local = within(dialog).getByRole("radio", { name: /^local$/i });
    const shareable = within(dialog).getByRole("radio", { name: /shareable/i });

    expect(local).toBeChecked();
    expect(shareable).toHaveAttribute("aria-disabled", "true");

    await user.type(within(dialog).getByLabelText(/pod display name/i), "Local Docs");
    await user.click(
      within(dialog).getByRole("button", {
        name: /^create Knowledge Pod$/i,
      }),
    );

    await waitFor(() => {
      expect(createCapsuleImpl).toHaveBeenCalledWith({
        displayName: "Local Docs",
      });
    });
  });

  it("explains access choices in the create dialog", async () => {
    const user = userEvent.setup();

    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^create Knowledge Pod$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^create Knowledge Pod$/i }));
    const dialog = screen.getByRole("dialog", { name: /create Knowledge Pod/i });
    const local = within(dialog).getByRole("radio", { name: /^local$/i });
    const shareable = within(dialog).getByRole("radio", { name: /shareable/i });
    const helpButton = within(dialog).getByLabelText("Explain Knowledge Pod access");

    expect(local.closest("label")).toHaveClass("c-radio");
    expect(shareable).toHaveClass("c-radio");

    await user.click(helpButton);

    expect(screen.getByRole("tooltip")).toHaveTextContent(/local keeps it private/i);
    expect(helpButton).toHaveAccessibleDescription(/shareable will allow trusted sharing later/i);
  });

  it("explains the disabled future sharing option on hover", async () => {
    const user = userEvent.setup();

    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^create Knowledge Pod$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^create Knowledge Pod$/i }));
    const dialog = screen.getByRole("dialog", { name: /create Knowledge Pod/i });
    const shareable = within(dialog).getByRole("radio", { name: /shareable/i });

    await user.hover(shareable);

    expect(screen.getByRole("tooltip")).toHaveTextContent(/share Knowledge Pods with trusted/i);
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
      makeCapsule({
        id: makeCapsuleId("3"),
        displayName: "C Doc",
        lifecycleState: "stale",
        knowledgePod: {
          readiness: "degraded",
          embeddingCompatibilityStatus: "unavailable",
          embeddingCompatibilityReason: "policy-denied",
          reindexRecommended: false,
          queryEmbeddingAllowed: false,
          guidance: {
            label: "Embedding unavailable",
            description: "Semantic retrieval cannot run under the current local policy.",
            tone: "danger",
          },
        },
      }),
      makeCapsule({ id: makeCapsuleId("4"), displayName: "D Doc", lifecycleState: "error" }),
    ];
    const { container } = render(<ConnectorGraph fetchCapsulesImpl={fetchWith(capsules)} />);
    await waitFor(() => {
      expect(screen.getByText("A Doc")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: incompatible and policy-denied guidance render without violations", async () => {
    const capsules = [
      makeCapsule({
        id: makeCapsuleId("incompatible"),
        displayName: "Incompatible Pod",
        lifecycleState: "ready",
        knowledgePod: {
          readiness: "degraded",
          embeddingCompatibilityStatus: "incompatible",
          embeddingCompatibilityReason: "fingerprint-mismatch",
          reindexRecommended: true,
          queryEmbeddingAllowed: false,
          guidance: {
            label: "Embedding mismatch",
            description:
              "Semantic retrieval is disabled for this pod until it is reindexed locally.",
            tone: "danger",
          },
        },
      }),
      makeCapsule({
        id: makeCapsuleId("denied"),
        displayName: "Denied Pod",
        lifecycleState: "ready",
        knowledgePod: {
          readiness: "degraded",
          sealed: true,
          reindexRecommended: false,
          queryEmbeddingAllowed: false,
          guidance: {
            label: "Policy denied",
            description:
              "This Knowledge Pod blocks grounded answer synthesis or raw-content release; Keiko will return a policy-denied state instead of sending excerpts to a model.",
            tone: "danger",
          },
        },
      }),
    ];
    const { container } = render(<ConnectorGraph fetchCapsulesImpl={fetchWith(capsules)} />);
    await waitFor(() => {
      expect(screen.getByText("Incompatible Pod")).toBeInTheDocument();
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
      expect(screen.getByRole("button", { name: /^create Knowledge Pod$/i })).toBeInTheDocument();
    });
    const trigger = screen.getByRole("button", { name: /^create Knowledge Pod$/i });
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
    const submitBtn = within(dialog).getByRole("button", { name: /^create Knowledge Pod$/i });
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
      within(dialog).getByRole("button", { name: /^create Knowledge Pod$/i }),
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

describe("ConnectorGraph — manual refresh diagnostics panel (Epic #1856, Issue #1893)", () => {
  function manualRefreshCapsule(
    overrides: Partial<CapsuleListEntry["knowledgePod"]> = {},
  ): CapsuleListEntry {
    return makeCapsule({
      id: makeCapsuleId("manual"),
      displayName: "Operator Manual",
      lifecycleState: "ready",
      knowledgePod: {
        readiness: "ready",
        reindexRecommended: false,
        queryEmbeddingAllowed: true,
        ...overrides,
      },
    });
  }

  it("renders no panel when manualRefresh is absent", async () => {
    const { container } = render(
      <ConnectorGraph fetchCapsulesImpl={fetchWith([manualRefreshCapsule()])} />,
    );
    await waitFor(() => {
      expect(screen.getByText("Operator Manual")).toBeInTheDocument();
    });
    expect(screen.queryByText("Last refresh")).toBeNull();
    expect(container.querySelector(".lkd-manual-refresh")).toBeNull();
  });

  it("renders an updated refresh with counts and no leaked path/origin", async () => {
    const capsule = manualRefreshCapsule({
      manualRefresh: {
        schemaVersion: "1",
        outcome: "updated",
        sourceKind: "html-manual-http",
        counts: {
          addedPages: 3,
          changedPages: 2,
          removedPages: 1,
          movedPages: 0,
          unchangedPages: 10,
          failedPages: 0,
          deniedLinks: 0,
        },
        removalDetection: "evaluated",
        crawlRunFingerprint: "fp-abc123def456",
        reasonCodes: ["pages-added", "pages-changed", "pages-removed"],
        refreshedAt: 1_700_000_000_000,
      },
    });
    const { container } = render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);
    await waitFor(() => {
      expect(screen.getByText("Last refresh")).toBeInTheDocument();
    });
    expect(screen.getByText("Updated")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("New pages were discovered and indexed.")).toBeInTheDocument();
    expect(screen.getByText("Existing pages changed and were re-indexed.")).toBeInTheDocument();
    expect(
      screen.getByText("Pages that are no longer reachable were removed from the pod."),
    ).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(text).not.toContain("http");
    expect(text).not.toContain("/keiko-html-manual");
    expect(text).not.toContain("fp-abc123def456");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("renders a partial refresh as a warning tone with failed/denied counts", async () => {
    const capsule = manualRefreshCapsule({
      manualRefresh: {
        schemaVersion: "1",
        outcome: "partial",
        sourceKind: "html-manual-local",
        counts: {
          addedPages: 1,
          changedPages: 0,
          removedPages: 0,
          movedPages: 0,
          unchangedPages: 5,
          failedPages: 2,
          deniedLinks: 1,
        },
        removalDetection: "evaluated",
        crawlRunFingerprint: "fp-partial-1",
        reasonCodes: ["pages-failed", "links-denied"],
        refreshedAt: 1_700_000_100_000,
      },
    });
    const { container } = render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);
    await waitFor(() => {
      expect(screen.getByText("Last refresh")).toBeInTheDocument();
    });
    expect(screen.getByText("Partial")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Some pages could not be re-indexed and may be temporarily unsearchable; a future successful refresh will retry them.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Some links were skipped because they fell outside the approved scope."),
    ).toBeInTheDocument();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("renders a failed refresh as an error tone", async () => {
    const capsule = manualRefreshCapsule({
      manualRefresh: {
        schemaVersion: "1",
        outcome: "failed",
        sourceKind: "html-manual-http",
        counts: {
          addedPages: 0,
          changedPages: 0,
          removedPages: 0,
          movedPages: 0,
          unchangedPages: 0,
          failedPages: 0,
          deniedLinks: 0,
        },
        removalDetection: "not-evaluated-page-limit",
        crawlRunFingerprint: "fp-failed-1",
        reasonCodes: ["index-failed"],
        refreshedAt: 1_700_000_200_000,
      },
    });
    const { container } = render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);
    await waitFor(() => {
      expect(screen.getByText("Last refresh")).toBeInTheDocument();
    });
    const panel = container.querySelector(".lkd-manual-refresh");
    expect(panel).not.toBeNull();
    expect(
      within(panel as HTMLElement).getByText("Failed", { selector: ".lk-badge" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Indexing failed during refresh. Pages that were being re-indexed at the time of failure may be temporarily unsearchable until a future successful refresh repairs them.",
      ),
    ).toBeInTheDocument();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("renders a cancelled refresh as a draft-tone badge with cancellation guidance", async () => {
    const capsule = manualRefreshCapsule({
      manualRefresh: {
        schemaVersion: "1",
        outcome: "cancelled",
        sourceKind: "html-manual-http",
        counts: {
          addedPages: 0,
          changedPages: 0,
          removedPages: 0,
          movedPages: 0,
          unchangedPages: 0,
          failedPages: 0,
          deniedLinks: 0,
        },
        removalDetection: "not-evaluated-page-limit",
        crawlRunFingerprint: "fp-cancelled-1",
        reasonCodes: ["crawl-cancelled"],
        refreshedAt: 1_700_000_400_000,
      },
    });
    const { container } = render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);
    await waitFor(() => {
      expect(screen.getByText("Last refresh")).toBeInTheDocument();
    });
    const panel = container.querySelector(".lkd-manual-refresh");
    expect(panel).not.toBeNull();
    expect(
      within(panel as HTMLElement).getByText("Cancelled", { selector: ".lk-badge" }),
    ).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByText("Cancelled").dataset["state"]).toBe("draft");
    expect(
      screen.getByText(
        "The refresh was cancelled. Pages not yet reached are unaffected; a page already being re-indexed at that moment may be temporarily unsearchable until a future successful refresh.",
      ),
    ).toBeInTheDocument();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("shows a removal-skipped note when the crawl reached its page limit", async () => {
    const capsule = manualRefreshCapsule({
      manualRefresh: {
        schemaVersion: "1",
        outcome: "unchanged",
        sourceKind: "html-manual-http",
        counts: {
          addedPages: 0,
          changedPages: 0,
          removedPages: 0,
          movedPages: 0,
          unchangedPages: 40,
          failedPages: 0,
          deniedLinks: 0,
        },
        removalDetection: "not-evaluated-page-limit",
        crawlRunFingerprint: "fp-limit-1",
        reasonCodes: ["scope-limit-reached", "removal-detection-skipped"],
        refreshedAt: 1_700_000_300_000,
      },
    });
    const { container } = render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);
    await waitFor(() => {
      expect(screen.getByText("Last refresh")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Removed pages could not be detected this run (the crawl reached its page limit).",
      ),
    ).toBeInTheDocument();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // The <section> in connector-graph.tsx carries BOTH `lkd-manual-refresh` and the `panelScope`
  // CSS-module class on the SAME element (see the ManualRefreshPanel className above). jsdom does
  // not apply real stylesheet box-model rules, so a descendant-combinator ("scope .lkd-manual-refresh")
  // root rule would silently never match without failing any DOM/a11y assertion above. Guard the
  // source selector at the string level, as PdfCitationPreviewWindow.test.tsx does for the same class
  // of jsdom gap.
  it("scopes the panel root rule with a compound selector, not a descendant combinator", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "manual-refresh-panel.module.css"),
      "utf8",
    );
    expect(css).toMatch(/\.panelScope:global\(\.lkd-manual-refresh\)\s*\{/);
    expect(css).not.toMatch(/\.panelScope\s+:global\(\.lkd-manual-refresh\)\s*\{/);
  });
});

describe("ConnectorGraph — responsive layout (AUDIT-E1821-004)", () => {
  it("renders the page and dialogs on the shared fluid layout classes, not fixed pixel widths", async () => {
    const capsule = makeCapsule({ displayName: "Alpha" });
    const { container } = render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);
    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument();
    });
    const page = container.querySelector(".lk-page");
    expect(page).not.toBeNull();
    expect(page).not.toHaveAttribute("style");
  });

  // jsdom does not apply real stylesheet box-model rules (see the panel-scope guard above), so
  // pin the source `.lk-page` / `.mc-dialog` fluid-width rules at the string level instead of
  // relying on computed layout.
  it("keeps the page and dialog primitives fluid in globals.css instead of a fixed pixel width", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../globals.css"),
      "utf8",
    );
    const lkPageBlock = /\.lk-page\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    const mcDialogBlock = /\.mc-dialog\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(lkPageBlock).toMatch(/width:\s*100%/);
    expect(mcDialogBlock).toMatch(/width:\s*min\(/);
  });
});
