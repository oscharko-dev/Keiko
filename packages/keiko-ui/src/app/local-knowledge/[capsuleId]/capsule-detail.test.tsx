// Issue #198 — unit tests for the CapsuleDetail component.
// Uses vitest + React Testing Library (jsdom) matching connector-graph.test.tsx pattern.
// next/navigation is mocked so useSearchParams() resolves without a real Next.js router.
// All fetch calls go through the injectable fetchDetailImpl seam.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapsuleDetail, resumeButtonLabel, staleChunksTone } from "./capsule-detail";
import type { CapsuleDetail as CapsuleDetailData } from "@/lib/local-knowledge-api";
import type {
  CapsuleContextualRetrievalHealth,
  CapsuleLargeDocumentHealth,
  DocumentId,
  IndexingJobRecord,
  KnowledgeCapsuleId,
  KnowledgeCapsule,
  CapsuleHealth,
  UnsupportedDocumentGuidanceCode,
} from "@oscharko-dev/keiko-contracts";
import {
  DEFAULT_EXTRACTION_CAPABILITY_AVAILABILITY,
  DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-large-document";
import {
  translateLocalKnowledge,
  unsupportedGuidanceText,
  type I18nTranslate,
} from "../local-knowledge-i18n";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// Mock next/navigation so useSearchParams() resolves synchronously in jsdom
// ---------------------------------------------------------------------------

let mockSearchParams = new URLSearchParams("capsuleId=cap-test-1");

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
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/local-knowledge/capsule",
}));

