// Issue #211 — tests for EditMemoryDialog: form fields, save, cancel, validation.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { EditMemoryDialog } from "./EditMemoryDialog";
import type { MemoryRecord, MemoryId } from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    const select = screen.getByLabelText(/sensitivity/i) as HTMLSelectElement;
    expect(select.value).toBe("public");
  });

  it("has Save and Cancel buttons", () => {
    render(
      <EditMemoryDialog
        record={makeRecord()}
        onSave={vi.fn()}
        onClose={vi.fn()}
        editMemoryImpl={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
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
    const bodyField = screen.getByLabelText(/body/i);
    await user.clear(bodyField);
    await user.click(screen.getByRole("button", { name: /save/i }));
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
    const bodyField = screen.getByLabelText(/body/i);
    await user.clear(bodyField);
    await user.type(bodyField, "Updated body");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(updatedRecord);
    });
    expect(editImpl).toHaveBeenCalledWith(
      "mem-edit-1",
      expect.objectContaining({ body: "Updated body" }),
    );
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
    await user.click(screen.getByRole("button", { name: /save/i }));
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
