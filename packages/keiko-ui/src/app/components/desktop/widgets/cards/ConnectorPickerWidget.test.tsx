// Epic #189 Slice 3 M2 — unit tests for the ConnectorPickerWidget.
//
// Tests cover: loading state, error state, empty state, capsule/capsule-set rendering,
// selection dispatch (onSelect called with correct kind+id), and the Knowledge Pod management action.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";
import { clearKnowledgeCatalogCacheForTests } from "../../knowledge-catalog";
import { ConnectorPickerWidget } from "./ConnectorPickerWidget";
import type {
  CapsuleListEntry,
  CapsuleSetListEntry,
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
  clearKnowledgeCatalogCacheForTests();
  mockFetchCapsules.mockReset();
  mockFetchCapsuleSets.mockReset();
});

afterEach(() => {
  window.localStorage.removeItem(I18N_STORAGE_KEY);
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
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    await chooseComboboxOption(user, /My Docs/i);
    expect(onSelect).toHaveBeenCalledWith({ selectedKind: "capsule", selectedId: "cap-abc" });
  });

  it("calls onSelect with kind=capsule-set when user selects a capsule-set", async () => {
    defaultMocks();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorPickerWidget onSelect={onSelect} />);
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    await chooseComboboxOption(user, /All Sources/i);
    expect(onSelect).toHaveBeenCalledWith({ selectedKind: "capsule-set", selectedId: "set-xyz" });
  });

  it("shows the selected connector label via role=status", async () => {
    defaultMocks();
    render(
      <ConnectorPickerWidget selectedKind="capsule" selectedId="cap-abc" onSelect={vi.fn()} />,
    );
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
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
        guidance: { code: "embedding-mismatch", scope: "pod", tone: "danger" },
      },
    };
    mockFetchCapsules.mockResolvedValue({ capsules: [guidedCapsule] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    const user = userEvent.setup();
    render(
      <ConnectorPickerWidget selectedKind="capsule" selectedId="cap-abc" onSelect={vi.fn()} />,
    );

    expect(await screen.findByRole("combobox")).toBeInTheDocument();
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

  it("surfaces Knowledge Pod Set readiness guidance in selected and option states", async () => {
    const guidedSet: CapsuleSetListEntry = {
      ...CAPSULE_SET,
      knowledgePod: {
        readiness: "degraded",
        setReadiness: {
          readyCount: 1,
          draftCount: 0,
          degradedCount: 0,
          unavailableCount: 1,
          deniedCount: 0,
          indexingCount: 0,
          staleCount: 0,
          errorCount: 0,
          missingCount: 1,
          reasonCodes: ["missing-member"],
        },
        reindexRecommended: false,
        queryEmbeddingAllowed: false,
        guidance: { code: "members-unavailable", scope: "pod-set", tone: "danger" },
      },
    };
    mockFetchCapsules.mockResolvedValue({ capsules: [] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [guidedSet] });
    const user = userEvent.setup();
    render(
      <ConnectorPickerWidget selectedKind="capsule-set" selectedId="set-xyz" onSelect={vi.fn()} />,
    );

    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    const selectedStatuses = screen.getAllByRole("status");
    const selectedBadge = selectedStatuses.find((el) =>
      el.textContent?.includes("Members unavailable"),
    );
    expect(selectedBadge).not.toBeUndefined();
    expect(
      screen.getAllByText(
        "Some set members are missing, failed, or unavailable; retrieval will use only available members.",
      ),
    ).toHaveLength(2);

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: /Members unavailable/i })).toBeInTheDocument();
  });

  // Audit regression (0.3.0): Knowledge Pods were filtered to `lifecycleState === "ready"` but
  // Knowledge Pod Sets were not filtered at all, so a failed set — or one with no members left — was
  // offered in the grounding picker as if it could answer.
  it.each([
    ["error" as const, 2],
    ["unavailable" as const, 2],
    ["indexing" as const, 2],
    ["draft" as const, 2],
    ["stale" as const, 2],
  ])(
    "does not offer a Knowledge Pod Set whose readiness is %s",
    async (readiness, capsuleCount) => {
      const unusableSet: CapsuleSetListEntry = {
        ...CAPSULE_SET,
        capsuleCount,
        knowledgePod: { readiness, reindexRecommended: false, queryEmbeddingAllowed: false },
      };
      mockFetchCapsules.mockResolvedValue({ capsules: [READY_CAPSULE] });
      mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [unusableSet] });
      const user = userEvent.setup();
      render(<ConnectorPickerWidget onSelect={vi.fn()} />);
      expect(await screen.findByRole("combobox")).toBeInTheDocument();
      await user.click(screen.getByRole("combobox"));
      expect(screen.queryByRole("option", { name: /All Sources/i })).toBeNull();
    },
  );

  it("does not offer a Knowledge Pod Set with no members", async () => {
    const emptySet: CapsuleSetListEntry = { ...CAPSULE_SET, capsuleCount: 0 };
    mockFetchCapsules.mockResolvedValue({ capsules: [READY_CAPSULE] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [emptySet] });
    const user = userEvent.setup();
    render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("option", { name: /All Sources/i })).toBeNull();
  });

  it("says how many Knowledge Pod Sets it withheld instead of letting them vanish", async () => {
    const unusableSet: CapsuleSetListEntry = {
      ...CAPSULE_SET,
      knowledgePod: {
        readiness: "error",
        reindexRecommended: false,
        queryEmbeddingAllowed: false,
      },
    };
    mockFetchCapsules.mockResolvedValue({ capsules: [READY_CAPSULE] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [unusableSet] });
    render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    expect(screen.getByText(/1 Knowledge Pod Sets are not ready/i)).toBeInTheDocument();
  });

  it("still offers a degraded Knowledge Pod Set (every member is ready; guidance explains the rest)", async () => {
    const degradedSet: CapsuleSetListEntry = {
      ...CAPSULE_SET,
      knowledgePod: {
        readiness: "degraded",
        reindexRecommended: true,
        queryEmbeddingAllowed: false,
      },
    };
    mockFetchCapsules.mockResolvedValue({ capsules: [] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [degradedSet] });
    const user = userEvent.setup();
    render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: /All Sources/i })).toBeInTheDocument();
    expect(screen.queryByText(/are not ready/i)).toBeNull();
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

  it("localizes the picker and its options when German is selected", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    defaultMocks();
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <ConnectorPickerWidget onSelect={vi.fn()} />
      </I18nProvider>,
    );
    const combobox = await screen.findByRole("combobox", {
      name: "Knowledge-Pod-Quelle auswählen",
    });
    expect(combobox).toHaveTextContent("— Knowledge-Pod-Quelle wählen —");
    expect(
      screen.getByRole("button", { name: "Knowledge Pods erstellen oder verwalten" }),
    ).toBeInTheDocument();
    await user.click(combobox);
    expect(screen.getByRole("option", { name: /My Docs \(Bereit\)/u })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /All Sources \(2 Pods\)/u })).toBeInTheDocument();
  });

  it("localizes the connector node when German is selected", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <ConnectorPickerWidget
          presentation="node"
          selectedKind="capsule"
          selectedId="cap-abc"
          selectedLabel="First KC"
          selectedState="stale"
          onSelect={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText("Veraltet")).toBeInTheDocument();
    expect(screen.getByText("Lokaler Knowledge Pod")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verwalten" })).toBeInTheDocument();
  });

  it("localizes the empty, loading and failure states when German is selected", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    mockFetchCapsules.mockResolvedValue({ capsules: [] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    const { unmount } = render(
      <I18nProvider>
        <ConnectorPickerWidget onSelect={vi.fn()} />
      </I18nProvider>,
    );
    expect(
      await screen.findByRole("button", { name: "Knowledge Pod erstellen" }),
    ).toBeInTheDocument();
    unmount();

    mockFetchCapsules.mockReturnValue(new Promise(() => undefined));
    const loading = render(
      <I18nProvider>
        <ConnectorPickerWidget onSelect={vi.fn()} />
      </I18nProvider>,
    );
    expect(await screen.findByText("Knowledge Pods werden geladen…")).toBeInTheDocument();
    loading.unmount();

    mockFetchCapsules.mockRejectedValue("offline");
    render(
      <I18nProvider>
        <ConnectorPickerWidget onSelect={vi.fn()} />
      </I18nProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Knowledge Pods konnten nicht geladen werden.",
    );
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
  });

  it("shows a 'Create or manage Knowledge Pods' action in normal state", async () => {
    defaultMocks();
    const onManageConnectors = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorPickerWidget onSelect={vi.fn()} onManageConnectors={onManageConnectors} />);
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
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
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
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

// PR #3678 audit O8 — a selected Knowledge Pod that is indexing, stale or failed is not a selectable
// option, but it still exists: the picker must name it and its real state (as the chat already
// does), never as an English "Knowledge Pod <raw id>", and the connector node must follow the shared
// catalog instead of the label and state frozen into its cfg when it was dropped.
const INDEXING_CAPSULE: CapsulesResponse["capsules"][number] = {
  id: "cap-idx" as CapsulesResponse["capsules"][number]["id"],
  displayName: "Handbook",
  lifecycleState: "indexing",
  sourceCount: 1,
  updatedAt: 3000,
};

describe("ConnectorPickerWidget — selected Knowledge Pod that is not ready", () => {
  it("names a selected indexing pod and its real state, without offering it", async () => {
    mockFetchCapsules.mockResolvedValue({ capsules: [READY_CAPSULE, INDEXING_CAPSULE] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    const user = userEvent.setup();
    render(
      <ConnectorPickerWidget selectedKind="capsule" selectedId="cap-idx" onSelect={vi.fn()} />,
    );

    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    const badge = screen.getAllByRole("status").find((el) => el.textContent?.includes("Handbook"));
    expect(badge).toHaveTextContent("Handbook (Indexing)");
    expect(screen.queryByText(/cap-idx/u)).toBeNull();

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: /My Docs/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Handbook/i })).toBeNull();
  });

  it("names the pod in German while it is indexing", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    mockFetchCapsules.mockResolvedValue({ capsules: [READY_CAPSULE, INDEXING_CAPSULE] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    render(
      <I18nProvider>
        <ConnectorPickerWidget selectedKind="capsule" selectedId="cap-idx" onSelect={vi.fn()} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Handbook (Wird indexiert)")).toBeInTheDocument();
  });

  it("shows the state of a selected pod even when no other pod is ready", async () => {
    mockFetchCapsules.mockResolvedValue({ capsules: [INDEXING_CAPSULE] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    render(
      <ConnectorPickerWidget selectedKind="capsule" selectedId="cap-idx" onSelect={vi.fn()} />,
    );

    expect(await screen.findByText("Handbook (Indexing)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create a Knowledge Pod/i })).toBeInTheDocument();
  });

  it("names a selected Knowledge Pod Set that is withheld, with its readiness", async () => {
    const failedSet: CapsuleSetListEntry = {
      ...CAPSULE_SET,
      knowledgePod: { readiness: "error", reindexRecommended: false, queryEmbeddingAllowed: false },
    };
    mockFetchCapsules.mockResolvedValue({ capsules: [READY_CAPSULE] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [failedSet] });
    render(
      <ConnectorPickerWidget selectedKind="capsule-set" selectedId="set-xyz" onSelect={vi.fn()} />,
    );

    expect(await screen.findByText("All Sources (Failed)")).toBeInTheDocument();
    expect(screen.queryByText(/set-xyz/u)).toBeNull();
  });

  it("never shows a raw id for a selection the catalog does not list", async () => {
    mockFetchCapsules.mockResolvedValue({ capsules: [READY_CAPSULE] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [CAPSULE_SET] });
    const { unmount } = render(
      <ConnectorPickerWidget selectedKind="capsule" selectedId="cap-gone" onSelect={vi.fn()} />,
    );
    expect(await screen.findByText("Knowledge Pod (unavailable)")).toBeInTheDocument();
    expect(screen.queryByText(/cap-gone/u)).toBeNull();
    unmount();

    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <ConnectorPickerWidget
          selectedKind="capsule-set"
          selectedId="set-gone"
          onSelect={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText("Knowledge Pod Set (nicht verfügbar)")).toBeInTheDocument();
    expect(screen.queryByText(/set-gone/u)).toBeNull();
  });

  it("renders the selected guidance and the option badge in German", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    const guidedCapsule: CapsuleListEntry = {
      ...READY_CAPSULE,
      knowledgePod: {
        readiness: "degraded",
        embeddingCompatibilityStatus: "incompatible",
        reindexRecommended: true,
        queryEmbeddingAllowed: false,
        guidance: { code: "embedding-mismatch", scope: "pod", tone: "danger" },
      },
    };
    mockFetchCapsules.mockResolvedValue({ capsules: [guidedCapsule] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <ConnectorPickerWidget selectedKind="capsule" selectedId="cap-abc" onSelect={vi.fn()} />
      </I18nProvider>,
    );

    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    expect(
      await screen.findAllByText(
        "Die semantische Suche ist für diesen Pod deaktiviert, bis er lokal neu indexiert wird.",
      ),
    ).toHaveLength(2);
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: /Embedding-Abweichung/u })).toBeInTheDocument();
    expect(screen.getByText("Knowledge Pods")).toBeInTheDocument();
  });
});

describe("ConnectorPickerWidget — connector node follows the shared catalog", () => {
  const nodeProps = {
    presentation: "node",
    selectedKind: "capsule",
    selectedId: "cap-abc",
    selectedLabel: "Old name",
    selectedState: "ready",
    onSelect: vi.fn(),
  } as const;

  it("reads the current name and state instead of the values frozen at drop time", async () => {
    mockFetchCapsules.mockResolvedValue({
      capsules: [{ ...READY_CAPSULE, displayName: "Renamed", lifecycleState: "indexing" }],
    });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    render(<ConnectorPickerWidget {...nodeProps} />);

    expect(await screen.findByText("Renamed")).toBeInTheDocument();
    expect(screen.getByText("Indexing")).toBeInTheDocument();
    expect(screen.queryByText("Old name")).toBeNull();
    expect(screen.queryByText("Indexed")).toBeNull();
  });

  it("localizes the refreshed state in German", async () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    mockFetchCapsules.mockResolvedValue({
      capsules: [{ ...READY_CAPSULE, lifecycleState: "stale" }],
    });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    render(
      <I18nProvider>
        <ConnectorPickerWidget {...nodeProps} />
      </I18nProvider>,
    );

    expect(await screen.findByText("Veraltet")).toBeInTheDocument();
  });

  it("says the pod is unavailable once the catalog no longer lists it", async () => {
    mockFetchCapsules.mockResolvedValue({ capsules: [] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    render(<ConnectorPickerWidget {...nodeProps} />);

    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("Old name")).toBeInTheDocument();
    expect(screen.queryByText("Indexed")).toBeNull();
  });

  it("keeps the dropped label and state while the catalog cannot be read", async () => {
    mockFetchCapsules.mockRejectedValue(new Error("offline"));
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    render(<ConnectorPickerWidget {...nodeProps} />);

    await waitFor(() => {
      expect(mockFetchCapsules).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Old name")).toBeInTheDocument();
    expect(screen.getByText("Indexed")).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).toBeNull();
  });

  it("asks the catalog once for any number of nodes", async () => {
    mockFetchCapsules.mockResolvedValue({ capsules: [READY_CAPSULE] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    render(
      <>
        <ConnectorPickerWidget {...nodeProps} />
        <ConnectorPickerWidget {...nodeProps} />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("My Docs")).toHaveLength(2);
    });
    expect(mockFetchCapsules).toHaveBeenCalledTimes(1);
    expect(mockFetchCapsuleSets).toHaveBeenCalledTimes(1);
  });
});
