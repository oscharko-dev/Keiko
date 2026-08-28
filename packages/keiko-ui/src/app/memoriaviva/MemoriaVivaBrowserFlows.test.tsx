// Issue #211 — browser-tier MemoriaViva governance flows.
//
// The release branch uses Vitest + Testing Library as its browser-tier UI harness.
// These tests exercise the user journeys named by the issue in the same DOM event
// model used by the existing MemoriaViva component tests.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts";
import { MemoryListContent } from "./components/MemoryList";
import type { MemoryFilterState } from "./components/MemoryFilters";
import { ReviewQueue } from "./components/ReviewQueue";
import { EditMemoryDialog } from "./components/EditMemoryDialog";
import { MemoryActions } from "./components/MemoryActions";
import type { MemoryListResponse, MemoryReviewQueueResponse } from "@/lib/memory-api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

// KEIKO-0650: the earlier MemoryList URL-state-sync wrapper (router.push on filter change) was
// removed as dead code once every production caller moved to MemoryListContent with explicit
// filters/onFilterChange props — none of ReviewQueue/EditMemoryDialog/MemoryActions use
// next/navigation, so the router/searchParams mock this file used only for MemoryList is gone too.

const emptyFilters: MemoryFilterState = {
  query: "",
  scope: [],
  type: [],
  status: [],
  sensitivity: [],
};

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-browser-1" as MemoryId,
    schemaVersion: "1",
    scope: { kind: "global" },
    type: "preference",
    body: "Prefer strict TypeScript in production code.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 1_700_000_000_000,
      confidence: 0.87,
      sensitivity: "public",
    },
    validity: { validFrom: 1_700_000_000_000 },
    status: "accepted",
    pinned: false,
    tags: ["typescript"],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function listResponse(records: readonly MemoryRecord[]): MemoryListResponse {
  return { memories: records, total: records.length, limit: 50, offset: 0 };
}

function queueResponse(records: readonly MemoryRecord[]): MemoryReviewQueueResponse {
  return { memories: records, total: records.length };
}