afterEach(() => {
  mockSearchParams = new URLSearchParams("capsuleId=cap-test-1");
  vi.unstubAllGlobals();
  window.localStorage.removeItem(I18N_STORAGE_KEY);
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
  sourceIds: BASE_CAPSULE.sourceIds,
  lifecycleState: "ready",
  storageSizeBytes: 1_048_576,
  documentCount: 10,
  chunkCount: 50,
  vectorCount: 50,
  lastIndexedAt: 1_700_000_100_000,
  embeddingIdentity: BASE_CAPSULE.embeddingModelIdentity,
  vectorCompatible: true,
  embeddingCompatibility: {
    status: "compatible",
    reason: "current-model-matches-pinned",
    pinnedModelId: "text-embedding-3-small",
    pinnedProvider: "openai",
    pinnedVectorDimensions: 1536,
    pinnedVectorMetric: "cosine",
    currentModelId: "text-embedding-3-small",
    currentProvider: "openai-compatible:test",
    message: "The pinned embedding model is configured for embeddings.",
  },
  failedDocuments: 0,
  skippedDocuments: 0,
  unsupportedDocuments: 0,
  unsupportedGuidanceCodes: [],
  staleReasons: [],
  contextualRetrieval: {
    enabled: false,
    source: "default",
    status: "disabled",
    strict: false,
    rebuildRequired: false,
    staleChunkCount: 0,
    degradedChunkCount: 0,
    message: "Contextual retrieval is disabled.",
  },
};

const FULL_DETAIL: CapsuleDetailData = {
  capsule: BASE_CAPSULE,
  health: BASE_HEALTH,
  sources: [
    {
      sourceId: "src-1",
      displayName: "Project Docs",
      scope: { kind: "folder", rootPath: "/tmp/project-docs", recursive: true },
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

// Resolved through the production catalog rather than restated here: these are the same functions
// the component renders with, so a copy change cannot leave a test locator or expectation behind.
const englishT: I18nTranslate = (key, values) => translateLocalKnowledge("en", key, values);
const germanT: I18nTranslate = (key, values) => translateLocalKnowledge("de", key, values);

// The advanced disclosure is labelled in the active locale, so the helper has to be told which one
// the caller rendered. It defaults to English because every test below renders `CapsuleDetail`
// without an `I18nProvider` — `useLocale()` then returns the context default, `en`, unconditionally.
// Hardcoding English here instead made the German test depend on the provider still being in its
// English transition state (issue #2871); the locale is now the caller's explicit input.
async function openAdvanced(
  user: ReturnType<typeof userEvent.setup>,
  t: I18nTranslate = englishT,
): Promise<void> {
  await user.click(await screen.findByText(t("localKnowledge.detail.advanced.summary")));
}

async function openMaintenance(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByText("Maintenance and deletion"));
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
      expect(screen.getByRole("alert")).toHaveTextContent("No Knowledge Pod selected.");
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

  it("renders a stable back path when the selected capsule was deleted", async () => {
    const fetchDetailImpl = vi
      .fn()
      .mockRejectedValue(new Error("Capsule not found: cap-test-1 (NOT_FOUND)"));
    render(<CapsuleDetail fetchDetailImpl={fetchDetailImpl} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("This Knowledge Pod no longer exists.");
    });

    expect(screen.getByRole("link", { name: /back to Knowledge Pods/i })).toHaveAttribute(
      "href",
      "/local-knowledge",
    );
    expect(screen.queryByText(/Capsule not found: cap-test-1/i)).toBeNull();
  });

  it("renders capsule description in the overview", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByText("A capsule for testing")).toBeInTheDocument();
    });
  });

  it("renders tags", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByText("docs")).toBeInTheDocument();
    });

    expect(screen.getByText("internal")).toBeInTheDocument();
  });

  it("renders lifecycle status badge with the shared human-readable label", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    // STATUS_LABELS maps "ready" → "Indexed" — same terminology as the
    // connector-graph capsule list (uiux-fix F033, C006).
    await waitFor(() => {
      const badge = screen.getByRole("status", { name: /Status: Indexed/i });
      expect(badge).toBeInTheDocument();
      expect(badge.textContent).toBe("Indexed");
    });
  });

  it("renders storage size formatted as MB", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByText("1.0 MB")).toBeInTheDocument();
    });
  });

  it("renders multi-gibibyte storage size as GB, not a capped MB value", async () => {
    const user = userEvent.setup();
    // Regression (GEN-DUP-SEMANTIC-001): the local formatBytes capped at MB and had no
    // GB branch, so a 2 GiB capsule rendered "2048.0 MB". The canonical presenter rolls over.
    const detail: CapsuleDetailData = {
      ...FULL_DETAIL,
      health: { ...FULL_DETAIL.health, storageSizeBytes: 2 * 1024 ** 3 },
    };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(detail)} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByText("2.0 GB")).toBeInTheDocument();
    });
    expect(screen.queryByText(/MB$/)).not.toBeInTheDocument();
  });

  it("renders embedding model identity", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(
        screen.getByText(/openai \/ text-embedding-3-small \(1536d, cosine\)/i),
      ).toBeInTheDocument();
    });
  });

  // 0.3.0 release audit — the server used to ship this remediation as English prose that rendered
  // verbatim under a translated heading. It now sends the reason code and the UI owns the copy, so
  // the expectations below are resolved through the production catalog for the locale under test.
  function unsupportedDetail(codes: readonly UnsupportedDocumentGuidanceCode[]): CapsuleDetailData {
    return {
      ...FULL_DETAIL,
      health: { ...BASE_HEALTH, unsupportedDocuments: 2, unsupportedGuidanceCodes: codes },
    };
  }

  it("renders unsupported-document count and guidance when present", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(unsupportedDetail(["pdf-needs-ocr"]))} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    expect(
      screen.getByText(unsupportedGuidanceText("pdf-needs-ocr", englishT)),
    ).toBeInTheDocument();
  });

  it("renders the unsupported-document guidance in German", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    // Establish the locale before rendering, not after. The German catalog is imported lazily into
    // module scope, and `I18nProvider` serves the English baseline until it resolves — so this test
    // used to walk the UI through English labels and only then assert German, which passes only
    // while that transition state still exists. Whether it does is a property of execution order
    // and load timing, not of the component (issue #2871). Awaiting the catalog makes German the
    // first and only paint, so every label this test touches is German, as its name claims.
    await loadLocaleMessages("de");
    render(
      <I18nProvider>
        <CapsuleDetail
          fetchDetailImpl={resolveDetail(unsupportedDetail(["image-needs-ocr", "ocr-failed"]))}
        />
      </I18nProvider>,
    );
    await openAdvanced(user, germanT);

    for (const code of ["image-needs-ocr", "ocr-failed"] as const) {
      expect(await screen.findByText(unsupportedGuidanceText(code, germanT))).toBeInTheDocument();
      // The English copy must be gone, not merely accompanied by German.
      expect(screen.queryByText(unsupportedGuidanceText(code, englishT))).toBeNull();
    }
  });

  it("falls back to the generic remediation for a code this build does not know", async () => {
    const user = userEvent.setup();
    // A newer server may add a code before this UI knows it; the operator must still get a next
    // step instead of a raw wire token or an empty row.
    const forwardCode = "quantum-format" as UnsupportedDocumentGuidanceCode;
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(unsupportedDetail([forwardCode]))} />);
    await openAdvanced(user);

    expect(
      await screen.findByText(unsupportedGuidanceText("unsupported-format", englishT)),
    ).toBeInTheDocument();
    expect(screen.queryByText(forwardCode)).toBeNull();
  });

  it("renders privacy and deletion disclosure copy", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByText("Privacy and deletion")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/stay in Keiko's local runtime state on this machine/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/may be sent through the configured Model Gateway/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/questions against this Knowledge Pod/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Knowledge Pod removes its local index data and Knowledge Pod Set/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/against this capsule/i)).toBeNull();
    expect(screen.getByText(/source files on disk are not deleted/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Index status section
// ---------------------------------------------------------------------------

describe("CapsuleDetail — index status section", () => {
  it("renders indexed documents as successful documents over discovered documents", async () => {
    const baseJob = FULL_DETAIL.indexingJobs[0];
    if (baseJob === undefined) throw new Error("test fixture must include an indexing job");
    const detail: CapsuleDetailData = {
      ...FULL_DETAIL,
      health: {
        ...BASE_HEALTH,
        documentCount: 80,
        failedDocuments: 0,
        skippedDocuments: 4,
        unsupportedDocuments: 4,
      },
      indexingJobs: [
        {
          ...baseJob,
          totalDocuments: 80,
          processedDocuments: 76,
          failedDocuments: 0,
          skippedDocuments: 4,
        },
      ],
    };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(detail)} />);

    await waitFor(() => {
      expect(screen.getByText("Indexed documents")).toBeInTheDocument();
    });

    expect(screen.getByText("76 / 80")).toBeInTheDocument();
    expect(screen.getByText("0 failed, 4 skipped")).toBeInTheDocument();
  });

  it("shows a plain-language explanation for index metrics on hover", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);

    const label = await screen.findByText("Indexed documents");
    await user.hover(label);

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Shows how many documents Keiko could read and add to the index.",
    );

    await user.unhover(label);
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Embedding compatibility section
// ---------------------------------------------------------------------------

describe("CapsuleDetail — embedding compatibility section", () => {
  it("renders compatible pinned and current embedding models", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Embedding compatibility" })).toBeInTheDocument();
    });

    expect(screen.getByText("Pinned model")).toBeInTheDocument();
    expect(screen.getByText("Current embedding model")).toBeInTheDocument();
    expect(screen.getAllByText("Compatible").length).toBeGreaterThan(0);
    expect(
      screen.getByText("The pinned embedding model is configured for embeddings."),
    ).toBeInTheDocument();
  });

  it("renders unknown model compatibility when Gateway config is missing", async () => {
    const user = userEvent.setup();
    const detail: CapsuleDetailData = {
      ...FULL_DETAIL,
      health: {
        ...BASE_HEALTH,
        vectorCompatible: false,
        embeddingCompatibility: {
          status: "unknown",
          reason: "gateway-config-missing",
          pinnedModelId: "text-embedding-3-small",
          pinnedProvider: "openai",
          pinnedVectorDimensions: 1536,
          pinnedVectorMetric: "cosine",
          message:
            "No embedding gateway configuration is loaded. Configure an embedding model, then run a full re-embed.",
        },
      },
    };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(detail)} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("No embedding provider")).toBeInTheDocument();
    expect(screen.getByText(/No embedding gateway configuration is loaded/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Contextual retrieval section
// ---------------------------------------------------------------------------

describe("CapsuleDetail — contextual retrieval section", () => {
  it("renders disabled contextual retrieval controls and the re-index cost hint by default", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Contextual retrieval" })).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Adds a context-generation chat call per chunk during indexing/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Run Full rebuild \/ rechunk after saving/i)).toBeInTheDocument();
    expect(screen.getAllByText("Disabled").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("checkbox", { name: /generate retrieval context at index time/i }),
    ).not.toBeChecked();
    expect(screen.getByLabelText(/context model id/i)).toBeDisabled();
  });

  it("saves per-capsule contextual retrieval settings and surfaces the re-index prompt", async () => {
    const user = userEvent.setup();
    const fetchDetailImpl = vi.fn().mockResolvedValue(FULL_DETAIL);
    const updateContextualRetrievalImpl = vi.fn().mockResolvedValue(FULL_DETAIL);
    render(
      <CapsuleDetail
        fetchDetailImpl={fetchDetailImpl}
        updateContextualRetrievalImpl={updateContextualRetrievalImpl}
      />,
    );

    await openAdvanced(user);
    await screen.findByRole("heading", { name: "Contextual retrieval" });
    await user.click(
      screen.getByRole("checkbox", { name: /generate retrieval context at index time/i }),
    );
    await user.type(screen.getByLabelText(/context model id/i), "context-chat");
    await user.click(screen.getByRole("checkbox", { name: /fail indexing/i }));
    await user.type(screen.getByLabelText(/generated context character limit/i), "320");
    await user.type(screen.getByLabelText(/document context character limit/i), "8000");
    await user.click(screen.getByRole("button", { name: /save retrieval settings/i }));

    await waitFor(() => {
      expect(updateContextualRetrievalImpl).toHaveBeenCalledWith(makeCapsuleId("test-1"), {
        enabled: true,
        modelId: "context-chat",
        strict: true,
        maxContextChars: 320,
        documentContextMaxChars: 8000,
      });
    });
    expect(
      screen.getByText("Saved. Full rebuild / rechunk this pod to apply retrieval text changes."),
    ).toBeInTheDocument();
  });

  it("renders stored contextual retrieval settings", async () => {
    const user = userEvent.setup();
    const detail: CapsuleDetailData = {
      ...FULL_DETAIL,
      capsule: {
        ...BASE_CAPSULE,
        contextualRetrieval: {
          enabled: true,
          modelId: "context-chat",
          strict: false,
          maxContextChars: 640,
          documentContextMaxChars: 16000,
        },
      },
    };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(detail)} />);
    await openAdvanced(user);

    await screen.findByRole("heading", { name: "Contextual retrieval" });

    expect(
      screen.getByRole("checkbox", { name: /generate retrieval context at index time/i }),
    ).toBeChecked();
    expect(screen.getByLabelText(/context model id/i)).toHaveValue("context-chat");
    expect(screen.getByLabelText(/generated context character limit/i)).toHaveValue(640);
    expect(screen.getByLabelText(/document context character limit/i)).toHaveValue(16000);
  });

  it("surfaces contextual rebuild-needed health and the rebuild action", async () => {
    const user = userEvent.setup();
    const detail: CapsuleDetailData = {
      ...FULL_DETAIL,
      health: {
        ...BASE_HEALTH,
        contextualRetrieval: {
          enabled: true,
          source: "capsule",
          status: "rebuild-required",
          strict: false,
          rebuildRequired: true,
          staleChunkCount: 7,
          degradedChunkCount: 1,
          modelId: "context-chat",
          maxContextChars: 320,
          documentContextMaxChars: 8000,
          message:
            "Contextual retrieval settings changed. Run full rebuild / rechunk to rebuild retrieval text.",
        },
      },
    };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(detail)} />);
    await openAdvanced(user);
    await openMaintenance(user);

    await waitFor(() => {
      expect(screen.getAllByText("Rebuild required").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText(/1 degraded/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /full rebuild Knowledge Pod/i })).toHaveAttribute(
      "data-recommended",
      "true",
    );
  });
});

