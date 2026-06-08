// Issue #211 — tests for MemoryList: filtering, URL-state sync, empty states, errors.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryList } from "./MemoryList";
import type { MemoryListResponse } from "@/lib/memory-api";
import type { MemoryRecord, MemoryId } from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// next/navigation mock (required for useSearchParams / useRouter)
// ---------------------------------------------------------------------------

const pushMock = vi.fn();
const searchParamsMock = { get: vi.fn().mockReturnValue(null) };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => searchParamsMock,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMemoryId(n: number): MemoryId {
  return `mem-${n.toString()}` as MemoryId;
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: makeMemoryId(1),
    schemaVersion: "1",
    scope: { kind: "global" },
    type: "preference",
    body: "Always use TypeScript strict mode.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 1_700_000_000_000,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: 1_700_000_000_000 },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeListResponse(records: readonly MemoryRecord[]): MemoryListResponse {
  return { memories: records, total: records.length, limit: 50, offset: 0 };
}

function fetchWith(records: readonly MemoryRecord[]) {
  return vi.fn().mockResolvedValue(makeListResponse(records));
}

const emptyFetch = vi.fn().mockResolvedValue(makeListResponse([]));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  pushMock.mockReset();
  emptyFetch.mockReset().mockResolvedValue(makeListResponse([]));
  searchParamsMock.get.mockReturnValue(null);
});

describe("MemoryList — loading state", () => {
  it("shows loading indicator initially", () => {
    render(<MemoryList fetchMemoriesImpl={fetchWith([])} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("MemoryList — empty state", () => {
  it("shows empty state when no memories returned", async () => {
    render(<MemoryList fetchMemoriesImpl={emptyFetch} />);
    await waitFor(() => {
      expect(screen.getByTestId("memory-empty-state")).toBeInTheDocument();
    });
  });
});

describe("MemoryList — populated state", () => {
  it("renders memory rows", async () => {
    const records = [
      makeRecord({ id: makeMemoryId(1), body: "Memory alpha" }),
      makeRecord({ id: makeMemoryId(2), body: "Memory beta" }),
    ];
    render(<MemoryList fetchMemoriesImpl={fetchWith(records)} />);
    await waitFor(() => {
      expect(screen.getByText("Memory alpha")).toBeInTheDocument();
      expect(screen.getByText("Memory beta")).toBeInTheDocument();
    });
  });

  it("links each row to /memoriaviva/detail?id=:id", async () => {
    const record = makeRecord({ id: makeMemoryId(42), body: "Linked memory" });
    render(<MemoryList fetchMemoriesImpl={fetchWith([record])} />);
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /linked memory/i });
      expect(link).toHaveAttribute("href", "/memoriaviva/detail?id=mem-42");
    });
  });

  it("shows the consolidation entry point in the header", async () => {
    render(<MemoryList fetchMemoriesImpl={fetchWith([makeRecord()])} />);
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /consolidation/i })).toHaveAttribute(
        "href",
        "/memoriaviva/consolidation",
      );
    });
  });
});

describe("MemoryList — error state", () => {
  it("shows error alert and retry button on fetch failure", async () => {
    const failFetch = vi.fn().mockRejectedValue(new Error("network failure"));
    render(<MemoryList fetchMemoriesImpl={failFetch} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/network failure/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });
  });

  it("retries fetch when Retry is clicked", async () => {
    const failThenSucceed = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValue(makeListResponse([makeRecord({ body: "Recovered memory" })]));

    const user = userEvent.setup();
    render(<MemoryList fetchMemoriesImpl={failThenSucceed} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(screen.getByText("Recovered memory")).toBeInTheDocument();
    });
  });
});

describe("MemoryList — a11y", () => {
  it("jest-axe: empty state has no violations", async () => {
    const { container } = render(<MemoryList fetchMemoriesImpl={emptyFetch} />);
    await waitFor(() => {
      expect(screen.getByTestId("memory-empty-state")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: populated list has no violations", async () => {
    const records = [
      makeRecord({ id: makeMemoryId(1), body: "First memory" }),
      makeRecord({ id: makeMemoryId(2), body: "Second memory", status: "proposed" }),
    ];
    const { container } = render(<MemoryList fetchMemoriesImpl={fetchWith(records)} />);
    await waitFor(() => {
      expect(screen.getByText("First memory")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
