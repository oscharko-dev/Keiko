import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PdfCitationPreviewOpenResponse,
  PdfCitationPreviewCitationStatus,
  KnowledgeCitationEditorTargetResponse,
} from "@oscharko-dev/keiko-contracts";
import {
  fetchPdfCitationPreviewStatus,
  openPdfCitationPreviewSession,
  openKnowledgeCitationEditorTarget,
} from "@/lib/api";
import { expectDiagnosticWireAccepted } from "@/test-utils/diagnostic-wire";
import {
  setClientDiagnosticWriter,
  resetClientDiagnosticWriter,
  type ClientDiagnosticMeta,
} from "@/lib/client-diagnostics";
import type { GroundedAnswer, LocalKnowledgeEvidenceCitation } from "@/lib/types";
import {
  showPdfCitationPreviewFailure,
  showPdfCitationPreviewResult,
} from "../widgets/cards/pdf-citation-preview-session";
import {
  clearPdfCitationPreviewStatusCacheForTests,
  usePdfCitationPreviewController,
} from "./usePdfCitationPreview";

vi.mock("@/lib/api", () => ({
  fetchPdfCitationPreviewStatus: vi.fn(),
  openPdfCitationPreviewSession: vi.fn(),
  openKnowledgeCitationEditorTarget: vi.fn(),
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
    clearPdfCitationPreviewStatusCacheForTests();
  });

  // GEN-PERF-CHAT-009 — many settled bubbles instantiate their own controller for the same
  // assistant message; the shared status cache must collapse those repeated passive reads to a
  // single fetch. The pre-fix 2 s TTL let the storm re-arm on any re-render burst that outlived it;
  // the raised TTL keeps the dedup effective across a much longer window.
  it("serves repeated controllers for one message from a single cached status fetch", async () => {
    vi.useFakeTimers();
    try {
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

      const windows = { add: vi.fn(), focus: vi.fn(), update: vi.fn() };
      // Render 25 controllers for the SAME assistant message (msg-a) — the same bubble re-rendered
      // across the transcript. All must share one status fetch.
      const views = Array.from({ length: 25 }, () =>
        renderHook(() =>
          usePdfCitationPreviewController({ answer: groundedAnswer, chatId: "chat-1", windows }),
        ),
      );

      await vi.waitFor(() => {
        expect(fetchPdfCitationPreviewStatus).toHaveBeenCalledTimes(1);
      });

      // Advance PAST the old 2 s TTL and re-mount another controller — still no second fetch,
      // proving the raised TTL keeps the cache warm well beyond the pre-fix window.
      await vi.advanceTimersByTimeAsync(10_000);
      renderHook(() =>
        usePdfCitationPreviewController({ answer: groundedAnswer, chatId: "chat-1", windows }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchPdfCitationPreviewStatus).toHaveBeenCalledTimes(1);

      for (const view of views) view.unmount();
    } finally {
      vi.useRealTimers();
    }
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

function deferredEditorTarget(): {
  readonly promise: Promise<KnowledgeCitationEditorTargetResponse>;
  readonly resolve: (value: KnowledgeCitationEditorTargetResponse) => void;
} {
  let resolve: (value: KnowledgeCitationEditorTargetResponse) => void = () => undefined;
  const promise = new Promise<KnowledgeCitationEditorTargetResponse>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function editorCitationStatus(
  overrides: Partial<PdfCitationPreviewCitationStatus> = {},
): PdfCitationPreviewCitationStatus {
  return {
    stableId: "text-stable",
    marker: "[1]",
    markerIndex: 1,
    state: "not-applicable",
    reason: "document-not-pdf",
    editorOpenAvailable: true,
    ...overrides,
  };
}
function editorFixture(
  statuses: readonly PdfCitationPreviewCitationStatus[] = [editorCitationStatus()],
): {
  readonly selected: LocalKnowledgeEvidenceCitation;
  readonly grounded: GroundedAnswer;
} {
  const selected = citation("[1]", "text-stable", "Companion - Übersicht.txt");
  vi.mocked(fetchPdfCitationPreviewStatus).mockResolvedValue({ citations: statuses });
  return { selected, grounded: answer([selected]) };
}

describe("canonical Knowledge citation editor", () => {
  afterEach(() => {
    vi.resetAllMocks();
    clearPdfCitationPreviewStatusCacheForTests();
    resetClientDiagnosticWriter();
  });

  it("deduplicates explicit text clicks and logs only the authorized canonical open", async () => {
    const { selected, grounded } = editorFixture();
    const pending = deferredEditorTarget();
    vi.mocked(openKnowledgeCitationEditorTarget).mockReturnValue(pending.promise);
    const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "source-editor" }));
    const reports: { message: string; meta: ClientDiagnosticMeta | undefined }[] = [];
    setClientDiagnosticWriter((message, meta) => reports.push({ message, meta }));
    const view = renderHook(
      () =>
        usePdfCitationPreviewController({
          answer: grounded,
          chatId: "chat-source",
          windows: undefined,
          openEditorFile,
        }),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(view.result.current?.editor?.stateFor(selected)).toBe("idle"));
    expect(openKnowledgeCitationEditorTarget).not.toHaveBeenCalled();
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = view.result.current?.editor?.openCitation(selected);
      second = view.result.current?.editor?.openCitation(selected);
    });
    expect(openKnowledgeCitationEditorTarget).toHaveBeenCalledTimes(1);
    expect(openEditorFile).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
    await act(async () => {
      pending.resolve({
        outcome: "authorized",
        target: { root: "/synthetic/source", path: "Companion - Übersicht.txt" },
      });
      await Promise.all([first, second]);
    });
    expect(openEditorFile).toHaveBeenCalledExactlyOnceWith({
      root: "/synthetic/source",
      path: "Companion - Übersicht.txt",
    });
    expect(view.result.current?.editor?.stateFor(selected)).toBe("opened");
    expect(reports.flatMap(({ meta }) => meta?.citationActivation ?? [])).toEqual([
      { reason: "matched", outcome: "opened", rootCount: 1, matchCount: 1 },
    ]);
    expect(JSON.stringify(reports)).not.toMatch(/synthetic|Companion|Übersicht/u);
    await expectDiagnosticWireAccepted(reports);
  });

  it.each(["wrong-id", "wrong-marker", "no-flag", "duplicate"] as const)(
    "does not grant a text action from %s status metadata",
    async (variant) => {
      let status = editorCitationStatus();
      if (variant === "wrong-id") status = editorCitationStatus({ stableId: "another-document" });
      if (variant === "wrong-marker") status = editorCitationStatus({ marker: "[2]" });
      if (variant === "no-flag") {
        const { editorOpenAvailable: _, ...rest } = status;
        status = rest;
      }
      const { selected, grounded } = editorFixture(
        variant === "duplicate" ? [status, status] : [status],
      );
      const view = renderHook(() =>
        usePdfCitationPreviewController({
          answer: grounded,
          chatId: "chat-source",
          windows: undefined,
          openEditorFile: vi.fn(),
        }),
      );
      await waitFor(() => expect(fetchPdfCitationPreviewStatus).toHaveBeenCalledTimes(1));
      await act(async () => {
        await view.result.current?.editor?.openCitation(selected);
      });
      expect(view.result.current?.editor?.stateFor(selected)).toBeUndefined();
      expect(openKnowledgeCitationEditorTarget).not.toHaveBeenCalled();
    },
  );

  it.each(["authorized", "rejected"] as const)(
    "ignores a late %s text result after a newer chat selection",
    async (outcome) => {
      const { selected, grounded } = editorFixture();
      const pending = deferredEditorTarget();
      vi.mocked(openKnowledgeCitationEditorTarget).mockReturnValue(pending.promise);
      const openEditorFile = vi.fn(() => ({ ok: true as const, windowId: "editor" }));
      const reports: ClientDiagnosticMeta[] = [];
      setClientDiagnosticWriter((_message, meta) => {
        if (meta !== undefined) reports.push(meta);
      });
      const view = renderHook(
        ({ chatId }) =>
          usePdfCitationPreviewController({
            answer: grounded,
            chatId,
            windows: undefined,
            openEditorFile,
          }),
        { initialProps: { chatId: "old-chat" } },
      );
      await waitFor(() => expect(view.result.current?.editor?.stateFor(selected)).toBe("idle"));
      let request: Promise<void> | undefined;
      act(() => {
        request = view.result.current?.editor?.openCitation(selected);
      });
      view.rerender({ chatId: "new-chat" });
      await waitFor(() => expect(view.result.current?.editor?.stateFor(selected)).toBe("idle"));
      await act(async () => {
        pending.resolve(
          outcome === "authorized"
            ? { outcome, target: { root: "/synthetic/source", path: "source.txt" } }
            : { outcome, reason: "source-modified" },
        );
        await request;
      });
      expect(openEditorFile).not.toHaveBeenCalled();
      expect(view.result.current?.editor?.stateFor(selected)).toBe("idle");
      expect(reports.flatMap((report) => report.citationActivation ?? [])).toEqual([]);
    },
  );

  it("does not open a text document after its chat window unmounts", async () => {
    const { selected, grounded } = editorFixture();
    const pending = deferredEditorTarget();
    vi.mocked(openKnowledgeCitationEditorTarget).mockReturnValue(pending.promise);
    const openEditorFile = vi.fn();
    const view = renderHook(() =>
      usePdfCitationPreviewController({
        answer: grounded,
        chatId: "chat-source",
        windows: undefined,
        openEditorFile,
      }),
    );
    await waitFor(() => expect(view.result.current?.editor?.stateFor(selected)).toBe("idle"));
    let request: Promise<void> | undefined;
    act(() => {
      request = view.result.current?.editor?.openCitation(selected);
    });
    view.unmount();
    await act(async () => {
      pending.resolve({
        outcome: "authorized",
        target: { root: "/synthetic/source", path: "source.txt" },
      });
      await request;
    });
    expect(openEditorFile).not.toHaveBeenCalled();
  });

  it.each(["server", "transport", "editor"] as const)(
    "reports a closed %s refusal without a false successful open",
    async (origin) => {
      const { selected, grounded } = editorFixture();
      if (origin === "transport")
        vi.mocked(openKnowledgeCitationEditorTarget).mockRejectedValue(
          new Error("synthetic private source body"),
        );
      else
        vi.mocked(openKnowledgeCitationEditorTarget).mockResolvedValue(
          origin === "server"
            ? { outcome: "rejected", reason: "editor-read-refused" }
            : { outcome: "authorized", target: { root: "/synthetic/source", path: "source.txt" } },
        );
      const openEditorFile = vi.fn(() => ({
        ok: false as const,
        message: "synthetic private failure",
      }));
      const reports: { message: string; meta: ClientDiagnosticMeta | undefined }[] = [];
      setClientDiagnosticWriter((message, meta) => reports.push({ message, meta }));
      const view = renderHook(() =>
        usePdfCitationPreviewController({
          answer: grounded,
          chatId: "chat-source",
          windows: undefined,
          openEditorFile,
        }),
      );
      await waitFor(() => expect(view.result.current?.editor?.stateFor(selected)).toBe("idle"));
      await act(async () => {
        await view.result.current?.editor?.openCitation(selected);
      });
      expect(view.result.current?.editor?.stateFor(selected)).toBe("failed");
      const authorized = origin === "editor";
      expect(reports.flatMap(({ meta }) => meta?.citationActivation ?? [])).toEqual([
        {
          reason: authorized ? "matched" : "unmatched",
          outcome: authorized ? "open-refused" : "refused",
          rootCount: authorized ? 1 : 0,
          matchCount: authorized ? 1 : 0,
        },
      ]);
      expect(JSON.stringify(reports)).not.toMatch(/synthetic|source.txt|private/u);
      await expectDiagnosticWireAccepted(reports);
    },
  );
});
