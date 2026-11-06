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
  CapsuleDetailResponse,
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
import {
  resetClientDiagnosticWriter,
  setClientDiagnosticWriter,
  type ClientDiagnosticWriter,
} from "@/lib/client-diagnostics";

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

const originalPlatform = window.navigator.platform;

function stubPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  pushMock.mockReset();
});

afterEach(() => {
  resetClientDiagnosticWriter();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
  stubPlatform(originalPlatform);
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

function createdPod(id: KnowledgeCapsuleId, displayName: string): CapsuleDetailResponse {
  return {
    capsule: {
      id,
      displayName,
      tags: [],
      sourceIds: [],
      retrievalEffort: "default",
      outputMode: "snippets",
      answerGroundingPolicy: "require-citations",
      embeddingModelIdentity: {
        provider: "openai-compatible:test",
        modelId: "test-embedding",
        vectorDimensions: 8,
        vectorMetric: "cosine",
      },
      lifecycleState: "draft",
      storageReference: `capsules/${id}`,
      createdAt: 1,
      updatedAt: 1,
    },
  };
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
    expect(screen.queryByRole("button", { name: /add html manual/i })).toBeNull();
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
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "HTML-Handbuch hinzufügen" })).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Knowledge Pod erstellen" }),
    ).toBeInTheDocument();
  });
});

