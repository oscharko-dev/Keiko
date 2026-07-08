// Issue #2129 — tests for HealthScanFindings: loading, empty state, all 4 finding kinds, a11y.

import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthScanFindings } from "./HealthScanFindings";
import { I18N_STORAGE_KEY } from "@/lib/i18n";
import type {
  MemoryHealthScanFindingWire,
  MemoryHealthScanResultWire,
  MemoryId,
} from "@oscharko-dev/keiko-contracts";

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeId(n: number): MemoryId {
  return `mem-h-${n.toString()}` as MemoryId;
}

function makeFinding(
  overrides: Partial<MemoryHealthScanFindingWire> = {},
): MemoryHealthScanFindingWire {
  return {
    id: "finding-1",
    kind: "orphan-memory",
    memories: [{ memoryId: makeId(1), type: "preference", status: "accepted" }],
    reason: "No incoming or outgoing edges after 30 days",
    detectedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function resultWith(findings: readonly MemoryHealthScanFindingWire[]): MemoryHealthScanResultWire {
  return { findings, recordsInspected: 42, truncated: false };
}

function scanWith(result: MemoryHealthScanResultWire): () => Promise<MemoryHealthScanResultWire> {
  return vi.fn().mockResolvedValue(result);
}

const emptyScan = () => vi.fn().mockResolvedValue(resultWith([]));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  window.localStorage.removeItem(I18N_STORAGE_KEY);
});

describe("HealthScanFindings — loading state", () => {
  it("shows a loading indicator while the scan result is in flight", () => {
    render(<HealthScanFindings fetchImpl={() => new Promise(() => {})} />);
    expect(screen.getByText("Loading health scan findings...")).toBeInTheDocument();
  });
});

describe("HealthScanFindings — empty state", () => {
  it("shows no-issues message when there are no findings", async () => {
    render(<HealthScanFindings fetchImpl={emptyScan()} />);
    await waitFor(() => {
      expect(screen.getByTestId("health-scan-empty")).toBeInTheDocument();
    });
    expect(screen.getByText("No issues found")).toBeInTheDocument();
  });
});

describe("HealthScanFindings — load error", () => {
  it("shows alert and retry button when fetch fails", async () => {
    const failFetch = vi.fn().mockRejectedValue(new Error("scan load failed"));
    render(<HealthScanFindings fetchImpl={failFetch} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/scan load failed/i)).toBeInTheDocument();
    });
  });
});

describe("HealthScanFindings — populated state", () => {
  it("renders all four finding kinds with their referenced memories and reason", async () => {
    const findings = [
      makeFinding({
        id: "f-orphan",
        kind: "orphan-memory",
        memories: [{ memoryId: makeId(1), type: "preference", status: "accepted" }],
        reason: "No incoming or outgoing edges after 30 days",
      }),
      makeFinding({
        id: "f-missing-ref",
        kind: "missing-cross-reference",
        memories: [{ memoryId: makeId(2), type: "decision", status: "proposed" }],
        reason: "Referenced supersession target does not exist",
      }),
      makeFinding({
        id: "f-stale",
        kind: "stale-not-archived",
        memories: [{ memoryId: makeId(3), type: "episodic", status: "expired" }],
        reason: "Confidence below threshold for 90 days without archival",
      }),
      makeFinding({
        id: "f-dangling",
        kind: "dangling-review-item",
        memories: [{ memoryId: makeId(4), type: "correction", status: "conflicted" }],
        reason: "Review item references a consolidation job that no longer exists",
      }),
    ];
    render(<HealthScanFindings fetchImpl={scanWith(resultWith(findings))} />);

    await waitFor(() => {
      expect(screen.getByText("Orphan memory")).toBeInTheDocument();
    });
    expect(screen.getByText("Missing cross-reference")).toBeInTheDocument();
    expect(screen.getByText("Stale, not archived")).toBeInTheDocument();
    expect(screen.getByText("Dangling review item")).toBeInTheDocument();

    expect(screen.getByText(/No incoming or outgoing edges after 30 days/)).toBeInTheDocument();
    expect(
      screen.getByText(/Review item references a consolidation job that no longer exists/),
    ).toBeInTheDocument();

    expect(screen.getByText(makeId(1))).toBeInTheDocument();
    expect(screen.getByText(makeId(4))).toBeInTheDocument();
    expect(screen.getByText("4 findings")).toBeInTheDocument();
  });

  it("shows recordsInspected and a truncated notice when the scan was truncated", async () => {
    const result: MemoryHealthScanResultWire = {
      findings: [makeFinding()],
      recordsInspected: 1_000,
      truncated: true,
    };
    render(<HealthScanFindings fetchImpl={scanWith(result)} />);
    await waitFor(() => {
      expect(screen.getByText(/1000 records inspected/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Results truncated/)).toBeInTheDocument();
  });

  it("links a referenced memory to the detail view via onOpenDetail", async () => {
    const onOpenDetail = vi.fn();
    const finding = makeFinding({
      memories: [{ memoryId: makeId(9), type: "pinned", status: "accepted" }],
    });
    render(
      <HealthScanFindings
        fetchImpl={scanWith(resultWith([finding]))}
        onOpenDetail={onOpenDetail}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(makeId(9))).toBeInTheDocument();
    });
    screen.getByText(makeId(9)).click();
    expect(onOpenDetail).toHaveBeenCalledWith(makeId(9));
  });
});

describe("HealthScanFindings — a11y", () => {
  it("jest-axe: empty state has no violations", async () => {
    const { container } = render(<HealthScanFindings fetchImpl={emptyScan()} />);
    await waitFor(() => {
      expect(screen.getByTestId("health-scan-empty")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: populated state has no violations", async () => {
    const findings = [
      makeFinding({ id: "f-1", kind: "orphan-memory" }),
      makeFinding({
        id: "f-2",
        kind: "dangling-review-item",
        memories: [{ memoryId: makeId(5), type: "decision", status: "conflicted" }],
        reason: "Dangling review item",
      }),
    ];
    const { container } = render(<HealthScanFindings fetchImpl={scanWith(resultWith(findings))} />);
    await waitFor(() => {
      expect(screen.getByText("Orphan memory")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
