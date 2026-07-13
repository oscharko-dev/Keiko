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
    expect(screen.getByRole("heading", { name: /delete this memory record/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /delete record/i }));
    await waitFor(() => {
      expect(deleteImpl).toHaveBeenCalledWith(
        "mem-actions-1",
        "user-initiated delete from MemoriaViva",
      );
      expect(onRecordChange).toHaveBeenCalledWith(null);
    });
  });

  // Covers PinToggleButton (pin path): non-pinned, non-forgotten → click Pin.
  it("pins an unpinned memory via PinToggleButton", async () => {
    const pinned = makeRecord({ pinned: true });
    const pinImpl = vi.fn().mockResolvedValue({ memory: pinned });
    const onRecordChange = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryActions
        record={makeRecord({ pinned: false })}
        onRecordChange={onRecordChange}
        pinImpl={pinImpl}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /pin this memory for priority retrieval/i }),
    );

    await waitFor(() => {
      expect(pinImpl).toHaveBeenCalledWith("mem-actions-1");
      expect(onRecordChange).toHaveBeenCalledWith(pinned);
    });
  });

  // Covers PinToggleButton (unpin path): pinned, non-forgotten → click Unpin.
  it("unpins a pinned memory via PinToggleButton", async () => {
    const unpinned = makeRecord({ pinned: false });
    const unpinImpl = vi.fn().mockResolvedValue({ memory: unpinned });
    const onRecordChange = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryActions
        record={makeRecord({ pinned: true })}
        onRecordChange={onRecordChange}
        unpinImpl={unpinImpl}
      />,
    );

    await user.click(screen.getByRole("button", { name: /unpin this memory/i }));

    await waitFor(() => {
      expect(unpinImpl).toHaveBeenCalledWith("mem-actions-1");
      expect(onRecordChange).toHaveBeenCalledWith(unpinned);
    });
  });

  // Covers ArchiveButton for canArchive statuses.
  it("archives a memory in an archivable status (accepted)", async () => {
    const archived = makeRecord({ status: "archived" as MemoryRecord["status"] });
    const archiveImpl = vi.fn().mockResolvedValue({ memory: archived });
    const onRecordChange = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryActions
        record={makeRecord({ status: "accepted" })}
        onRecordChange={onRecordChange}
        archiveImpl={archiveImpl}
      />,
    );

    await user.click(screen.getByRole("button", { name: /archive this memory/i }));

    await waitFor(() => {
      expect(archiveImpl).toHaveBeenCalledWith("mem-actions-1", "archived by user in MemoriaViva");
      expect(onRecordChange).toHaveBeenCalledWith(archived);
    });
  });

  // Covers ArchiveButton's non-rendered branch (canArchive false).
  it("does not render the archive button for non-archivable statuses (proposed)", () => {
    render(<MemoryActions record={makeRecord({ status: "proposed" })} onRecordChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /archive this memory/i })).toBeNull();
  });

  // Covers ForgetButton path: opens the ForgetConfirmDialog.
  it("opens the forget confirmation dialog when Forget memory is clicked", async () => {
    const user = userEvent.setup();
    render(<MemoryActions record={makeRecord()} onRecordChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /forget this memory/i }));

    expect(await screen.findByRole("heading", { name: /forget this memory/i })).toBeInTheDocument();
  });

  // Covers the forgotten-record branch: EditCorrectButtons, PinToggleButton
  // and ForgetButton return null; only Delete is shown.
  it("hides edit/correct/pin/forget when the record is already forgotten", () => {
    render(<MemoryActions record={makeRecord({ status: "forgotten" })} onRecordChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /edit memory body/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /create a correction proposal/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /pin this memory/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /forget this memory/i })).toBeNull();
    expect(screen.getByRole("button", { name: /delete this memory record/i })).toBeInTheDocument();
  });

  // Covers handleOpenEdit body + onEditClose (edit-dialog cancel path).
  it("opens the edit dialog and closes it via the cancel control", async () => {
    const user = userEvent.setup();
    render(<MemoryActions record={makeRecord()} onRecordChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /edit memory body/i }));
    expect(await screen.findByLabelText(/^body$/i, { selector: "textarea" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByLabelText(/^body$/i, { selector: "textarea" })).toBeNull();
    });
  });

  // Covers handleOpenCorrect body + onCorrectClose (correct-dialog cancel path).
  it("opens the correction dialog and closes it via the cancel control", async () => {
    const user = userEvent.setup();
    render(<MemoryActions record={makeRecord()} onRecordChange={vi.fn()} />);

    await user.click(
      screen.getByRole("button", { name: /create a correction proposal for this memory/i }),
    );
    expect(
      await screen.findByLabelText(/corrected body/i, { selector: "textarea" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByLabelText(/corrected body/i, { selector: "textarea" })).toBeNull();
    });
  });

  // Covers onForgetClose (forget-dialog cancel path).
  it("opens the forget dialog and closes it via the cancel control", async () => {
    const user = userEvent.setup();
    render(<MemoryActions record={makeRecord()} onRecordChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /forget this memory/i }));
    expect(await screen.findByRole("heading", { name: /forget this memory/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /forget this memory/i })).toBeNull();
    });
  });

  // Covers onDeleteClose (delete-dialog cancel path).
  it("opens the delete dialog and closes it via the cancel control", async () => {
    const user = userEvent.setup();
    render(<MemoryActions record={makeRecord()} onRecordChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /delete this memory record/i }));
    expect(
      await screen.findByRole("heading", { name: /delete this memory record/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /delete this memory record/i })).toBeNull();
    });
  });
});
