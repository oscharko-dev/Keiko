// Issue #211 — tests for EditMemoryDialog: form fields, save, cancel, validation, focus trap.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { EditMemoryDialog } from "./EditMemoryDialog";
import type { MemoryRecord, MemoryId } from "@oscharko-dev/keiko-contracts";

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-edit-1" as MemoryId,
    schemaVersion: "1",
    scope: { kind: "global" },
    type: "preference",
    body: "Original body text",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 1_700_000_000_000,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: 1_700_000_000_000 },
    status: "accepted",
    pinned: false,
    tags: ["typescript", "style"],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("EditMemoryDialog — rendering", () => {
  it("renders with existing body, tags, and sensitivity", () => {
    render(
      <EditMemoryDialog
        record={makeRecord()}
        onSave={vi.fn()}
        onClose={vi.fn()}
        editMemoryImpl={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/body/i)).toHaveValue("Original body text");
    expect(screen.getByLabelText(/tags/i)).toHaveValue("typescript, style");
    expect(screen.getByLabelText(/sensitivity/i)).toHaveValue("public");
  });

  it("renders correction mode with correction-specific copy", () => {
    render(
      <EditMemoryDialog
        mode="correct"
        record={makeRecord()}
        onSave={vi.fn()}
        onClose={vi.fn()}
        correctMemoryImpl={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: /correct memory/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/corrected body/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/tags/i)).toBeNull();
    expect(screen.queryByLabelText(/sensitivity/i)).toBeNull();
  });
});

describe("EditMemoryDialog — interaction", () => {
  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <EditMemoryDialog
        record={makeRecord()}
        onSave={vi.fn()}
        onClose={onClose}
        editMemoryImpl={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <EditMemoryDialog
        record={makeRecord()}
        onSave={vi.fn()}
        onClose={onClose}
        editMemoryImpl={vi.fn()}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("traps Tab and Shift+Tab within the dialog", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Before</button>
        <EditMemoryDialog
          record={makeRecord()}
          onSave={vi.fn()}
          onClose={vi.fn()}
          editMemoryImpl={vi.fn()}
        />
        <button type="button">After</button>
      </div>,
    );

    const body = screen.getByLabelText(/body/i);
    const tags = screen.getByLabelText(/tags/i);
    const sensitivity = screen.getByLabelText(/sensitivity/i);
    const cancel = screen.getByRole("button", { name: /cancel/i });
    const save = screen.getByRole("button", { name: /^save$/i });

    await waitFor(() => {
      expect(body).toHaveFocus();
    });
    await user.tab();
    expect(tags).toHaveFocus();
    await user.tab();
    expect(sensitivity).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(save).toHaveFocus();
    await user.tab();
    expect(body).toHaveFocus();
    await user.tab({ shift: true });
    expect(save).toHaveFocus();
  });

  it("shows validation error when body is cleared", async () => {
    const editImpl = vi.fn();
    const user = userEvent.setup();
    render(
      <EditMemoryDialog
        record={makeRecord()}
        onSave={vi.fn()}
        onClose={vi.fn()}
        editMemoryImpl={editImpl}
      />,
    );
    await user.clear(screen.getByLabelText(/body/i));
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(editImpl).not.toHaveBeenCalled();
  });

  it("calls editMemoryImpl with updated values and then onSave", async () => {
    const updatedRecord = makeRecord({ body: "Updated body" });
    const editImpl = vi.fn().mockResolvedValue({ memory: updatedRecord });
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <EditMemoryDialog
        record={makeRecord()}
        onSave={onSave}
        onClose={vi.fn()}
        editMemoryImpl={editImpl}
      />,
    );
    await user.clear(screen.getByLabelText(/body/i));
    await user.type(screen.getByLabelText(/body/i), "Updated body");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(updatedRecord);
    });
    expect(editImpl).toHaveBeenCalledWith(
      "mem-edit-1",
      expect.objectContaining({ body: "Updated body" }),
    );
  });

  it("calls correctMemoryImpl and returns the new correction record in correction mode", async () => {
    const correction = makeRecord({ id: "mem-correction-1" as MemoryId, type: "correction", status: "proposed" });
    const correctImpl = vi.fn().mockResolvedValue({
      correction,
      originalMemoryId: "mem-edit-1",
    });
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <EditMemoryDialog
        mode="correct"
        record={makeRecord()}
        onSave={onSave}
        onClose={vi.fn()}
        correctMemoryImpl={correctImpl}
      />,
    );
    await user.clear(screen.getByLabelText(/corrected body/i));
    await user.type(screen.getByLabelText(/corrected body/i), "Corrected body");
    await user.click(screen.getByRole("button", { name: /submit correction/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(correction);
    });
    expect(correctImpl).toHaveBeenCalledWith("mem-edit-1", "Corrected body");
  });

  it("shows error alert when editMemoryImpl rejects", async () => {
    const editImpl = vi.fn().mockRejectedValue(new Error("save failed"));
    const user = userEvent.setup();
    render(
      <EditMemoryDialog
        record={makeRecord()}
        onSave={vi.fn()}
        onClose={vi.fn()}
        editMemoryImpl={editImpl}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/save failed/i)).toBeInTheDocument();
    });
  });
});

describe("EditMemoryDialog — a11y", () => {
  it("jest-axe: dialog has no violations", async () => {
    const { container } = render(
      <EditMemoryDialog
        record={makeRecord()}
        onSave={vi.fn()}
        onClose={vi.fn()}
        editMemoryImpl={vi.fn()}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
