// Issue #198 — unit tests for the CapsuleDetail component.
// Uses vitest + React Testing Library (jsdom) matching connector-graph.test.tsx pattern.
// next/navigation is mocked so useSearchParams() resolves without a real Next.js router.
// All fetch calls go through the injectable fetchDetailImpl seam.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapsuleDetail } from "./capsule-detail";
import type { CapsuleDetail as CapsuleDetailData } from "@/lib/local-knowledge-api";
import type {
  KnowledgeCapsuleId,
  KnowledgeCapsule,
  CapsuleHealth,
} from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// Mock next/navigation so useSearchParams() resolves synchronously in jsdom
// ---------------------------------------------------------------------------

let mockSearchParams = new URLSearchParams("capsuleId=cap-test-1");

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/local-knowledge/capsule",
}));

afterEach(() => {
  mockSearchParams = new URLSearchParams("capsuleId=cap-test-1");
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCapsuleId(suffix: string): KnowledgeCapsuleId {
  return `cap-${suffix}` as KnowledgeCapsuleId;
}

const BASE_CAPSULE: KnowledgeCapsule = {
  id: makeCapsuleId("test-1"),
  displayName: "My Test Capsule",
  description: "A capsule for testing",
  tags: ["docs", "internal"],
  sourceIds: [],
  retrievalEffort: "default",
  outputMode: "snippets",
  answerGroundingPolicy: "require-citations",
  embeddingModelIdentity: {
    provider: "openai",
    modelId: "text-embedding-3-small",
    vectorDimensions: 1536,
    vectorMetric: "cosine",
  },
  lifecycleState: "ready",
  storageReference: "capsules/cap-test-1",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
};

const BASE_HEALTH: CapsuleHealth = {
  capsuleId: makeCapsuleId("test-1"),
  lifecycleState: "ready",
  storageSizeBytes: 1_048_576,
  documentCount: 10,
  chunkCount: 50,
  vectorCount: 50,
  lastIndexedAt: 1_700_000_100_000,
  embeddingIdentity: BASE_CAPSULE.embeddingModelIdentity,
  vectorCompatible: true,
  failedDocuments: 0,
  skippedDocuments: 0,
  unsupportedDocuments: 0,
  unsupportedGuidance: [],
  staleReasons: [],
};

const FULL_DETAIL: CapsuleDetailData = {
  capsule: BASE_CAPSULE,
  health: BASE_HEALTH,
  sources: [
    {
      sourceId: "src-1",
      displayName: "Project Docs",
      scope: { kind: "folder", rootPath: "/docs", recursive: true },
      // Use distinct counts from the job below so getByText doesn't find duplicates
      indexedCount: 8,
      failedCount: 1,
      skippedCount: 1,
    },
  ],
  parserDiagnostics: [],
  indexingJobs: [
    {
      id: "job-1",
      capsuleId: makeCapsuleId("test-1"),
      sourceIds: [],
      startedAt: 1_700_000_050_000,
      finishedAt: 1_700_000_080_000,
      status: "succeeded",
      totalDocuments: 12,
      // Distinct from source counts above to avoid multiple-match errors
      processedDocuments: 9,
      failedDocuments: 2,
      skippedDocuments: 3,
    },
  ],
};

function resolveDetail(detail: CapsuleDetailData = FULL_DETAIL): () => Promise<CapsuleDetailData> {
  return () => Promise.resolve(detail);
}

// ---------------------------------------------------------------------------
// Overview section
// ---------------------------------------------------------------------------

describe("CapsuleDetail — overview section", () => {
  it("renders a helpful alert when no capsuleId query is selected", async () => {
    mockSearchParams = new URLSearchParams();
    const fetchDetailImpl = vi.fn().mockRejectedValue(new Error("fetch should not run"));

    render(<CapsuleDetail fetchDetailImpl={fetchDetailImpl} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("No capsule selected.");
    });

    expect(fetchDetailImpl).not.toHaveBeenCalled();
  });

  it("renders capsule name in the page heading", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    // The name appears in both the <h1> and the Overview "Name" row — use heading role
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "My Test Capsule" }),
      ).toBeInTheDocument();
    });
  });

  it("renders capsule description in the overview", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      expect(screen.getByText("A capsule for testing")).toBeInTheDocument();
    });
  });

  it("renders tags", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      expect(screen.getByText("docs")).toBeInTheDocument();
    });

    expect(screen.getByText("internal")).toBeInTheDocument();
  });

  it("renders lifecycle status badge", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      const badge = screen.getByRole("status", { name: /Status: ready/i });
      expect(badge).toBeInTheDocument();
    });
  });

  it("renders storage size formatted as MB", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      expect(screen.getByText("1.0 MB")).toBeInTheDocument();
    });
  });

  it("renders embedding model identity", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      expect(
        screen.getByText(/openai \/ text-embedding-3-small \(1536d, cosine\)/i),
      ).toBeInTheDocument();
    });
  });

  it("renders unsupported-document count and guidance when present", async () => {
    const detail: CapsuleDetailData = {
      ...FULL_DETAIL,
      health: {
        ...BASE_HEALTH,
        unsupportedDocuments: 2,
        unsupportedGuidance: [
          "Scanned PDFs need an OCR-capable extraction path. Configure a verified OCR or vision adapter, or provide a text-layer PDF.",
        ],
      },
    };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(detail)} />);

    await waitFor(() => {
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Scanned PDFs need an OCR-capable extraction path/i),
    ).toBeInTheDocument();
  });

  it("renders privacy and deletion disclosure copy", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      expect(screen.getByText("Privacy and deletion")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/stay in Keiko's local runtime state on this machine/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/may be sent through the configured Model Gateway/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/source files on disk are not deleted/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Sources section
// ---------------------------------------------------------------------------

describe("CapsuleDetail — sources section", () => {
  it("renders source display name and scope kind", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      expect(screen.getByText("Project Docs")).toBeInTheDocument();
    });

    expect(screen.getByText("folder")).toBeInTheDocument();
  });

  it("renders indexed / failed / skipped counts", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      expect(screen.getByText("8 indexed")).toBeInTheDocument();
    });

    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("1 skipped")).toBeInTheDocument();
  });

  it("renders empty-sources placeholder when sources array is empty", async () => {
    const noSources: CapsuleDetailData = { ...FULL_DETAIL, sources: [] };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(noSources)} />);

    await waitFor(() => {
      expect(screen.getByText("No sources attached to this capsule.")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Health diagnostics section
// ---------------------------------------------------------------------------

describe("CapsuleDetail — health diagnostics section", () => {
  it("renders the empty-diagnostics placeholder when there are no diagnostics", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      expect(screen.getByTestId("diag-empty")).toBeInTheDocument();
    });

    expect(screen.getByTestId("diag-empty").textContent).toContain("No parser diagnostics");
  });

  it("renders diagnostics with severity, code, and message — never raw text content", async () => {
    const withDiag: CapsuleDetailData = {
      ...FULL_DETAIL,
      parserDiagnostics: [
        {
          severity: "warning",
          code: "PARSE_WARN_001",
          message: "Page layout could not be determined",
          pageNumber: 3,
        },
        {
          severity: "error",
          code: "PARSE_ERR_002",
          message: "Unsupported media type detected",
        },
      ],
    };

    render(<CapsuleDetail fetchDetailImpl={resolveDetail(withDiag)} />);

    await waitFor(() => {
      expect(screen.getByText("PARSE_WARN_001")).toBeInTheDocument();
    });

    expect(screen.getByText("PARSE_ERR_002")).toBeInTheDocument();
    expect(screen.getByText("Page layout could not be determined")).toBeInTheDocument();
    expect(screen.getByText("Unsupported media type detected")).toBeInTheDocument();
    // Page number rendered
    expect(screen.getByText("p.3")).toBeInTheDocument();
  });

  it("caps parser diagnostics by default and expands on demand", async () => {
    const user = userEvent.setup();
    const diagnostics = Array.from({ length: 30 }, (_, index) => ({
      severity: "warning" as const,
      code: `WARN_${index.toString().padStart(2, "0")}`,
      message: `Diagnostic ${index.toString()}`,
    }));
    render(
      <CapsuleDetail
        fetchDetailImpl={resolveDetail({ ...FULL_DETAIL, parserDiagnostics: diagnostics })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Diagnostic 24")).toBeInTheDocument();
    });

    expect(screen.queryByText("Diagnostic 29")).toBeNull();
    await user.click(screen.getByRole("button", { name: /show 5 more diagnostics/i }));
    expect(screen.getByText("Diagnostic 29")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Indexing jobs section
// ---------------------------------------------------------------------------

describe("CapsuleDetail — indexing jobs section", () => {
  it("renders job status and document counts", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      expect(screen.getByText("Succeeded")).toBeInTheDocument();
    });

    // Counts are distinct from source counts (9/2/3 vs 8/1/1) so getByText is unambiguous
    expect(screen.getByText("9 processed")).toBeInTheDocument();
    expect(screen.getByText("2 failed")).toBeInTheDocument();
    expect(screen.getByText("3 skipped")).toBeInTheDocument();
  });

  it("renders empty-jobs placeholder when jobs array is empty", async () => {
    const noJobs: CapsuleDetailData = { ...FULL_DETAIL, indexingJobs: [] };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(noJobs)} />);

    await waitFor(() => {
      expect(screen.getByText("No indexing jobs recorded yet.")).toBeInTheDocument();
    });
  });

  it("caps job history by default and expands on demand", async () => {
    const user = userEvent.setup();
    const jobs = Array.from({ length: 28 }, (_, index) => ({
      id: `job-${index.toString()}`,
      capsuleId: makeCapsuleId("test-1"),
      sourceIds: [],
      startedAt: 1_700_000_000_000 + index,
      status: "succeeded" as const,
      totalDocuments: 1,
      processedDocuments: 1,
      failedDocuments: 0,
      skippedDocuments: 0,
    }));
    render(<CapsuleDetail fetchDetailImpl={resolveDetail({ ...FULL_DETAIL, indexingJobs: jobs })} />);

    await waitFor(() => {
      expect(screen.getAllByText("Succeeded")).toHaveLength(25);
    });

    await user.click(screen.getByRole("button", { name: /show 3 more jobs/i }));
    expect(screen.getAllByText("Succeeded")).toHaveLength(28);
  });
});

