// Issue #211 — browser-tier MemoriaViva governance flows.
//
// The release branch uses Vitest + Testing Library as its browser-tier UI harness.
// These tests exercise the user journeys named by the issue in the same DOM event
// model used by the existing MemoriaViva component tests.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts";
import { MemoryList } from "./components/MemoryList";
import { ReviewQueue } from "./components/ReviewQueue";
import { EditMemoryDialog } from "./components/EditMemoryDialog";
import { MemoryActions } from "./components/MemoryActions";
import type { MemoryListResponse, MemoryReviewQueueResponse } from "@/lib/memory-api";

const pushMock = vi.fn();
let currentSearchParams: { get: (key: string) => string | null } = { get: () => null };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => currentSearchParams,
}));

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

beforeEach(() => {
  pushMock.mockReset();
  currentSearchParams = { get: () => null };
});

describe("MemoriaViva browser-tier flows", () => {
  it("covers filtering and empty-state behavior on the MemoriaViva route", async () => {
    const user = userEvent.setup();
    const fetchMemoriesImpl = vi.fn().mockResolvedValue(listResponse([]));

    render(<MemoryList fetchMemoriesImpl={fetchMemoriesImpl} />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-empty-state")).toBeInTheDocument();
    });
    expect(screen.getByText("No memories found")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Global" }));
    expect(pushMock).toHaveBeenLastCalledWith("/memoriaviva?scope=global");

    await user.click(screen.getByRole("button", { name: "Proposed" }));
    expect(pushMock).toHaveBeenLastCalledWith("/memoriaviva?status=proposed");
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
    expect(screen.getByText("conflicted")).toBeInTheDocument();
    expect(screen.getByText("Stale: source workflow was revoked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(acceptImpl).toHaveBeenCalledWith("mem-browser-proposed");
    });

    await user.click(screen.getByRole("button", { name: "Reject conflict" }));
    await waitFor(() => {
      expect(rejectImpl).toHaveBeenCalledWith(
        "mem-browser-conflict",
        "rejected conflict from review queue",
      );
    });

    await user.click(screen.getByRole("button", { name: "Archive stale" }));
    await waitFor(() => {
      expect(archiveImpl).toHaveBeenCalledWith(
        "mem-browser-stale",
        "archived stale memory from review queue",
      );
    });
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
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => {
      expect(deleteImpl).toHaveBeenCalledWith(
        "mem-browser-1",
        "user-initiated delete from MemoriaViva",
      );
      expect(onRecordChange).toHaveBeenCalledWith(null);
    });
  });
});
