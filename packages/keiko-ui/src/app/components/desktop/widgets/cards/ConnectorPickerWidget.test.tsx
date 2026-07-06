// Epic #189 Slice 3 M2 — unit tests for the ConnectorPickerWidget.
//
// Tests cover: loading state, error state, empty state, capsule/capsule-set rendering,
// selection dispatch (onSelect called with correct kind+id), and the Knowledge Pod management action.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorPickerWidget } from "./ConnectorPickerWidget";
import { ApiError } from "@/lib/api";
import type {
  CapsuleListEntry,
  CapsulesResponse,
  CapsuleSetsResponse,
} from "@/lib/local-knowledge-api";

// ─── Mock the local-knowledge-api module ──────────────────────────────────────

vi.mock("@/lib/local-knowledge-api", () => ({
  capsulesForKnowledgePodUi: vi.fn((response: CapsulesResponse) => response.capsules),
  capsuleSetsForKnowledgePodUi: vi.fn((response: CapsuleSetsResponse) => response.capsuleSets),
  fetchCapsules: vi.fn(),
  fetchCapsuleSets: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { fetchCapsules, fetchCapsuleSets } from "@/lib/local-knowledge-api";

const mockFetchCapsules = vi.mocked(fetchCapsules);
const mockFetchCapsuleSets = vi.mocked(fetchCapsuleSets);

beforeEach(() => {
  mockFetchCapsules.mockReset();
  mockFetchCapsuleSets.mockReset();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const READY_CAPSULE: CapsulesResponse["capsules"][number] = {
  id: "cap-abc" as CapsulesResponse["capsules"][number]["id"],
  displayName: "My Docs",
  lifecycleState: "ready",
  sourceCount: 3,
  updatedAt: 1000,
};

const CAPSULE_SET: CapsuleSetsResponse["capsuleSets"][number] = {
  id: "set-xyz" as CapsuleSetsResponse["capsuleSets"][number]["id"],
  displayName: "All Sources",
  capsuleCount: 2,
  composedAt: 2000,
};

function defaultMocks(): void {
  mockFetchCapsules.mockResolvedValue({ capsules: [READY_CAPSULE] });
  mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [CAPSULE_SET] });
}

async function chooseComboboxOption(
  user: ReturnType<typeof userEvent.setup>,
  option: string | RegExp,
): Promise<void> {
  await user.click(await screen.findByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: option }));
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("ConnectorPickerWidget", () => {
  it("renders a dragged capsule as a compact connector node without the picker", () => {
    render(
      <ConnectorPickerWidget
        presentation="node"
        selectedKind="capsule"
        selectedId="cap-abc"
        selectedLabel="First KC"
        selectedState="ready"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId("knowledge-connector-node")).toBeInTheDocument();
    expect(screen.getByText("First KC")).toBeInTheDocument();
    expect(screen.getByText("Indexed")).toBeInTheDocument();
    expect(screen.getByText("Local Knowledge Pod")).toBeInTheDocument();
    expect(screen.queryByText("cap-abc")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(mockFetchCapsules).not.toHaveBeenCalled();
    expect(mockFetchCapsuleSets).not.toHaveBeenCalled();
  });

  it("shows a loading state initially", () => {
    mockFetchCapsules.mockReturnValue(new Promise(() => undefined));
    mockFetchCapsuleSets.mockReturnValue(new Promise(() => undefined));
    render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Knowledge Pods");
  });

  it("renders a capsule and capsule-set in the select after load", async () => {
    defaultMocks();
    render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: /My Docs/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /All Sources/i })).toBeInTheDocument();
    expect(mockFetchCapsules).toHaveBeenCalledWith({ includeKnowledgePods: true });
    expect(mockFetchCapsuleSets).toHaveBeenCalledWith({ includeKnowledgePods: true });
  });

  it("calls onSelect with kind=capsule when user selects a capsule", async () => {
    defaultMocks();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorPickerWidget onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
    await chooseComboboxOption(user, /My Docs/i);
    expect(onSelect).toHaveBeenCalledWith({ selectedKind: "capsule", selectedId: "cap-abc" });
  });

  it("calls onSelect with kind=capsule-set when user selects a capsule-set", async () => {
    defaultMocks();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorPickerWidget onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
    await chooseComboboxOption(user, /All Sources/i);
    expect(onSelect).toHaveBeenCalledWith({ selectedKind: "capsule-set", selectedId: "set-xyz" });
  });

  it("shows the selected connector label via role=status", async () => {
    defaultMocks();
    render(
      <ConnectorPickerWidget selectedKind="capsule" selectedId="cap-abc" onSelect={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
    const statuses = screen.getAllByRole("status");
    const badge = statuses.find((el) => el.textContent?.includes("My Docs"));
    expect(badge).not.toBeUndefined();
  });

  it("surfaces Knowledge Pod embedding guidance in selected and option states", async () => {
    const guidedCapsule: CapsuleListEntry = {
      ...READY_CAPSULE,
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
    };
    mockFetchCapsules.mockResolvedValue({ capsules: [guidedCapsule] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    const user = userEvent.setup();
    render(
      <ConnectorPickerWidget selectedKind="capsule" selectedId="cap-abc" onSelect={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
    const selectedStatuses = screen.getAllByRole("status");
    const selectedBadge = selectedStatuses.find((el) =>
      el.textContent?.includes("Embedding mismatch"),
    );
    expect(selectedBadge).not.toBeUndefined();
    expect(
      screen.getAllByText(
        "Semantic retrieval is disabled for this pod until it is reindexed locally.",
      ),
    ).toHaveLength(2);

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: /Embedding mismatch/i })).toBeInTheDocument();
  });

  it("shows an empty state with a 'Create' action when no Knowledge Pods exist", async () => {
    mockFetchCapsules.mockResolvedValue({ capsules: [] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    const onManageConnectors = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorPickerWidget onSelect={vi.fn()} onManageConnectors={onManageConnectors} />);
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: /loading/i })).toBeNull();
    });
    expect(screen.queryByText(/No ready Knowledge Pods/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Create a Knowledge Pod/i })).toHaveClass(
      "lk-btn-primary",
    );
    await user.click(screen.getByRole("button", { name: /Create a Knowledge Pod/i }));
    expect(onManageConnectors).toHaveBeenCalledTimes(1);
  });

  it("shows a 'Create or manage Knowledge Pods' action in normal state", async () => {
    defaultMocks();
    const onManageConnectors = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorPickerWidget onSelect={vi.fn()} onManageConnectors={onManageConnectors} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Create or manage Knowledge Pods/i }));
    expect(onManageConnectors).toHaveBeenCalledTimes(1);
  });

  it("shows an error message via role=alert when fetch fails", async () => {
    mockFetchCapsules.mockRejectedValue(new Error("network error"));
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("network error");
    });
  });

  it("shows local-knowledge unavailable diagnostics with recovery guidance", async () => {
    const error = new ApiError(
      "LOCAL_KNOWLEDGE_UNAVAILABLE",
      "Local knowledge storage is unavailable.",
      503,
    );
    error.correlationId = "lk-unavailable-1";
    mockFetchCapsules.mockRejectedValue(error);
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });

    render(<ConnectorPickerWidget onSelect={vi.fn()} />);

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Local knowledge storage is unavailable.");
      expect(alert).toHaveTextContent("Restart Keiko, reopen Local Knowledge, then try again.");
      expect(alert).toHaveTextContent("LOCAL_KNOWLEDGE_UNAVAILABLE; support ID lk-unavailable-1");
    });
  });
});

