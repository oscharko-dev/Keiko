// Issue #211 — tests for MemoryListContent: filtering, empty/error states, entry points, a11y.
//
// KEIKO-0650: the earlier MemoryList URL-state-sync wrapper (a thin useSearchParams/useRouter
// shim around MemoryListContent) was removed as dead code once every production caller
// (MemoriaVivaWindow.tsx, MemoryJournal.tsx) moved to rendering MemoryListContent directly with
// filters/onFilterChange as explicit props. The tests below render MemoryListContent the same
// way MemoryList used to configure it (showWorkspaceBackLink) so no coverage of rows, metadata,
// empty/error states, header entry points, or a11y was lost in the migration. The "passes q from
// URL params" test was dropped outright — there is no URL parsing left in this file to test.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryListContent } from "./MemoryList";
import type { MemoryFilterState } from "./MemoryFilters";
import type { MemoryListResponse } from "@/lib/memory-api";
import type { MemoryRecord, MemoryId } from "@oscharko-dev/keiko-contracts";

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

function fetchWith(records: readonly MemoryRecord[]): () => Promise<MemoryListResponse> {
  return vi.fn().mockResolvedValue(makeListResponse(records));
}

const emptyFetch = vi.fn().mockResolvedValue(makeListResponse([]));
const emptyFilters: MemoryFilterState = {
  query: "",
  scope: [],
  type: [],
  status: [],
  sensitivity: [],
};

// The default (non-workspace-window) mode MemoryList used to configure: rows render as real
// <a href> links, and the "back to workspace" link is shown.
function renderDefaultList(
  fetchMemoriesImpl: () => Promise<MemoryListResponse>,
  filters: MemoryFilterState = emptyFilters,
): ReturnType<typeof render> {
  return render(
    <MemoryListContent
      filters={filters}
      onFilterChange={vi.fn()}
      fetchMemoriesImpl={fetchMemoriesImpl}
      showWorkspaceBackLink
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  emptyFetch.mockReset().mockResolvedValue(makeListResponse([]));
});

describe("MemoryListContent — loading state", () => {
  it("shows loading indicator initially", () => {
    renderDefaultList(fetchWith([]));
    // Two status regions exist now (loading indicator + result summary live
    // region, uiux-fix F035) — assert the visible loading message directly.
    expect(screen.getByText("Loading memories…")).toBeInTheDocument();
  });

  it("keeps the previous list visible during a refetch (stale-while-revalidate)", async () => {
    let resolveSecond: (() => void) | undefined;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeListResponse([makeRecord({ body: "Stable memory" })]))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = () => {
              resolve(makeListResponse([makeRecord({ body: "Stable memory" })]));
            };
          }),
      );
    const { rerender } = renderDefaultList(fetchImpl);
    await waitFor(() => {
      expect(screen.getByText("Stable memory")).toBeInTheDocument();
    });

    // A new `filters` object identity triggers a reload (MemoryListContent's own
    // useEffect([filters, load]) dependency), same as MemoryList's URL-identity change used to.
    rerender(
      <MemoryListContent
        filters={{ ...emptyFilters }}
        onFilterChange={vi.fn()}
        fetchMemoriesImpl={fetchImpl}
        showWorkspaceBackLink
      />,
    );

    // The old list stays rendered while the refetch is in flight — no
    // full-list replacement by the loading paragraph (uiux-fix F035).
    expect(screen.getByText("Stable memory")).toBeInTheDocument();
    expect(screen.queryByText("Loading memories…")).toBeNull();

    resolveSecond?.();
    await waitFor(() => {
      expect(screen.getByText("Stable memory")).toBeInTheDocument();
    });
  });
});

describe("MemoryListContent — empty state", () => {
  it("shows empty state when no memories returned", async () => {
    renderDefaultList(emptyFetch);
    await waitFor(() => {
      expect(screen.getByTestId("memory-empty-state")).toBeInTheDocument();
    });
  });
});

