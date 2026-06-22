import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryActions } from "./MemoryActions";
import type { MemoryRecord, MemoryId } from "@oscharko-dev/keiko-contracts";

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-actions-1" as MemoryId,
    schemaVersion: "1",
    scope: { kind: "global" },
    type: "preference",
    body: "Prefer strict typing.",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 1_700_000_000_000,
      confidence: 0.9,
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

describe("MemoryActions", () => {
  it("approves proposed memories from the detail action group", async () => {
    const approved = makeRecord({ status: "accepted" });
    const acceptImpl = vi.fn().mockResolvedValue({ memory: approved });
    const onRecordChange = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryActions
        record={makeRecord({ status: "proposed" })}
        onRecordChange={onRecordChange}
        acceptImpl={acceptImpl}
      />,
    );

    await user.click(screen.getByRole("button", { name: /approve this memory proposal/i }));

    await waitFor(() => {
      expect(acceptImpl).toHaveBeenCalledWith("mem-actions-1");
      expect(onRecordChange).toHaveBeenCalledWith(approved);
    });
  });

  it("rejects proposed memories from the detail action group", async () => {
    const rejected = makeRecord({ status: "rejected" });
    const rejectImpl = vi.fn().mockResolvedValue({ memory: rejected });
    const onRecordChange = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryActions
        record={makeRecord({ status: "proposed" })}
        onRecordChange={onRecordChange}
        rejectImpl={rejectImpl}
      />,
    );

    await user.click(screen.getByRole("button", { name: /reject this memory proposal/i }));

    await waitFor(() => {
      expect(rejectImpl).toHaveBeenCalledWith("mem-actions-1", "rejected by user in MemoriaViva");
      expect(onRecordChange).toHaveBeenCalledWith(rejected);
    });
  });

  it("renders the Correct action for non-forgotten memories", () => {
    render(<MemoryActions record={makeRecord()} onRecordChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /create a correction proposal for this memory/i }),
    ).toBeInTheDocument();
  });

  it("shows mc-action-notice after a correction is submitted", async () => {
    const correctionRecord = makeRecord({ body: "Use unknown not any." });
    const correctImpl = vi.fn().mockResolvedValue({ correction: correctionRecord });
    const user = userEvent.setup();

    render(
      <MemoryActions record={makeRecord()} onRecordChange={vi.fn()} correctImpl={correctImpl} />,
    );

    await user.click(
      screen.getByRole("button", { name: /create a correction proposal for this memory/i }),
    );
    const textarea = screen.getByLabelText(/corrected body/i);
    await user.clear(textarea);
    await user.type(textarea, "Use unknown not any.");
    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await waitFor(() => {
      const notice = screen.getByRole("status");
      expect(notice).toBeInTheDocument();
      expect(notice.className).toContain("mc-action-notice");
      expect(notice).toHaveTextContent("Correction submitted for review:");
    });
  });

  it("gates hard delete behind an explicit confirmation step", async () => {
    const deleteImpl = vi
      .fn()
      .mockResolvedValue({ deleted: true as const, memoryId: "mem-actions-1" });
    const onRecordChange = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryActions
        record={makeRecord()}
        onRecordChange={onRecordChange}
        deleteImpl={deleteImpl}
      />,
    );

    await user.click(screen.getByRole("button", { name: /delete this memory record/i }));
    expect(deleteImpl).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /delete this memory/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /delete permanently/i }));
    await waitFor(() => {
      expect(deleteImpl).toHaveBeenCalledWith(
        "mem-actions-1",
        "user-initiated delete from MemoriaViva",
      );
      expect(onRecordChange).toHaveBeenCalledWith(null);
    });
  });
});
