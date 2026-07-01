import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdfCitationPreviewOpenResponse } from "@oscharko-dev/keiko-contracts";
import { fetchPdfCitationPreviewStatus, openPdfCitationPreviewSession } from "@/lib/api";
import type { GroundedAnswer, LocalKnowledgeEvidenceCitation } from "@/lib/types";
import {
  showPdfCitationPreviewFailure,
  showPdfCitationPreviewResult,
} from "../widgets/cards/pdf-citation-preview-session";
import { usePdfCitationPreviewController } from "./usePdfCitationPreview";

vi.mock("@/lib/api", () => ({
  fetchPdfCitationPreviewStatus: vi.fn(),
  openPdfCitationPreviewSession: vi.fn(),
}));

vi.mock("../widgets/cards/pdf-citation-preview-session", () => ({
  showPdfCitationPreviewFailure: vi.fn(() => "pdf-window-failure"),
  showPdfCitationPreviewResult: vi.fn(() => "pdf-window-1"),
}));

function citation(
  marker: string,
  stableId: string,
  label = "policy.pdf",
  documentId = "doc-1",
): LocalKnowledgeEvidenceCitation {
  return {
    stableId,
    marker,
    label,
    score: 0.91,
    lineage: {
      capsuleId: "cap-1" as LocalKnowledgeEvidenceCitation["lineage"]["capsuleId"],
      sourceId: "src-1" as LocalKnowledgeEvidenceCitation["lineage"]["sourceId"],
      documentId: documentId as LocalKnowledgeEvidenceCitation["lineage"]["documentId"],
      chunkId: "chunk-1" as LocalKnowledgeEvidenceCitation["lineage"]["chunkId"],
    },
  };
}

function answer(citations: readonly LocalKnowledgeEvidenceCitation[]): GroundedAnswer {
  return {
    groundingKind: "local-knowledge",
    userMessageId: "msg-u",
    assistantMessageId: "msg-a",
    content: "Answer [1].",
    citations,
    uncertainty: [],
    omittedCount: 0,
    elapsedMs: 12,
    noEvidence: false,
    contextPack: {
      kind: "local-knowledge",
      scopeKind: "capsule",
      scopeId: "cap-1",
      scopeLabel: "Local Knowledge",
      capsuleCount: 1,
      sourceCount: 1,
      citationCount: citations.length,
      referenceBudget: 16,
      referencesUsed: citations.length,
    },
  };
}

function activeResponse(): PdfCitationPreviewOpenResponse {
  return {
    outcome: "authorized",
    display: {
      documentLabel: "policy.pdf",
      pageNumber: 3,
      anchorQuality: "page-only",
    },
    session: {
      handle: "preview-session-1",
      expiresAt: "2026-06-28T12:00:00.000Z",
      reused: false,
      byteLength: 4096,
      contentType: "application/pdf",
    },
  };
}

