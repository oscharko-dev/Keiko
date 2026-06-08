// Issue #542 (Epic #532) — RelationshipHealthPanel tests.
//
// Verifies the categorized health findings render with counts, non-color text labels, bounded
// rendering with an explicit cap note, truncation notices, click-to-inspect navigation, the
// healthy empty state, and the error/retry path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../../../relationships/api.js", () => ({
  getHealth: vi.fn(),
  RelationshipApiError: class RelationshipApiError extends Error {
    readonly code: string;
    readonly status: number;
    readonly reasons: readonly unknown[];
    constructor(code: string, message: string, status: number, reasons: readonly unknown[] = []) {
      super(message);
      this.code = code;
      this.status = status;
      this.reasons = reasons;
    }
  },
}));

import { getHealth, RelationshipApiError } from "../../../../relationships/api";
import { RelationshipHealthPanel } from "./RelationshipHealthPanel";

const mockGetHealth = vi.mocked(getHealth);

function emptyFindings() {
  return {
    orphanedEndpoints: [],
    orphanedEndpointsTruncated: false,
    staleRelationships: [],
    staleRelationshipsTruncated: false,
    blockedRelationships: [],
    blockedRelationshipsTruncated: false,
    failedRelationships: [],
    failedRelationshipsTruncated: false,
    invalidReferences: [],
    invalidReferencesTruncated: false,
    cycleParticipants: [],
    cycleScanTruncated: false,
  };
}

function relRef(id: string) {
  return {
    id,
    type: "depends-on" as const,
    source: { kind: "capsule" as const, id: "cap-a" },
    target: { kind: "capsule" as const, id: "cap-b" },
    lifecycle: "blocked" as const,
  };
}

const ZERO_TOTALS = {
  draft: 0,
  active: 0,
  archived: 0,
  superseded: 0,
  revoked: 0,
  blocked: 0,
  stale: 0,
};

beforeEach(() => {
  mockGetHealth.mockReset();
});

describe("RelationshipHealthPanel", () => {
  it("renders the healthy empty state when there are no findings", async () => {
    mockGetHealth.mockResolvedValue({
      checkedAt: 1_700_000_000_000,
      totals: { ...ZERO_TOTALS, active: 3 },
      truncated: false,
      findings: emptyFindings(),
    });
    render(<RelationshipHealthPanel onSelectRelationship={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Healthy")).toBeInTheDocument();
    });
    expect(screen.getByText(/No relationship-graph defects/i)).toBeInTheDocument();
  });

  it("renders a category with its count and lets the user inspect a finding", async () => {
    const onSelect = vi.fn();
    mockGetHealth.mockResolvedValue({
      checkedAt: 1_700_000_000_000,
      totals: { ...ZERO_TOTALS, blocked: 1 },
      truncated: false,
      findings: { ...emptyFindings(), blockedRelationships: [relRef("rel-blocked-1")] },
    });
    const user = userEvent.setup();
    render(<RelationshipHealthPanel onSelectRelationship={onSelect} />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Blocked/i, level: 3 })).toBeInTheDocument();
    });
    const item = screen.getByRole("button", { name: /Inspect depends-on relationship/i });
    await user.click(item);
    expect(onSelect).toHaveBeenCalledWith("rel-blocked-1");
  });

  it("states truncation when a category is server-truncated", async () => {
    mockGetHealth.mockResolvedValue({
      checkedAt: 1_700_000_000_000,
      totals: { ...ZERO_TOTALS },
      truncated: true,
      findings: {
        ...emptyFindings(),
        invalidReferences: [relRef("rel-invalid-1")],
        invalidReferencesTruncated: true,
      },
    });
    render(<RelationshipHealthPanel onSelectRelationship={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/More invalid references exist/i)).toBeInTheDocument();
    });
  });

  it("caps rendering at 50 items per category and states the cap", async () => {
    const many = Array.from({ length: 80 }, (_, i) => relRef(`rel-stale-${String(i)}`));
    mockGetHealth.mockResolvedValue({
      checkedAt: 1_700_000_000_000,
      totals: { ...ZERO_TOTALS },
      truncated: false,
      findings: { ...emptyFindings(), staleRelationships: many },
    });
    render(<RelationshipHealthPanel onSelectRelationship={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/Showing the first 50 of 80/i)).toBeInTheDocument();
    });
    // Only the capped subset is rendered as inspect buttons.
    expect(
      screen.getAllByRole("button", { name: /Inspect depends-on relationship/i }),
    ).toHaveLength(50);
  });

  it("shows an alert with retry when the health check fails", async () => {
    mockGetHealth.mockRejectedValue(
      new RelationshipApiError("relationship/health-failed", "health check failed", 500),
    );
    const user = userEvent.setup();
    render(<RelationshipHealthPanel onSelectRelationship={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("health check failed");
    });
    mockGetHealth.mockResolvedValue({
      checkedAt: 1_700_000_000_000,
      totals: { ...ZERO_TOTALS },
      truncated: false,
      findings: emptyFindings(),
    });
    await user.click(within(screen.getByRole("alert")).getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(screen.getByText("Healthy")).toBeInTheDocument();
    });
  });
});