// ---------------------------------------------------------------------------
// Sources section
// ---------------------------------------------------------------------------

describe("CapsuleDetail — sources section", () => {
  it("renders source display name and scope kind", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByText("Project Docs")).toBeInTheDocument();
    });

    expect(screen.getByText("folder")).toBeInTheDocument();
  });

  it("renders indexed / failed / skipped counts", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByText("8 indexed")).toBeInTheDocument();
    });

    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("1 skipped")).toBeInTheDocument();
  });

  it("renders empty-sources placeholder when sources array is empty", async () => {
    const user = userEvent.setup();
    const noSources: CapsuleDetailData = { ...FULL_DETAIL, sources: [] };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(noSources)} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByText("No sources attached to this pod.")).toBeInTheDocument();
    });
  });

  it("submits a source root rebind and reloads capsule detail", async () => {
    const user = userEvent.setup();
    const reloaded: CapsuleDetailData = {
      ...FULL_DETAIL,
      capsule: { ...FULL_DETAIL.capsule, lifecycleState: "stale" },
      sources: [
        {
          ...FULL_DETAIL.sources[0]!,
          scope: { kind: "folder", rootPath: "/tmp/project-docs-new", recursive: true },
        },
      ],
    };
    const fetchDetail = vi.fn().mockResolvedValueOnce(FULL_DETAIL).mockResolvedValueOnce(reloaded);
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(reloaded))));
    vi.stubGlobal("fetch", fetchMock);

    render(<CapsuleDetail fetchDetailImpl={fetchDetail} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByText("Project Docs")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Rebind" }));
    const input = screen.getByLabelText("Replacement folder root");
    await user.clear(input);
    await user.type(input, "/tmp/project-docs-new");
    await user.click(screen.getByRole("button", { name: "Save root" }));

    await waitFor(() => expect(fetchDetail).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/local-knowledge/capsules/cap-test-1/sources/src-1/root",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ rootPath: "/tmp/project-docs-new" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Health diagnostics section
// ---------------------------------------------------------------------------

describe("CapsuleDetail — health diagnostics section", () => {
  it("renders the empty-diagnostics placeholder when there are no diagnostics", async () => {
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByTestId("diag-empty")).toBeInTheDocument();
    });

    expect(screen.getByTestId("diag-empty").textContent).toContain("No parser diagnostics");
  });

  it("renders diagnostics with severity, code, and message — never raw text content", async () => {
    const user = userEvent.setup();
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
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getAllByText("PARSE_WARN_001").length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText("PARSE_ERR_002").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Page layout could not be determined").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unsupported media type detected").length).toBeGreaterThan(0);
    // Page number rendered
    expect(screen.getByText("p.3")).toBeInTheDocument();
  });

  it("LK-01: renders severity label text in each diagnostic group row (non-color cue)", async () => {
    const user = userEvent.setup();
    const withDiag: CapsuleDetailData = {
      ...FULL_DETAIL,
      parserDiagnostics: [
        { severity: "error", code: "ERR_001", message: "Fatal parse error" },
        { severity: "warning", code: "WARN_001", message: "Minor layout issue" },
        { severity: "info", code: "INFO_001", message: "Extra metadata ignored" },
      ],
    };

    render(<CapsuleDetail fetchDetailImpl={resolveDetail(withDiag)} />);
    await openAdvanced(user);

    // Wait for the grouped list to render
    const groupList = await screen.findByRole("list", { name: /grouped parser diagnostics/i });

    // Each group row must carry its severity as visible text — not only as a
    // CSS color class — so it is perceivable without color (WCAG 1.4.1 LK-01).
    const items = groupList.querySelectorAll("li");
    expect(items).toHaveLength(3);

    const labels = Array.from(items).map(
      (li) => li.querySelector(".lkd-diag-severity")?.textContent ?? "",
    );
    expect(labels).toContain("Error");
    expect(labels).toContain("Warning");
    expect(labels).toContain("Info");
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
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getAllByText("Diagnostic 24").length).toBeGreaterThan(0);
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
    const user = userEvent.setup();
    render(<CapsuleDetail fetchDetailImpl={resolveDetail()} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getAllByText("Succeeded").length).toBeGreaterThan(0);
    });

    // Counts are distinct from source counts (9/2/3 vs 8/1/1) so getByText is unambiguous
    expect(screen.getByText("9 processed")).toBeInTheDocument();
    expect(screen.getByText("2 failed")).toBeInTheDocument();
    expect(screen.getByText("3 skipped")).toBeInTheDocument();
  });

  it("renders empty-jobs placeholder when jobs array is empty", async () => {
    const user = userEvent.setup();
    const noJobs: CapsuleDetailData = { ...FULL_DETAIL, indexingJobs: [] };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(noJobs)} />);
    await openAdvanced(user);

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
    render(
      <CapsuleDetail fetchDetailImpl={resolveDetail({ ...FULL_DETAIL, indexingJobs: jobs })} />,
    );
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getAllByText("Succeeded")).toHaveLength(26);
    });

    await user.click(screen.getByRole("button", { name: /show 3 more jobs/i }));
    expect(screen.getAllByText("Succeeded")).toHaveLength(29);
  });

  // F4 — JobRow rendered `new Date(job.startedAt).toISOString()`/`new Date(job.finishedAt)
  // .toISOString()` directly against unvalidated job timestamps. `<details>` always mounts its
  // children in the React tree regardless of open/closed state, so this throws on the very first
  // render — no `openAdvanced()` interaction needed to reach it — and `/local-knowledge/capsule`
  // has no error.tsx and no boundary above it (`<Suspense>` does not catch thrown errors), so the
  // whole page goes blank. These fail on the pre-fix component because `render()` itself throws.
  it("does not crash the page when an indexing job's startedAt is not a valid timestamp", async () => {
    const hostileJob: IndexingJobRecord = {
      ...FULL_DETAIL.indexingJobs[0]!,
      startedAt: Number.NaN,
    };
    const detail: CapsuleDetailData = { ...FULL_DETAIL, indexingJobs: [hostileJob] };

    render(<CapsuleDetail fetchDetailImpl={resolveDetail(detail)} />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "My Test Capsule" }),
      ).toBeInTheDocument();
    });
  });

  it("does not crash the page when an indexing job's finishedAt is not a valid timestamp", async () => {
    const hostileJob: IndexingJobRecord = {
      ...FULL_DETAIL.indexingJobs[0]!,
      finishedAt: Number.NaN,
    };
    const detail: CapsuleDetailData = { ...FULL_DETAIL, indexingJobs: [hostileJob] };

    render(<CapsuleDetail fetchDetailImpl={resolveDetail(detail)} />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "My Test Capsule" }),
      ).toBeInTheDocument();
    });
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
      screen.getByRole("button", { name: /retry loading Knowledge Pod detail/i }),
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

    await user.click(screen.getByRole("button", { name: /retry loading Knowledge Pod detail/i }));

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
// Vector-compatible=false branches (Epic #189 AC O6)
// ---------------------------------------------------------------------------

