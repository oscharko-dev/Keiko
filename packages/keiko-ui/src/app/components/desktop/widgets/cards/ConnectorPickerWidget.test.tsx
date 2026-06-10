// Epic #189 Slice 3 M2 — unit tests for the ConnectorPickerWidget.
//
// Tests cover: loading state, error state, empty state, capsule/capsule-set rendering,
// selection dispatch (onSelect called with correct kind+id), "create connector" link presence.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectorPickerWidget } from "./ConnectorPickerWidget";
import type { CapsulesResponse, CapsuleSetsResponse } from "@/lib/local-knowledge-api";

// ─── Mock the local-knowledge-api module ──────────────────────────────────────

vi.mock("@/lib/local-knowledge-api", () => ({
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

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("ConnectorPickerWidget", () => {
  it("shows a loading state initially", () => {
    mockFetchCapsules.mockReturnValue(new Promise(() => undefined));
    mockFetchCapsuleSets.mockReturnValue(new Promise(() => undefined));
    render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading connectors");
  });

  it("renders a capsule and capsule-set in the select after load", async () => {
    defaultMocks();
    render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });
    const options = screen.getAllByRole("option");
    const optionTexts = options.map((o) => o.textContent ?? "");
    expect(optionTexts.some((t) => t.includes("My Docs"))).toBe(true);
    expect(optionTexts.some((t) => t.includes("All Sources"))).toBe(true);
  });

  it("calls onSelect with kind=capsule when user selects a capsule", async () => {
    defaultMocks();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorPickerWidget onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
    await user.selectOptions(screen.getByRole("combobox"), "capsule:cap-abc");
    expect(onSelect).toHaveBeenCalledWith({ selectedKind: "capsule", selectedId: "cap-abc" });
  });

  it("calls onSelect with kind=capsule-set when user selects a capsule-set", async () => {
    defaultMocks();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ConnectorPickerWidget onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
    await user.selectOptions(screen.getByRole("combobox"), "capsule-set:set-xyz");
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

  it("shows an empty state with a 'Create' link when no connectors exist", async () => {
    mockFetchCapsules.mockResolvedValue({ capsules: [] });
    mockFetchCapsuleSets.mockResolvedValue({ capsuleSets: [] });
    render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: /loading/i })).toBeNull();
    });
    expect(screen.getByText(/No ready connectors/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create a connector/i })).toBeInTheDocument();
  });

  it("shows a 'Create or manage connectors' link in normal state", async () => {
    defaultMocks();
    render(<ConnectorPickerWidget onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Create or manage connectors/i })).toBeInTheDocument();
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