describe("MemoriaViva browser-tier flows", () => {
  afterEach(() => {
    resetClientDiagnosticWriter();
  });

  it("covers filtering and empty-state behavior on the MemoriaViva route", async () => {
    const user = userEvent.setup();
    const fetchMemoriesImpl = vi.fn().mockResolvedValue(listResponse([]));
    const onFilterChange = vi.fn();

    render(
      <MemoryListContent
        filters={emptyFilters}
        onFilterChange={onFilterChange}
        fetchMemoriesImpl={fetchMemoriesImpl}
        showWorkspaceBackLink
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("memory-empty-state")).toBeInTheDocument();
    });
    expect(screen.getByText("No memories found")).toBeInTheDocument();

    // The filter chips still dispatch through onFilterChange — MemoryListContent's caller (a
    // desktop window today) owns what happens next, no longer a router.push URL sync.
    await user.click(screen.getByRole("button", { name: "Global" }));
    expect(onFilterChange).toHaveBeenLastCalledWith({ ...emptyFilters, scope: ["global"] });

    await user.click(screen.getByRole("button", { name: "Proposed" }));
    expect(onFilterChange).toHaveBeenLastCalledWith({ ...emptyFilters, status: ["proposed"] });
  });

  it("covers review actions, conflict display, stale display, and stale archival", async () => {
    const user = userEvent.setup();
    const proposed = makeMemory({
      id: "mem-browser-proposed" as MemoryId,
      body: "Capture explicit team testing preference.",
      status: "proposed",
    });
    const conflicted = makeMemory({
      id: "mem-browser-conflict" as MemoryId,
      body: "Formatter is Prettier.",
      status: "conflicted",
    });
    const stale = makeMemory({
      id: "mem-browser-stale" as MemoryId,
      body: "Use retired release checklist.",
      staleReason: "source workflow was revoked",
    });
    const acceptImpl = vi.fn().mockResolvedValue({ memory: { ...proposed, status: "accepted" } });
    const rejectImpl = vi.fn().mockResolvedValue({ memory: { ...conflicted, status: "rejected" } });
    const archiveImpl = vi.fn().mockResolvedValue({ memory: { ...stale, status: "archived" } });

    render(
      <ReviewQueue
        fetchQueueImpl={vi.fn().mockResolvedValue(queueResponse([proposed, conflicted, stale]))}
        acceptImpl={acceptImpl}
        rejectImpl={rejectImpl}
        archiveImpl={archiveImpl}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Capture explicit team testing preference.")).toBeInTheDocument();
      expect(screen.getByText("Formatter is Prettier.")).toBeInTheDocument();
      expect(screen.getByText("Use retired release checklist.")).toBeInTheDocument();
    });
    expect(screen.getByText("Conflicted")).toBeInTheDocument();
    expect(screen.getByText("Stale: source workflow was revoked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(acceptImpl).toHaveBeenCalledWith("mem-browser-proposed");
    });

    // A conflicted record has no contract edge to `rejected` (MEMORY_STATUS_TRANSITIONS), so the
    // queue offers the legal, non-destructive exit instead.
    await user.click(screen.getByRole("button", { name: "Archive conflict" }));
    await waitFor(() => {
      expect(archiveImpl).toHaveBeenCalledWith(
        "mem-browser-conflict",
        "archived conflicting memory from review queue",
      );
    });
    expect(rejectImpl).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Archive stale" }));
    await waitFor(() => {
      expect(archiveImpl).toHaveBeenCalledWith(
        "mem-browser-stale",
        "archived stale memory from review queue",
      );
    });
  });

  it("requires the reviewer to select an ambiguous correction predecessor", async () => {
    const user = userEvent.setup();
    const correction = makeMemory({
      id: "mem-browser-correction" as MemoryId,
      type: "correction",
      body: "Release hardening uses vitest.",
      status: "proposed",
    });
    const first = makeMemory({
      id: "mem-browser-predecessor-1" as MemoryId,
      body: "<img src=x onerror=alert(1)> Release hardening uses jest.",
    });
    const second = makeMemory({
      id: "mem-browser-predecessor-2" as MemoryId,
      body: "Release hardening uses tap.",
    });
    const acceptImpl = vi.fn().mockResolvedValue({ memory: { ...correction, status: "accepted" } });

    const fetchPredecessors = vi.fn().mockResolvedValue({ candidates: [first, second] });
    const { container } = render(
      <ReviewQueue
        fetchQueueImpl={vi.fn().mockResolvedValue(queueResponse([correction]))}
        fetchCorrectionPredecessorsImpl={fetchPredecessors}
        acceptImpl={acceptImpl}
      />,
    );

    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(fetchPredecessors).not.toHaveBeenCalled();
    await user.click(approve);
    expect(acceptImpl).not.toHaveBeenCalled();
    const selector = await screen.findByLabelText("Memory being corrected");
    expect(selector).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    await user.selectOptions(selector, "mem-browser-predecessor-1");
    await user.click(approve);

    await waitFor(() => {
      expect(acceptImpl).toHaveBeenCalledWith("mem-browser-correction", {
        predecessorId: "mem-browser-predecessor-1",
      });
    });
  });

  it("binds a unique correction predecessor before acceptance", async () => {
    const user = userEvent.setup();
    const correction = makeMemory({
      id: "mem-browser-unique-correction" as MemoryId,
      type: "correction",
      status: "proposed",
    });
    const predecessor = makeMemory({ id: "mem-browser-unique-predecessor" as MemoryId });
    const acceptImpl = vi.fn().mockResolvedValue({ memory: { ...correction, status: "accepted" } });
    render(
      <ReviewQueue
        fetchQueueImpl={vi.fn().mockResolvedValue(queueResponse([correction]))}
        fetchCorrectionPredecessorsImpl={vi.fn().mockResolvedValue({ candidates: [predecessor] })}
        acceptImpl={acceptImpl}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Approve" }));
    expect(acceptImpl).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute(
        "aria-disabled",
        "false",
      );
    });
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(acceptImpl).toHaveBeenCalledWith("mem-browser-unique-correction", {
        predecessorId: "mem-browser-unique-predecessor",
      });
    });
  });

  it("keeps a correction blocked when no eligible predecessor exists", async () => {
    const user = userEvent.setup();
    const correction = makeMemory({
      id: "mem-browser-missing-predecessor" as MemoryId,
      type: "correction",
      status: "proposed",
    });
    const acceptImpl = vi.fn();
    render(
      <ReviewQueue
        fetchQueueImpl={vi.fn().mockResolvedValue(queueResponse([correction]))}
        fetchCorrectionPredecessorsImpl={vi.fn().mockResolvedValue({ candidates: [] })}
        acceptImpl={acceptImpl}
      />,
    );

    const approve = await screen.findByRole("button", { name: "Approve" });
    await user.click(approve);

    expect(await screen.findByRole("alert")).toHaveTextContent("No eligible predecessor remains.");
    expect(approve).toHaveAttribute("aria-disabled", "true");
    await user.click(approve);
    expect(acceptImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed correction predecessor data without replacing the review row", async () => {
    const user = userEvent.setup();
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    const correction = makeMemory({
      id: "mem-browser-malformed-predecessor" as MemoryId,
      type: "correction",
      status: "proposed",
    });
    const acceptImpl = vi.fn();
    render(
      <ReviewQueue
        fetchQueueImpl={vi.fn().mockResolvedValue(queueResponse([correction]))}
        fetchCorrectionPredecessorsImpl={vi.fn().mockResolvedValue({
          candidates: [{ id: "malformed", body: 42 }],
        } as never)}
        acceptImpl={acceptImpl}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Correction predecessors could not be verified.",
    );
    expect(screen.getByText(correction.body)).toBeInTheDocument();
    expect(acceptImpl).not.toHaveBeenCalled();
    expect(diagnostics).toContain(
      "[keiko] memory correction predecessor response rejected (kind=invalid-response)",
    );
  });

  it("covers edit, correction, and deletion controls without local file edits", async () => {
    const user = userEvent.setup();
    const record = makeMemory();
    const edited = makeMemory({
      body: "Prefer strict TypeScript and explicit return types.",
      provenance: { ...record.provenance, sensitivity: "confidential" },
      tags: ["typescript", "review"],
    });
    const onEditSave = vi.fn();
    const editMemoryImpl = vi.fn().mockResolvedValue({ memory: edited });

    const editView = render(
      <EditMemoryDialog
        record={record}
        onSave={onEditSave}
        onClose={vi.fn()}
        editMemoryImpl={editMemoryImpl}
      />,
    );

    await user.clear(screen.getByLabelText("Body"));
    await user.type(screen.getByLabelText("Body"), edited.body);
    await user.clear(screen.getByLabelText(/tags/i));
    await user.type(screen.getByLabelText(/tags/i), "typescript, review");
    await user.selectOptions(screen.getByLabelText("Sensitivity"), "confidential");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(editMemoryImpl).toHaveBeenCalledWith("mem-browser-1", {
        body: edited.body,
        tags: ["typescript", "review"],
        sensitivity: "confidential",
      });
      expect(onEditSave).toHaveBeenCalledWith(edited);
    });
    editView.unmount();

    const correction = makeMemory({
      id: "mem-browser-correction" as MemoryId,
      body: "Use unknown instead of any.",
      status: "proposed",
      type: "correction",
    });
    const correctMemoryImpl = vi.fn().mockResolvedValue({ correction });
    const onCorrectionSave = vi.fn();

    const correctionView = render(
      <EditMemoryDialog
        mode="correct"
        record={record}
        onSave={onCorrectionSave}
        onClose={vi.fn()}
        correctMemoryImpl={correctMemoryImpl}
      />,
    );

    await user.clear(screen.getByLabelText("Corrected body"));
    await user.type(screen.getByLabelText("Corrected body"), correction.body);
    await user.click(screen.getByRole("button", { name: "Submit correction" }));

    await waitFor(() => {
      expect(correctMemoryImpl).toHaveBeenCalledWith("mem-browser-1", correction.body);
      expect(onCorrectionSave).toHaveBeenCalledWith(correction);
    });
    correctionView.unmount();

    const onRecordChange = vi.fn();
    const deleteImpl = vi
      .fn()
      .mockResolvedValue({ deleted: true as const, memoryId: "mem-browser-1" });

    render(
      <MemoryActions record={record} onRecordChange={onRecordChange} deleteImpl={deleteImpl} />,
    );

    await user.click(screen.getByRole("button", { name: /delete this memory record/i }));
    expect(deleteImpl).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete record" }));

    await waitFor(() => {
      // KEIKO-0563: ForgetConfirmDialog (rendered inside MemoryActions) now calls deleteImpl with
      // only the id — the dead reason-string argument was removed.
      expect(deleteImpl).toHaveBeenCalledExactlyOnceWith("mem-browser-1");
      expect(onRecordChange).toHaveBeenCalledWith(null);
    });
  });
});