describe("ConnectorPickerWidget — a11y (GEN-UI-A11Y-018 / test-plan #28)", () => {
  it("renders the connector-node title as a non-heading (no orphan heading)", () => {
    render(
      <ConnectorPickerWidget
        presentation="node"
        selectedKind="capsule"
        selectedId="cap-abc"
        selectedLabel="First KC"
        selectedState="ready"
        onSelect={vi.fn()}
      />,
    );
    // The title carries its class but must NOT be a heading — a compact leaf card
    // has no sectioning context, so an <h2> would be an orphan heading.
    const title = screen.getByText("First KC");
    expect(title.tagName).toBe("P");
    expect(title).toHaveClass("connector-node-title");
    expect(screen.queryByRole("heading", { name: "First KC" })).toBeNull();
  });

  it("jest-axe: connector-node (presentation=node) has no violations", async () => {
    const { container } = render(
      <ConnectorPickerWidget
        presentation="node"
        selectedKind="capsule"
        selectedId="cap-abc"
        selectedLabel="First KC"
        selectedState="ready"
        onSelect={vi.fn()}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: loaded list state has no violations", async () => {
    defaultMocks();
    const { container } = render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: empty state has no violations", async () => {
    mockFetchCapsules.mockResolvedValue({ capsules: [] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    const { container } = render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Create a Knowledge Pod/i })).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: error state has no violations", async () => {
    mockFetchCapsules.mockRejectedValue(new Error("network error"));
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    const { container } = render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("network error");
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