// ---------------------------------------------------------------------------
// Error and loading states
// ---------------------------------------------------------------------------

describe("CapsuleDetail — error state", () => {
  it("renders an alert with retry button when fetch rejects", async () => {
    const failFetch = vi.fn().mockRejectedValue(new Error("network failure"));
    render(<CapsuleDetail fetchDetailImpl={failFetch} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert").textContent).toContain("network failure");
    expect(
      screen.getByRole("button", { name: /retry loading capsule detail/i }),
    ).toBeInTheDocument();
  });

  it("retries fetch when retry button is clicked", async () => {
    const user = userEvent.setup();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValueOnce(FULL_DETAIL);

    render(<CapsuleDetail fetchDetailImpl={fetchImpl} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /retry loading capsule detail/i }));

    // After retry the page heading appears — use heading role to avoid duplicate-match error
    // (name also appears in the Overview "Name" row)
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "My Test Capsule" }),
      ).toBeInTheDocument();
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe("CapsuleDetail — a11y", () => {
  it("jest-axe: loading state has no violations", async () => {
    // Use a promise that never resolves to hold the loading state
    const pendingFetch = (): Promise<CapsuleDetailData> => new Promise(() => undefined);
    const { container } = render(<CapsuleDetail fetchDetailImpl={pendingFetch} />);

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: loaded state has no violations", async () => {
    const { container } = render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "My Test Capsule" })).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: error state has no violations", async () => {
    const failFetch = vi.fn().mockRejectedValue(new Error("axe test error"));
    const { container } = render(<CapsuleDetail fetchDetailImpl={failFetch} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: empty diagnostics placeholder has no violations", async () => {
    const { container } = render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    await waitFor(() => {
      expect(screen.getByTestId("diag-empty")).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