describe("MemoryListContent — populated state", () => {
  it("renders memory rows", async () => {
    const records = [
      makeRecord({ id: makeMemoryId(1), body: "Memory alpha" }),
      makeRecord({ id: makeMemoryId(2), body: "Memory beta" }),
    ];
    renderDefaultList(fetchWith(records));
    await waitFor(() => {
      expect(screen.getByText("Memory alpha")).toBeInTheDocument();
      expect(screen.getByText("Memory beta")).toBeInTheDocument();
    });
  });

  it("renders provenance, confidence, and sensitivity metadata in each row", async () => {
    const record = makeRecord({
      id: makeMemoryId(9),
      body: "Metadata memory",
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 1_700_000_000_000,
        confidence: 0.87,
        sensitivity: "confidential",
      },
    });
    renderDefaultList(fetchWith([record]));
    await waitFor(() => {
      expect(screen.getByText("Source explicit-user-instruction")).toBeInTheDocument();
      expect(screen.getByText("87% confidence")).toBeInTheDocument();
      expect(screen.getByText("Sensitivity Confidential")).toBeInTheDocument();
    });
  });

  it("links each row to /memoriaviva/detail?id=:id", async () => {
    const record = makeRecord({ id: makeMemoryId(42), body: "Linked memory" });
    renderDefaultList(fetchWith([record]));
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /linked memory/i });
      expect(link).toHaveAttribute("href", "/memoriaviva/detail?id=mem-42");
    });
  });

  it("opens rows through internal navigation in workspace-window mode", async () => {
    const onOpenDetail = vi.fn();
    const user = userEvent.setup();
    const record = makeRecord({ id: makeMemoryId(42), body: "Window memory" });
    render(
      <MemoryListContent
        filters={emptyFilters}
        onFilterChange={vi.fn()}
        fetchMemoriesImpl={fetchWith([record])}
        onOpenDetail={onOpenDetail}
        showWorkspaceBackLink={false}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /window memory/i }));
    expect(onOpenDetail).toHaveBeenCalledWith("mem-42");
    expect(screen.queryByRole("link", { name: /window memory/i })).not.toBeInTheDocument();
  });

  it("uses internal navigation buttons for secondary views in workspace-window mode", async () => {
    const onOpenJournal = vi.fn();
    const onOpenConsolidation = vi.fn();
    const onOpenReviewQueue = vi.fn();
    const onOpenHealthScan = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryListContent
        filters={emptyFilters}
        onFilterChange={vi.fn()}
        fetchMemoriesImpl={fetchWith([makeRecord()])}
        onOpenJournal={onOpenJournal}
        onOpenConsolidation={onOpenConsolidation}
        onOpenReviewQueue={onOpenReviewQueue}
        onOpenHealthScan={onOpenHealthScan}
        showWorkspaceBackLink={false}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /^journal$/i }));
    await user.click(await screen.findByRole("button", { name: /consolidation/i }));
    await user.click(screen.getByRole("button", { name: /review queue/i }));
    await user.click(screen.getByRole("button", { name: /health scan/i }));
    expect(onOpenJournal).toHaveBeenCalledTimes(1);
    expect(onOpenConsolidation).toHaveBeenCalledTimes(1);
    expect(onOpenReviewQueue).toHaveBeenCalledTimes(1);
    expect(onOpenHealthScan).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link", { name: /back to workspace/i })).not.toBeInTheDocument();
  });

  it("shows the consolidation entry point in the header", async () => {
    renderDefaultList(fetchWith([makeRecord()]));
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /consolidation/i })).toHaveAttribute(
        "href",
        "/memoriaviva/consolidation",
      );
    });
  });

  it("shows the Journal entry point in the header", async () => {
    renderDefaultList(fetchWith([makeRecord()]));
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /^journal$/i })).toHaveAttribute(
        "href",
        "/memoriaviva/journal",
      );
    });
  });

  it("shows the health scan entry point in the header", async () => {
    renderDefaultList(fetchWith([makeRecord()]));
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /health scan/i })).toHaveAttribute(
        "href",
        "/memoriaviva/health-scan",
      );
    });
  });
});

describe("MemoryListContent — error state", () => {
  it("shows error alert and retry button on fetch failure", async () => {
    const failFetch = vi.fn().mockRejectedValue(new Error("network failure"));
    renderDefaultList(failFetch);
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
    renderDefaultList(failThenSucceed);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(screen.getByText("Recovered memory")).toBeInTheDocument();
    });
  });
});

describe("MemoryListContent — a11y", () => {
  it("jest-axe: empty state has no violations", async () => {
    const { container } = renderDefaultList(emptyFetch);
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
    const { container } = renderDefaultList(fetchWith(records));
    await waitFor(() => {
      expect(screen.getByText("First memory")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
