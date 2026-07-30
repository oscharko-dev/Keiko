// Issue #542 (Epic #532) — RelationshipHealthPanel tests.
//
// Verifies the categorized health findings render with counts, non-color text labels, bounded
// rendering with an explicit cap note, truncation notices, click-to-inspect navigation, the
// healthy empty state, and the error/retry path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

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

  // A bounded scan cannot certify a clean graph: the categories it never finished reading may
  // hold every defect there is. The panel used to render "Healthy — No relationship-graph
  // defects were found" from exactly that scan, with the truncation flags it was handed set.
  it("reports a truncated zero-finding scan as inconclusive, not healthy", async () => {
    mockGetHealth.mockResolvedValue({
      checkedAt: 1_700_000_000_000,
      totals: { ...ZERO_TOTALS, active: 2 },
      truncated: true,
      findings: { ...emptyFindings(), cycleScanTruncated: true },
    });
    render(<RelationshipHealthPanel onSelectRelationship={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("health-inconclusive")).toBeInTheDocument();
    });
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(screen.queryByText(/No relationship-graph defects were found/i)).toBeNull();
    // The inconclusive state must name which categories were left bounded.
    expect(screen.getByTestId("health-inconclusive").textContent).toMatch(/cycle participants/i);
  });

  it("still reports a clean bill of health when nothing was truncated", async () => {
    mockGetHealth.mockResolvedValue({
      checkedAt: 1_700_000_000_000,
      totals: { ...ZERO_TOTALS, active: 2 },
      truncated: false,
      findings: emptyFindings(),
    });
    render(<RelationshipHealthPanel onSelectRelationship={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Healthy")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("health-inconclusive")).toBeNull();
  });

  it("renders a truncated category count as a lower bound, not an exact figure", async () => {
    mockGetHealth.mockResolvedValue({
      checkedAt: 1_700_000_000_000,
      totals: { ...ZERO_TOTALS, blocked: 1 },
      truncated: true,
      findings: {
        ...emptyFindings(),
        blockedRelationships: [relRef("rel-blocked-1")],
        blockedRelationshipsTruncated: true,
      },
    });
    render(<RelationshipHealthPanel onSelectRelationship={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("region", { name: /Blocked \(at least 1\)/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("region", { name: /^Blocked \(1\)$/ })).toBeNull();
    // The whole-scan note states that every count below is a lower bound.
    expect(screen.getByTestId("health-partial-note")).toBeInTheDocument();
  });

  it("discloses a truncated category that returned no items at all", async () => {
    mockGetHealth.mockResolvedValue({
      checkedAt: 1_700_000_000_000,
      totals: { ...ZERO_TOTALS, blocked: 1 },
      truncated: true,
      findings: {
        ...emptyFindings(),
        blockedRelationships: [relRef("rel-blocked-1")],
        invalidReferencesTruncated: true,
        orphanedEndpointsTruncated: true,
      },
    });
    render(<RelationshipHealthPanel onSelectRelationship={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Invalid references/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: /Orphaned endpoints/i })).toBeInTheDocument();
    expect(screen.getAllByTestId("health-category-bounded-empty").length).toBe(2);
  });

  it("labels the totals as installation-wide rather than project-scoped", async () => {
    mockGetHealth.mockResolvedValue({
      checkedAt: 1_700_000_000_000,
      totals: { ...ZERO_TOTALS, active: 3 },
      truncated: false,
      findings: emptyFindings(),
    });
    render(<RelationshipHealthPanel onSelectRelationship={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("health-scope-note")).toBeInTheDocument();
    });
    expect(screen.getByTestId("health-scope-note").textContent).toMatch(/installation/i);
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

  it("passes axe on a populated findings state (GEN-UI-TEST-GAP-009)", async () => {
    mockGetHealth.mockResolvedValue({
      checkedAt: 1_700_000_000_000,
      totals: { ...ZERO_TOTALS, blocked: 1, stale: 1 },
      truncated: false,
      findings: {
        ...emptyFindings(),
        blockedRelationships: [relRef("rel-blocked-axe")],
        staleRelationships: [relRef("rel-stale-axe")],
      },
    });
    const { container } = render(<RelationshipHealthPanel onSelectRelationship={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Blocked/i, level: 3 })).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