describe("ConnectorGraph — with capsules", () => {
  // 1.3.5 field report: the Jira Live Pods section came first and filled the page's height, so a
  // newly created Knowledge Pod appeared a screen below it. The person's own pods come first.
  it("lists the Knowledge Pods before the Jira Live Pods section", async () => {
    render(
      <ConnectorGraph fetchCapsulesImpl={fetchWith([makeCapsule({ displayName: "Policy" })])} />,
    );
    const list = await screen.findByRole("list", { name: "Knowledge Pod list" });
    const jira = screen.getByTestId("acx-panel");
    expect(list.compareDocumentPosition(jira) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(jira.className).toMatch(/cmpEmbedded/);
    expect(screen.getAllByRole("heading", { name: "Knowledge Pods" })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Knowledge Pods" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Knowledge Pods" })).toContainElement(list);
    const createKnowledge = screen.getByRole("button", { name: "Create Knowledge Pod" });
    const createJira = screen.getByRole("button", { name: "Create Jira Pod" });
    expect(createKnowledge.className).toBe(createJira.className);
  });

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

  it.each([
    ["reindex-recommended", "warning"],
    ["embedding-mismatch", "danger"],
    ["policy-denied", "danger"],
  ] as const)("keeps the pod name clear when guidance is %s", async (code, tone) => {
    const capsule = makeCapsule({
      displayName: "My Documents",
      sourceCount: 0,
      lifecycleState: "draft",
      knowledgePod: {
        readiness: "degraded",
        reindexRecommended: true,
        queryEmbeddingAllowed: false,
        guidance: { code, scope: "pod", tone },
      },
    });
    render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

    const row = await screen.findByRole("article", { name: "Knowledge Pod: My Documents" });
    const identity = within(row).getByRole("button", {
      name: "Drag Knowledge Pod My Documents to the workspace",
    });
    expect(identity).toHaveTextContent(/^My Documents$/);
    expect(row.querySelector(".lk-badge")).toBeNull();
    expect(within(row).queryByText(/Knowledge Pod guidance/)).toBeNull();
    expect(within(row).queryByRole("menu")).toBeNull();
    expect(
      within(row).getByRole("button", { name: "Actions for Knowledge Pod My Documents" }),
    ).toHaveAttribute("aria-haspopup", "menu");
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
        guidance: { code: "reindex-recommended", scope: "pod", tone: "warning" },
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
    stubPlatform("MacIntel");
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

describe("ConnectorGraph — localized row actions", () => {
  it("names every Knowledge Pod row action in German", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    const capsule = makeCapsule({ id: makeCapsuleId("de-row"), displayName: "Fachkonzept" });
    render(
      <I18nProvider>
        <ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />
      </I18nProvider>,
    );

    const actions = await screen.findByRole("group", {
      name: "Aktionen für Knowledge Pod Fachkonzept",
    });
    expect(
      within(actions).getByRole("button", {
        name: "Knowledge Pod Fachkonzept zum Arbeitsbereich hinzufügen",
      }),
    ).toBeInTheDocument();
    await userEvent.setup().click(
      within(actions).getByRole("button", {
        name: "Aktionen für Knowledge Pod Fachkonzept",
      }),
    );
    expect(
      within(actions).getByRole("menuitem", {
        name: "Details zu Knowledge Pod Fachkonzept öffnen",
      }),
    ).toHaveTextContent("Details");
    expect(
      within(actions).getByRole("menuitem", { name: "Knowledge Pod Fachkonzept trennen" }),
    ).toHaveTextContent("Trennen");
    expect(screen.queryByText("Indexiert")).toBeNull();
  });
});

// 1.1.13 audit (PR #3678): the German UI kept English text on the Knowledge Pod row and Set row
// (aria-labels, busy labels, readiness badges, counts, guidance) beside the German "Details" and
// "Trennen" buttons. Every string below now comes from the Local Knowledge catalog.
describe("ConnectorGraph — German Knowledge Pod surfaces", () => {
  function renderGerman(ui: ReactNode): void {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(<I18nProvider>{ui}</I18nProvider>);
  }

  it("localizes indexing actions and hides indexing without a source", async () => {
    const user = userEvent.setup();
    const drafts = makeCapsule({
      id: makeCapsuleId("de-draft"),
      displayName: "Entwurfspod",
      lifecycleState: "draft",
    });
    const running = makeCapsule({
      id: makeCapsuleId("de-run"),
      displayName: "Laufender Pod",
      lifecycleState: "indexing",
    });
    const empty = makeCapsule({
      id: makeCapsuleId("de-empty"),
      displayName: "Leerer Pod",
      lifecycleState: "draft",
      sourceCount: 0,
    });
    let resolveStart: (value: CapsuleActionResponse) => void = () => undefined;
    let resolveCancel: (value: CapsuleActionResponse) => void = () => undefined;
    const startIndexingImpl = vi.fn().mockImplementation(
      () =>
        new Promise<CapsuleActionResponse>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const cancelIndexingImpl = vi.fn().mockImplementation(
      () =>
        new Promise<CapsuleActionResponse>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    renderGerman(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([drafts, running, empty])}
        startIndexingImpl={startIndexingImpl}
        cancelIndexingImpl={cancelIndexingImpl}
      />,
    );

    await screen.findByRole("article", { name: "Knowledge Pod: Leerer Pod" });
    expect(
      screen.queryByRole("button", {
        name: "Indexierung für Knowledge Pod Leerer Pod starten",
      }),
    ).toBeNull();

    const start = screen.getByRole("button", {
      name: "Indexierung für Knowledge Pod Entwurfspod starten",
    });
    expect(start).toHaveTextContent("Indexieren");
    await user.click(start);
    expect(start).toHaveTextContent("Wird indexiert…");
    resolveStart({ ok: true, capsuleId: drafts.id });

    const cancel = screen.getByRole("button", {
      name: "Indexierung für Knowledge Pod Laufender Pod abbrechen",
    });
    expect(cancel).toHaveTextContent("Abbrechen");
    await user.click(cancel);
    expect(cancel).toHaveTextContent("Wird abgebrochen…");
    resolveCancel({ ok: true, capsuleId: running.id });
  });

  it("localizes the Knowledge Pod Set row: pod count, readiness, counts and reasons", async () => {
    const capsuleSet = makeCapsuleSet({
      id: makeCapsuleSetId("de-release"),
      displayName: "Release Readiness",
      capsuleCount: 3,
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
          reasonCodes: ["member-indexing", "missing-member", "policy-denied", "no-vectors"],
        },
        reindexRecommended: false,
        queryEmbeddingAllowed: true,
      },
    });
    renderGerman(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([makeCapsule()])}
        fetchCapsuleSetsImpl={fetchSetsWith([capsuleSet])}
      />,
    );

    const row = await screen.findByRole("article", {
      name: "Knowledge Pod Set: Release Readiness",
    });
    expect(within(row).getByText("Eingeschränkt")).toBeInTheDocument();
    expect(within(row).getByText("3 Pods")).toBeInTheDocument();
    const description = row.getAttribute("aria-describedby");
    expect(description).not.toBeNull();
    expect(row).toHaveAccessibleDescription(
      /Bereitschaft des Knowledge Pod Sets: Eingeschränkt\..*Quellen:? 3.*Dokumente:? 4.*Chunks:? 5.*Vektoren:? 6.*bereit:? 0.*eingeschränkt:? 1.*nicht verfügbar:? 1.*durch Richtlinie gesperrt:? 1.*wird indexiert:? 1.*veraltet:? 0.*fehlgeschlagen:? 0.*fehlend:? 1.*Gründe: wird indexiert, fehlend, durch Richtlinie gesperrt, keine Vektoren/,
    );
  });

  it("localizes the readiness badge of a Knowledge Pod Set for every state", async () => {
    const states = [
      ["ready", "Bereit"],
      ["indexing", "Wird indexiert"],
      ["stale", "Veraltet"],
      ["unavailable", "Nicht verfügbar"],
      ["error", "Fehlgeschlagen"],
      ["draft", "Entwurf"],
    ] as const;
    const sets = states.map(([readiness], index) =>
      makeCapsuleSet({
        id: makeCapsuleSetId(`de-state-${String(index)}`),
        displayName: `Set ${readiness}`,
        knowledgePod: {
          readiness,
          reindexRecommended: false,
          queryEmbeddingAllowed: true,
        },
      }),
    );
    renderGerman(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([makeCapsule()])}
        fetchCapsuleSetsImpl={fetchSetsWith(sets)}
      />,
    );

    for (const [readiness, label] of states) {
      const row = await screen.findByRole("article", {
        name: `Knowledge Pod Set: Set ${readiness}`,
      });
      expect(within(row).getByText(label)).toBeInTheDocument();
    }
  });

  it("localizes the compact pod menu and keeps its keyboard path", async () => {
    const user = userEvent.setup();
    const onOpenCapsule = vi.fn();
    renderGerman(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([makeCapsule()])}
        onOpenCapsule={onOpenCapsule}
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: "Aktionen für Knowledge Pod My Capsule",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    const details = screen.getByRole("menuitem", {
      name: "Details zu Knowledge Pod My Capsule öffnen",
    });
    expect(details).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("menuitem", { name: "Knowledge Pod My Capsule trennen" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
    await user.keyboard("{Enter}{Enter}");
    expect(onOpenCapsule).toHaveBeenCalledWith(makeCapsuleId("1"));
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
  it("does not certify a selection before an external detail view actually opens", async () => {
    const diagnostic = vi.fn<ClientDiagnosticWriter>();
    setClientDiagnosticWriter(diagnostic);
    const onOpenCapsule = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([makeCapsule({ displayName: "Selection" })])}
        onOpenCapsule={onOpenCapsule}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Actions for Knowledge Pod Selection" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Open details for Knowledge Pod Selection" }),
    );
    expect(onOpenCapsule).toHaveBeenCalledOnce();
    expect(
      diagnostic.mock.calls.some(([message]) => message === "Knowledge Pod selection settled."),
    ).toBe(false);
  });

  it("records a failed open after successful creation without misclassifying it as a create failure", async () => {
    const diagnostic = vi.fn<ClientDiagnosticWriter>();
    setClientDiagnosticWriter(diagnostic);
    const createdId = makeCapsuleId("open-failure");
    const createCapsuleImpl = vi.fn().mockResolvedValue(createdPod(createdId, "Created Pod"));
    const onOpenCapsule = vi.fn(() => {
      throw new Error("PRIVATE opening failure");
    });
    const user = userEvent.setup();
    render(
      <ConnectorGraph
        fetchCapsulesImpl={emptyFetch}
        createCapsuleImpl={createCapsuleImpl}
        onOpenCapsule={onOpenCapsule}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Create Knowledge Pod" }));
    const dialog = screen.getByRole("dialog", { name: "Create Knowledge Pod" });
    await user.type(within(dialog).getByLabelText("Knowledge Pod display name"), "Created Pod");
    await user.click(within(dialog).getByRole("button", { name: "Create Knowledge Pod" }));
    await waitFor(() =>
      expect(diagnostic).toHaveBeenCalledWith(
        "Knowledge Pod opening failed.",
        expect.objectContaining({
          correlationId: expect.any(String),
          errorEvidence: expect.any(Object),
        }),
      ),
    );
    expect(
      diagnostic.mock.calls.some(([message]) => message === "Knowledge Pod creation failed."),
    ).toBe(false);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("PRIVATE opening failure");
    expect(screen.queryByRole("dialog", { name: "Create Knowledge Pod" })).toBeNull();
  });

  it("setup regression: opens the newly created pod instead of leaving setup on an existing pod", async () => {
    const createdId = makeCapsuleId("new-migration");
    const onOpenCapsule = vi.fn();
    const createCapsuleImpl = vi.fn().mockResolvedValue(createdPod(createdId, "Migration"));
    const user = userEvent.setup();
    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([makeCapsule({ displayName: "Existing documents" })])}
        createCapsuleImpl={createCapsuleImpl}
        onOpenCapsule={onOpenCapsule}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Create Knowledge Pod" }));
    const dialog = screen.getByRole("dialog", { name: "Create Knowledge Pod" });
    await user.type(within(dialog).getByLabelText("Knowledge Pod display name"), "Migration");
    await user.click(within(dialog).getByRole("button", { name: "Create Knowledge Pod" }));
    await waitFor(() => expect(onOpenCapsule).toHaveBeenCalledExactlyOnceWith(createdId));
  });

  it("setup regression: offers document setup for an empty pod and opens that exact pod", async () => {
    const emptyId = makeCapsuleId("empty-migration");
    const onOpenCapsule = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([
          makeCapsule({ displayName: "Existing documents" }),
          makeCapsule({
            id: emptyId,
            displayName: "Migration",
            lifecycleState: "draft",
            sourceCount: 0,
          }),
        ])}
        onOpenCapsule={onOpenCapsule}
      />,
    );
    const row = await screen.findByRole("article", { name: "Knowledge Pod: Migration" });
    await user.click(
      within(row).getByRole("button", { name: "Add documents to Knowledge Pod Migration" }),
    );
    expect(onOpenCapsule).toHaveBeenCalledExactlyOnceWith(emptyId);
    expect(
      within(row).queryByRole("button", { name: "Add Knowledge Pod Migration to workspace" }),
    ).toBeNull();
  });

  it("setup regression: does not present an indexed pod as needing initial indexing", async () => {
    render(
      <ConnectorGraph
        fetchCapsulesImpl={fetchWith([makeCapsule({ displayName: "Ready documents" })])}
      />,
    );
    const row = await screen.findByRole("article", { name: "Knowledge Pod: Ready documents" });
    expect(within(row).queryByRole("button", { name: /start indexing/i })).toBeNull();
    expect(
      within(row).getByRole("button", { name: "Add Knowledge Pod Ready documents to workspace" }),
    ).toBeEnabled();
  });

  it("submits only the trimmed display name", async () => {
    const createCapsuleImpl = vi
      .fn()
      .mockResolvedValue(createdPod(makeCapsuleId("create"), "Treasury Docs"));
    const user = userEvent.setup();

    render(
      <ConnectorGraph
        fetchCapsulesImpl={emptyFetch}
        createCapsuleImpl={createCapsuleImpl}
        onOpenCapsule={vi.fn()}
      />,
    );

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

  it.each([
    ["en", "Create Knowledge Pod", "Knowledge Pod display name", "Cancel"],
    ["de", "Knowledge Pod erstellen", "Anzeigename des Knowledge Pod", "Abbrechen"],
  ] as const)("asks only for a name in %s", async (locale, createLabel, nameLabel, cancelLabel) => {
    window.localStorage.setItem(I18N_STORAGE_KEY, locale);
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <ConnectorGraph fetchCapsulesImpl={emptyFetch} />
      </I18nProvider>,
    );
    await user.click(await screen.findByRole("button", { name: createLabel }));
    const dialog = screen.getByRole("dialog", { name: createLabel });
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(1);
    await waitFor(() =>
      expect(within(dialog).getByLabelText(nameLabel, { exact: true })).toHaveFocus(),
    );
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).getAllByRole("button")).toHaveLength(2);
    expect(within(dialog).getByRole("button", { name: cancelLabel })).toBeEnabled();
  });

  it("rejects a blank name before sending a create request", async () => {
    const createCapsuleImpl = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} createCapsuleImpl={createCapsuleImpl} />);
    await user.click(await screen.findByRole("button", { name: /^create Knowledge Pod$/i }));
    const dialog = screen.getByRole("dialog", { name: /create Knowledge Pod/i });
    await user.type(within(dialog).getByLabelText(/pod display name/i), "   ");
    await user.click(within(dialog).getByRole("button", { name: /^create Knowledge Pod$/i }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Pod display name is required.");
    expect(createCapsuleImpl).not.toHaveBeenCalled();
  });

  it("keeps the name and dialog available after a failed create request", async () => {
    const createCapsuleImpl = vi.fn().mockRejectedValueOnce(new Error("Create unavailable"));
    const user = userEvent.setup();
    render(<ConnectorGraph fetchCapsulesImpl={emptyFetch} createCapsuleImpl={createCapsuleImpl} />);
    await user.click(await screen.findByRole("button", { name: /^create Knowledge Pod$/i }));
    const dialog = screen.getByRole("dialog", { name: /create Knowledge Pod/i });
    await user.type(within(dialog).getByLabelText(/pod display name/i), "Retry Docs");
    await user.click(within(dialog).getByRole("button", { name: /^create Knowledge Pod$/i }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: /create Knowledge Pod/i })).toBeVisible(),
    );
    expect(within(dialog).getByLabelText(/pod display name/i)).toHaveValue("Retry Docs");
    expect(within(dialog).getByRole("alert")).toBeVisible();
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

  it("offers details instead of indexing for capsules without attached sources", async () => {
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

    expect(
      screen.queryByRole("button", {
        name: /start indexing Knowledge Pod empty cap/i,
      }),
    ).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Actions for Knowledge Pod Empty Cap" }));
    expect(
      screen.getByRole("menuitem", { name: "Open details for Knowledge Pod Empty Cap" }),
    ).toBeVisible();
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

    await user.click(screen.getByRole("button", { name: "Actions for Knowledge Pod Ready Cap" }));
    await user.click(screen.getByRole("menuitem", { name: /disconnect Knowledge Pod ready cap/i }));

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

    await user.click(screen.getByRole("button", { name: "Actions for Knowledge Pod Keep Cap" }));
    await user.click(screen.getByRole("menuitem", { name: /disconnect Knowledge Pod keep cap/i }));
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

    await user.click(screen.getByRole("button", { name: "Actions for Knowledge Pod Health Cap" }));
    await user.click(
      screen.getByRole("menuitem", { name: /open details for Knowledge Pod health cap/i }),
    );

    expect(onOpenCapsule).toHaveBeenCalledWith(id);
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("ConnectorGraph — compact pod identities", () => {
  const stateCases: Array<{ state: CapsuleLifecycleState; expectedLabel: string }> = [
    { state: "draft", expectedLabel: "Draft" },
    { state: "indexing", expectedLabel: "Indexing" },
    { state: "ready", expectedLabel: "Indexed" },
    { state: "stale", expectedLabel: "Stale" },
    { state: "deleting", expectedLabel: "Deleting" },
    { state: "error", expectedLabel: "Failed" },
  ];

  for (const { state, expectedLabel } of stateCases) {
    it(`keeps lifecycle state "${state}" in details instead of the list`, async () => {
      const capsule = makeCapsule({ lifecycleState: state, displayName: `Cap-${state}` });
      render(<ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />);

      await waitFor(() => {
        expect(screen.getByText(`Cap-${state}`)).toBeInTheDocument();
      });

      const row = screen.getByRole("article", { name: `Knowledge Pod: Cap-${state}` });
      expect(within(row).queryByText(expectedLabel)).toBeNull();
      expect(
        within(row).getByRole("button", {
          name: `Drag Knowledge Pod Cap-${state} to the workspace`,
        }),
      ).toHaveTextContent(`Cap-${state}`);
    });
  }
});

describe("ConnectorGraph — error states", () => {
  it("renders an alert when fetchCapsules rejects", async () => {
    const fetchCapsulesImpl = vi.fn().mockRejectedValue(new Error("network error"));

    render(<ConnectorGraph fetchCapsulesImpl={fetchCapsulesImpl} />);

    await waitFor(() => {
      const alert = screen.getByText("network error").closest('[role="alert"]');
      expect(alert).not.toBeNull();
    });

    // Retry button is reachable
    expect(
      screen.getByRole("button", { name: /retry loading Knowledge Pods/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByRole("button", { name: /create your first Knowledge Pod/i })).toBeNull();
  });

  it("shows the empty state only after a failed load is retried successfully", async () => {
    const user = userEvent.setup();
    const fetchCapsulesImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue({ capsules: [] });
    render(<ConnectorGraph fetchCapsulesImpl={fetchCapsulesImpl} />);
    const retry = await screen.findByRole("button", { name: /retry loading Knowledge Pods/i });
    expect(screen.queryByTestId("empty-state")).toBeNull();
    await user.click(retry);
    expect(await screen.findByTestId("empty-state")).toBeInTheDocument();
    expect(screen.queryByText("network error")).toBeNull();
  });

  it("retains cached Pod rows when a reload fails", async () => {
    const user = userEvent.setup();
    const capsule = makeCapsule({ displayName: "Cached Pod", lifecycleState: "draft" });
    const fetchCapsulesImpl = vi
      .fn()
      .mockResolvedValueOnce({ capsules: [capsule] })
      .mockRejectedValue(new Error("network error"));
    render(<ConnectorGraph fetchCapsulesImpl={fetchCapsulesImpl} startIndexingImpl={okAction} />);
    await user.click(
      await screen.findByRole("button", { name: /start indexing Knowledge Pod Cached Pod/i }),
    );
    expect(await screen.findByText("network error")).toBeInTheDocument();
    expect(screen.getByText("Cached Pod")).toBeInTheDocument();
    expect(screen.queryByTestId("empty-state")).toBeNull();
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
          guidance: { code: "embedding-unavailable", scope: "pod", tone: "danger" },
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
          guidance: { code: "embedding-mismatch", scope: "pod", tone: "danger" },
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
          guidance: { code: "policy-denied", scope: "pod", tone: "danger" },
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
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText(/pod display name/i));
    });
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
    await waitFor(() => expect(document.activeElement).toBe(trigger));
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
    const trigger = screen.getByRole("button", { name: "Actions for Knowledge Pod Ready Cap" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: /disconnect Knowledge Pod ready cap/i }));
    await screen.findByRole("dialog", { name: /disconnect Knowledge Pod/i });
    return { user, trigger };
  }

  it("moves focus into the dialog (first focusable) on open", async () => {
    await openDisconnectDialog();
    const dialog = screen.getByRole("dialog", { name: /disconnect Knowledge Pod/i });
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: /cancel/i }));
    });
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

  it("re-enters the dialog when focus drops to document.body", async () => {
    await openDisconnectDialog();
    const dialog = screen.getByRole("dialog", { name: /disconnect Knowledge Pod/i });
    const cancel = within(dialog).getByRole("button", { name: /cancel/i });

    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    const notCanceled = fireEvent.keyDown(document, { key: "Tab" });

    expect(notCanceled).toBe(false);
    expect(cancel).toHaveFocus();
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const { trigger } = await openDisconnectDialog();
    const dialog = screen.getByRole("dialog", { name: /disconnect Knowledge Pod/i });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /disconnect Knowledge Pod/i })).toBeNull();
    });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
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

  it("renders the panel, counts and reason guidance in German", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
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
        removalDetection: "not-evaluated-page-limit",
        crawlRunFingerprint: "fp-de-1",
        reasonCodes: ["pages-failed", "links-denied"],
        refreshedAt: 1_700_000_100_000,
      },
    });
    render(
      <I18nProvider>
        <ConnectorGraph fetchCapsulesImpl={fetchWith([capsule])} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Letzte Aktualisierung")).toBeInTheDocument();
    expect(screen.getByText("Teilweise")).toBeInTheDocument();
    expect(screen.getByText("Abgelehnte Links")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Entfernte Seiten konnten in diesem Lauf nicht erkannt werden (der Crawl hat sein Seitenlimit erreicht).",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Einige Links wurden übersprungen, weil sie außerhalb des freigegebenen Umfangs lagen.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Last refresh")).toBeNull();
  });

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