describe("CapsuleDetail — vectorCompatible=false", () => {
  it("renders the incompatible fallback when vectorCompatible is false", async () => {
    const user = userEvent.setup();
    const { embeddingCompatibility: _embeddingCompatibility, ...legacyHealth } = BASE_HEALTH;
    void _embeddingCompatibility;
    const detail: CapsuleDetailData = {
      ...FULL_DETAIL,
      health: {
        ...legacyHealth,
        vectorCompatible: false,
        staleReasons: [],
      },
    };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(detail)} />);
    await openAdvanced(user);
    await openMaintenance(user);

    await waitFor(() => {
      expect(screen.getAllByText(/Incompatible/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByRole("button", { name: /current embedding model/i })).toBeInTheDocument();
  });

  it("renders stale-reason list items when staleReasons is non-empty", async () => {
    const user = userEvent.setup();
    const staleReason = "The configured embedding model no longer matches this pod.";
    const detail: CapsuleDetailData = {
      ...FULL_DETAIL,
      health: { ...BASE_HEALTH, vectorCompatible: false, staleReasons: [staleReason] },
    };
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(detail)} />);
    await openAdvanced(user);

    await waitFor(() => {
      expect(screen.getByText(staleReason)).toBeInTheDocument();
    });
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

// ---------------------------------------------------------------------------
// Large-document progress + resume (Issue #1286)
// ---------------------------------------------------------------------------

function largeDocumentHealth(
  overrides: Partial<CapsuleLargeDocumentHealth> = {},
): CapsuleLargeDocumentHealth {
  return {
    resourcePolicy: DEFAULT_LARGE_DOCUMENT_RESOURCE_POLICY,
    capabilities: DEFAULT_EXTRACTION_CAPABILITY_AVAILABILITY,
    progress: [
      {
        documentId: "doc-1" as DocumentId,
        safeDisplayName: "annual-report.pdf",
        strategy: "progressive-pdf",
        phase: "embedding",
        processedPages: 124,
        extractedTextBytes: 540_000,
        chunkCount: 80,
        embeddedChunkCount: 32,
        retryCount: 0,
        coverage: "partial",
        resumable: true,
      },
    ],
    resumableDocuments: ["doc-1" as DocumentId],
    partialCoverageDocuments: 1,
    qualityWarnings: ["page has no extractable text layer; indexed with partial coverage"],
    ...overrides,
  };
}

function detailWithLargeDocs(health: CapsuleLargeDocumentHealth): CapsuleDetailData {
  return { ...FULL_DETAIL, largeDocumentHealth: health };
}

describe("CapsuleDetail — large-document progress", () => {
  it("renders per-document phase progress, partial-coverage badge, and quality warnings", async () => {
    render(
      <CapsuleDetail fetchDetailImpl={resolveDetail(detailWithLargeDocs(largeDocumentHealth()))} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Large documents" })).toBeInTheDocument();
    });
    expect(screen.getByText("annual-report.pdf")).toBeInTheDocument();
    expect(screen.getByText("Embedding")).toBeInTheDocument();
    // The distinct quality-warning line (the partial-coverage badge shares the phrase).
    expect(
      screen.getByText("page has no extractable text layer; indexed with partial coverage"),
    ).toBeInTheDocument();
    expect(screen.getByText(/32\/80 chunks embedded/u)).toBeInTheDocument();
  });

  it("does not render the section when there is no large-document progress", async () => {
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(FULL_DETAIL)} />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    });
    expect(screen.queryByRole("heading", { name: "Large documents" })).not.toBeInTheDocument();
  });

  it("invokes the resume seam when the Resume control is clicked", async () => {
    const resumeImpl = vi.fn((id: KnowledgeCapsuleId) =>
      Promise.resolve({ ok: true as const, capsuleId: id }),
    );
    render(
      <CapsuleDetail
        fetchDetailImpl={resolveDetail(detailWithLargeDocs(largeDocumentHealth()))}
        resumeImpl={resumeImpl}
      />,
    );
    const button = await screen.findByRole("button", {
      name: "Resume interrupted large-document indexing",
    });
    await userEvent.click(button);
    await waitFor(() => {
      expect(resumeImpl).toHaveBeenCalledTimes(1);
    });
  });

  it("has no accessibility violations with the large-document section", async () => {
    const { container } = render(
      <CapsuleDetail fetchDetailImpl={resolveDetail(detailWithLargeDocs(largeDocumentHealth()))} />,
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Large documents" })).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("CapsuleDetail — abandoned indexing recovery", () => {
  it("offers an accessible resume action bound to the projected job id", async () => {
    const detail: CapsuleDetailData = {
      ...FULL_DETAIL,
      health: {
        ...FULL_DETAIL.health,
        indexingRecovery: {
          jobId: "job-abandoned",
          state: "resumable",
          sourceCount: 1,
          processedDocuments: 3,
        },
      },
    };
    const resumeImpl = vi.fn((id: KnowledgeCapsuleId, _resumeJobId?: string) =>
      Promise.resolve({ ok: true as const, capsuleId: id }),
    );
    render(<CapsuleDetail fetchDetailImpl={resolveDetail(detail)} resumeImpl={resumeImpl} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Resume interrupted indexing" }),
    );

    await waitFor(() => {
      expect(resumeImpl).toHaveBeenCalledWith(detail.capsule.id, "job-abandoned");
    });
  });
});

// ---------------------------------------------------------------------------
// staleChunksTone (pure helper)
// ---------------------------------------------------------------------------

function contextualRetrievalHealth(
  overrides: Partial<CapsuleContextualRetrievalHealth> = {},
): CapsuleContextualRetrievalHealth {
  return {
    enabled: true,
    source: "capsule",
    status: "ready",
    strict: false,
    rebuildRequired: false,
    staleChunkCount: 0,
    degradedChunkCount: 0,
    message: "Contextual retrieval is ready.",
    ...overrides,
  };
}

describe("staleChunksTone", () => {
  it("warns when a rebuild is required, regardless of the degraded count", () => {
    expect(
      staleChunksTone(contextualRetrievalHealth({ rebuildRequired: true, degradedChunkCount: 0 })),
    ).toBe("warn");
  });

  it("warns on degraded chunks alone, even when no rebuild is required", () => {
    expect(
      staleChunksTone(contextualRetrievalHealth({ rebuildRequired: false, degradedChunkCount: 3 })),
    ).toBe("warn");
  });

  it("is ok when neither a rebuild is required nor any chunk is degraded", () => {
    expect(
      staleChunksTone(contextualRetrievalHealth({ rebuildRequired: false, degradedChunkCount: 0 })),
    ).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// resumeButtonLabel (pure helper)
// ---------------------------------------------------------------------------

describe("resumeButtonLabel", () => {
  it("shows the busy label while a resume is in flight", () => {
    expect(resumeButtonLabel(true, 1, englishT)).toBe("Resuming…");
  });

  it("uses the singular label for exactly one resumable document", () => {
    expect(resumeButtonLabel(false, 1, englishT)).toBe("Resume 1 document");
  });

  it("pluralizes the label when more than one document is resumable", () => {
    expect(resumeButtonLabel(false, 2, englishT)).toBe("Resume 2 documents");
  });
});