describe("usePdfCitationPreviewController", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("batches passive status by answer and maps only actionable citation states", async () => {
    const citations = [citation("[1]", "stable-1"), citation("[2]", "stable-2", "notes.txt")];
    const groundedAnswer = answer(citations);
    vi.mocked(fetchPdfCitationPreviewStatus).mockResolvedValue({
      citations: [
        {
          stableId: "stable-1",
          marker: "[1]",
          markerIndex: 1,
          state: "available",
          display: { documentLabel: "policy.pdf", pageNumber: 3, anchorQuality: "page-only" },
        },
        {
          stableId: "stable-2",
          marker: "[2]",
          markerIndex: 2,
          state: "not-applicable",
        },
      ],
    });

    const { result } = renderHook(() =>
      usePdfCitationPreviewController({
        answer: groundedAnswer,
        chatId: "chat-1",
        windows: {
          add: vi.fn(),
          focus: vi.fn(),
          update: vi.fn(),
        },
      }),
    );

    await waitFor(() => {
      expect(fetchPdfCitationPreviewStatus).toHaveBeenCalledWith({
        chatId: "chat-1",
        assistantMessageId: "msg-a",
      });
    });
    await waitFor(() => {
      expect(result.current?.forMarker("[1]")?.state).toBe("available");
    });
    expect(result.current?.forCitation(citations[1]!)).toBeUndefined();
  });

  it("maps passive status by marker when the stored preview id differs from the answer citation id", async () => {
    const citations = [citation("[1]", "answer-stable-1")];
    const groundedAnswer = answer(citations);
    vi.mocked(fetchPdfCitationPreviewStatus).mockResolvedValue({
      citations: [
        {
          stableId: "stored-preview-stable-1",
          marker: "[1]",
          markerIndex: 1,
          state: "available",
          display: { documentLabel: "policy.pdf", pageNumber: 3, anchorQuality: "page-only" },
        },
      ],
    });

    const { result } = renderHook(() =>
      usePdfCitationPreviewController({
        answer: groundedAnswer,
        chatId: "chat-1",
        windows: {
          add: vi.fn(),
          focus: vi.fn(),
          update: vi.fn(),
        },
      }),
    );

    await waitFor(() => {
      expect(result.current?.forCitation(citations[0]!)?.state).toBe("available");
    });
    expect(result.current?.forMarker("[1]")?.citation.stableId).toBe("answer-stable-1");
  });

  it("marker-maps repeated identical answer citations as one candidate", async () => {
    const citations = [citation("[1]", "answer-stable-1"), citation("[1]", "answer-stable-1")];
    const groundedAnswer = answer(citations);
    vi.mocked(fetchPdfCitationPreviewStatus).mockResolvedValue({
      citations: [
        {
          stableId: "stored-preview-stable-1",
          marker: "[1]",
          markerIndex: 1,
          state: "available",
          display: { documentLabel: "policy.pdf", pageNumber: 3, anchorQuality: "page-only" },
        },
      ],
    });

    const { result } = renderHook(() =>
      usePdfCitationPreviewController({
        answer: groundedAnswer,
        chatId: "chat-1",
        windows: {
          add: vi.fn(),
          focus: vi.fn(),
          update: vi.fn(),
        },
      }),
    );

    await waitFor(() => {
      expect(result.current?.forMarker("[1]")?.state).toBe("available");
    });
  });

  it("does not marker-map passive status when the answer marker is ambiguous", async () => {
    const citations = [
      citation("[1]", "answer-stable-1", "policy-a.pdf", "doc-1"),
      citation("[1]", "answer-stable-2", "policy-b.pdf", "doc-2"),
    ];
    const groundedAnswer = answer(citations);
    vi.mocked(fetchPdfCitationPreviewStatus).mockResolvedValue({
      citations: [
        {
          stableId: "stored-preview-stable-1",
          marker: "[1]",
          markerIndex: 1,
          state: "available",
          display: { documentLabel: "policy.pdf", pageNumber: 3, anchorQuality: "page-only" },
        },
      ],
    });

    const { result } = renderHook(() =>
      usePdfCitationPreviewController({
        answer: groundedAnswer,
        chatId: "chat-1",
        windows: {
          add: vi.fn(),
          focus: vi.fn(),
          update: vi.fn(),
        },
      }),
    );

    await waitFor(() => {
      expect(fetchPdfCitationPreviewStatus).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current?.forMarker("[1]")).toBeUndefined();
    });
  });

  it("leaves citations normal when passive status fails", async () => {
    const citations = [citation("[1]", "stable-1")];
    const groundedAnswer = answer(citations);
    vi.mocked(fetchPdfCitationPreviewStatus).mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() =>
      usePdfCitationPreviewController({
        answer: groundedAnswer,
        chatId: "chat-1",
        windows: {
          add: vi.fn(),
          focus: vi.fn(),
          update: vi.fn(),
        },
      }),
    );

    await waitFor(() => {
      expect(fetchPdfCitationPreviewStatus).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current?.forMarker("[1]")).toBeUndefined();
    });
  });

  it("coalesces duplicate active opens and sends origin as non-authorizing provenance", async () => {
    const citations = [citation("[1]", "stable-1")];
    const groundedAnswer = answer(citations);
    vi.mocked(fetchPdfCitationPreviewStatus).mockResolvedValue({
      citations: [
        {
          stableId: "stable-1",
          marker: "[1]",
          markerIndex: 1,
          state: "available",
          display: { documentLabel: "policy.pdf", pageNumber: 3, anchorQuality: "page-only" },
        },
      ],
    });
    let resolveOpen: (response: PdfCitationPreviewOpenResponse) => void = () => undefined;
    vi.mocked(openPdfCitationPreviewSession).mockReturnValue(
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
    );

    const windows = {
      add: vi.fn(),
      focus: vi.fn(),
      update: vi.fn(),
    };
    const { result } = renderHook(() =>
      usePdfCitationPreviewController({
        answer: groundedAnswer,
        chatId: "chat-1",
        windows,
      }),
    );

    await waitFor(() => {
      expect(result.current?.forMarker("[1]")?.state).toBe("available");
    });

    let first: Promise<string | null>;
    let second: Promise<string | null>;
    await act(async () => {
      first = result.current!.openCitation(citations[0]!, "inline-marker");
      second = result.current!.openCitation(citations[0]!, "inline-marker");
    });

    expect(openPdfCitationPreviewSession).toHaveBeenCalledTimes(1);
    expect(openPdfCitationPreviewSession).toHaveBeenCalledWith({
      chatId: "chat-1",
      assistantMessageId: "msg-a",
      marker: "[1]",
      stableId: "stable-1",
      origin: "inline-marker",
    });
    expect(result.current?.isOpening(citations[0]!)).toBe(true);

    await act(async () => {
      resolveOpen(activeResponse());
      await first!;
      await second!;
    });

    expect(await first!).toBe("pdf-window-1");
    expect(await second!).toBe("pdf-window-1");
    expect(showPdfCitationPreviewResult).toHaveBeenCalledWith(
      windows,
      activeResponse(),
      expect.objectContaining({
        currentPage: 3,
        context: expect.objectContaining({
          activeStableId: "stable-1",
        }),
      }),
    );
    expect(result.current?.isOpening(citations[0]!)).toBe(false);
  });

  it("passes answer-local same-document context and source-chat provenance to the viewer result", async () => {
    const citations = [
      citation("[1]", "stable-1", "policy.pdf", "doc-shared"),
      citation("[2]", "stable-2", "policy appendix.pdf", "doc-shared"),
      citation("[2]", "stable-2", "policy appendix.pdf", "doc-shared"),
      citation("[3]", "stable-3", "other.pdf", "doc-other"),
    ];
    const groundedAnswer = answer(citations);
    vi.mocked(fetchPdfCitationPreviewStatus).mockResolvedValue({
      citations: [
        {
          stableId: "stable-1",
          marker: "[1]",
          markerIndex: 1,
          state: "available",
          display: { documentLabel: "policy.pdf", pageNumber: 3, anchorQuality: "page-only" },
        },
        {
          stableId: "stable-2",
          marker: "[2]",
          markerIndex: 2,
          state: "available",
          display: {
            documentLabel: "policy.pdf",
            pageNumber: 8,
            pageLabel: "Page 8",
            anchorQuality: "approximate",
          },
        },
        {
          stableId: "stable-3",
          marker: "[3]",
          markerIndex: 3,
          state: "available",
          display: { documentLabel: "other.pdf", pageNumber: 11, anchorQuality: "page-only" },
        },
      ],
    });
    vi.mocked(openPdfCitationPreviewSession).mockResolvedValue(activeResponse());

    const windows = {
      add: vi.fn(),
      focus: vi.fn(),
      update: vi.fn(),
    };
    const { result } = renderHook(() =>
      usePdfCitationPreviewController({
        answer: groundedAnswer,
        chatId: "chat-1",
        windowId: "chat-window-1",
        windows,
      }),
    );

    await waitFor(() => {
      expect(result.current?.forMarker("[1]")?.state).toBe("available");
    });

    await act(async () => {
      await result.current!.openCitation(citations[0]!, "inline-marker");
    });

    expect(showPdfCitationPreviewResult).toHaveBeenCalledWith(
      windows,
      activeResponse(),
      expect.objectContaining({
        currentPage: 3,
        context: {
          activeStableId: "stable-1",
          citations: [
            {
              citation: {
                stableId: "stable-1",
                marker: "[1]",
                label: "policy.pdf",
              },
              display: {
                documentLabel: "policy.pdf",
                pageNumber: 3,
                anchorQuality: "page-only",
              },
            },
            {
              citation: {
                stableId: "stable-2",
                marker: "[2]",
                label: "policy appendix.pdf",
              },
              display: {
                documentLabel: "policy.pdf",
                pageNumber: 8,
                pageLabel: "Page 8",
                anchorQuality: "approximate",
              },
            },
          ],
          origin: {
            assistantMessageId: "msg-a",
            chatId: "chat-1",
            chatWindowId: "chat-window-1",
            marker: "[1]",
            representation: "inline-marker",
          },
        },
      }),
    );
  });

  it("drops a stale open result after the rendered answer changes", async () => {
    const firstCitation = citation("[1]", "stable-1");
    const secondCitation = citation("[2]", "stable-2");
    const firstAnswer = answer([firstCitation]);
    const secondAnswer: GroundedAnswer = {
      ...answer([secondCitation]),
      assistantMessageId: "msg-b",
      content: "Answer [2].",
    };
    vi.mocked(fetchPdfCitationPreviewStatus).mockResolvedValue({
      citations: [
        {
          stableId: "stable-1",
          marker: "[1]",
          markerIndex: 1,
          state: "available",
          display: { documentLabel: "policy.pdf", pageNumber: 3, anchorQuality: "page-only" },
        },
      ],
    });
    let resolveOpen: (response: PdfCitationPreviewOpenResponse) => void = () => undefined;
    vi.mocked(openPdfCitationPreviewSession).mockReturnValue(
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
    );

    const windows = {
      add: vi.fn(),
      focus: vi.fn(),
      update: vi.fn(),
    };
    const { result, rerender } = renderHook(
      ({ groundedAnswer }: { readonly groundedAnswer: GroundedAnswer }) =>
        usePdfCitationPreviewController({
          answer: groundedAnswer,
          chatId: "chat-1",
          windowId: "chat-window-1",
          windows,
        }),
      { initialProps: { groundedAnswer: firstAnswer } },
    );

    await waitFor(() => {
      expect(result.current?.forMarker("[1]")?.state).toBe("available");
    });

    let pendingOpen: Promise<string | null>;
    await act(async () => {
      pendingOpen = result.current!.openCitation(firstCitation, "inline-marker");
    });
    rerender({ groundedAnswer: secondAnswer });

    let openResult: string | null = "unexpected";
    await act(async () => {
      resolveOpen(activeResponse());
      openResult = await pendingOpen!;
    });

    expect(openResult).toBeNull();
    expect(showPdfCitationPreviewResult).not.toHaveBeenCalled();
    expect(showPdfCitationPreviewFailure).not.toHaveBeenCalled();
  });

  it("routes rejected opens to a failure shell without seeding a loaded page", async () => {
    const citations = [citation("[1]", "stable-1")];
    const groundedAnswer = answer(citations);
    const rejected = {
      outcome: "rejected" as const,
      state: "recoverable" as const,
      reason: "preview-source-missing" as const,
      display: {
        documentLabel: "policy.pdf",
        pageNumber: 3,
        anchorQuality: "page-only" as const,
      },
    };
    vi.mocked(fetchPdfCitationPreviewStatus).mockResolvedValue({
      citations: [
        {
          stableId: "stable-1",
          marker: "[1]",
          markerIndex: 1,
          state: "available",
          display: { documentLabel: "policy.pdf", pageNumber: 3, anchorQuality: "page-only" },
        },
      ],
    });
    vi.mocked(openPdfCitationPreviewSession).mockResolvedValue(rejected);

    const windows = {
      add: vi.fn(),
      focus: vi.fn(),
      update: vi.fn(),
    };
    const { result } = renderHook(() =>
      usePdfCitationPreviewController({
        answer: groundedAnswer,
        chatId: "chat-1",
        windows,
      }),
    );

    await waitFor(() => {
      expect(result.current?.forMarker("[1]")?.state).toBe("available");
    });

    await act(async () => {
      await result.current!.openCitation(citations[0]!, "citation-chip");
    });

    expect(showPdfCitationPreviewResult).not.toHaveBeenCalled();
    expect(showPdfCitationPreviewFailure).toHaveBeenCalledWith(windows, rejected);
  });

  it("omits blocked same-document citations from the local sibling context", async () => {
    const citations = [
      citation("[1]", "stable-1", "policy.pdf", "doc-shared"),
      citation("[2]", "stable-2", "blocked policy.pdf", "doc-shared"),
    ];
    const groundedAnswer = answer(citations);
    vi.mocked(fetchPdfCitationPreviewStatus).mockResolvedValue({
      citations: [
        {
          stableId: "stable-1",
          marker: "[1]",
          markerIndex: 1,
          state: "available",
          display: { documentLabel: "policy.pdf", pageNumber: 3, anchorQuality: "page-only" },
        },
        {
          stableId: "stable-2",
          marker: "[2]",
          markerIndex: 2,
          state: "blocked",
          reason: "lineage-missing",
          display: { documentLabel: "policy.pdf", pageNumber: 8, anchorQuality: "page-only" },
        },
      ],
    });
    vi.mocked(openPdfCitationPreviewSession).mockResolvedValue(activeResponse());

    const windows = {
      add: vi.fn(),
      focus: vi.fn(),
      update: vi.fn(),
    };
    const { result } = renderHook(() =>
      usePdfCitationPreviewController({
        answer: groundedAnswer,
        chatId: "chat-1",
        windowId: "chat-window-1",
        windows,
      }),
    );

    await waitFor(() => {
      expect(result.current?.forMarker("[1]")?.state).toBe("available");
    });

    await act(async () => {
      await result.current!.openCitation(citations[0]!, "inline-marker");
    });

    expect(showPdfCitationPreviewResult).toHaveBeenCalledWith(
      windows,
      activeResponse(),
      expect.objectContaining({
        context: expect.objectContaining({
          citations: [
            {
              citation: {
                stableId: "stable-1",
                marker: "[1]",
                label: "policy.pdf",
              },
              display: {
                documentLabel: "policy.pdf",
                pageNumber: 3,
                anchorQuality: "page-only",
              },
            },
          ],
        }),
      }),
    );
  });
});
