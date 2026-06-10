// Issue #211 — tests for ForgetConfirmDialog: confirmation flow, delete mode, and focus trap.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { ForgetConfirmDialog } from "./ForgetConfirmDialog";
import type { MemoryRecord, MemoryId } from "@oscharko-dev/keiko-contracts";

function makeRecord(body = "Use strict mode always."): MemoryRecord {
  return {
    id: "mem-forget-1" as MemoryId,
    schemaVersion: "1",
    scope: { kind: "global" },
    type: "preference",
    body,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: 1_700_000_000_000,
      confidence: 0.9,
      sensitivity: "public",
    },
    validity: { validFrom: 1_700_000_000_000 },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

describe("ForgetConfirmDialog — rendering", () => {
  it("renders the memory body in the blockquote", () => {
    render(
      <ForgetConfirmDialog
        record={makeRecord()}
        onComplete={vi.fn()}
        onClose={vi.fn()}
        forgetMemoryImpl={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/memory content to be removed/i)).toHaveTextContent(
      "Use strict mode always.",
    );
  });

  it("renders delete mode copy", () => {
    render(
      <ForgetConfirmDialog
        mode="delete"
        record={makeRecord()}
        onComplete={vi.fn()}
        onClose={vi.fn()}
        deleteMemoryImpl={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: /delete this memory/i })).toBeInTheDocument();
    expect(screen.getByText(/hard-deleted without a tombstone audit record/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete permanently/i })).toBeInTheDocument();
  });
});

describe("ForgetConfirmDialog — interaction", () => {
  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ForgetConfirmDialog
        record={makeRecord()}
        onComplete={vi.fn()}
        onClose={onClose}
        forgetMemoryImpl={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ForgetConfirmDialog
        record={makeRecord()}
        onComplete={vi.fn()}
        onClose={onClose}
        forgetMemoryImpl={vi.fn()}
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
        <ForgetConfirmDialog
          record={makeRecord()}
          onComplete={vi.fn()}
          onClose={vi.fn()}
          forgetMemoryImpl={vi.fn()}
        />
        <button type="button">After</button>
      </div>,
    );

    const cancel = screen.getByRole("button", { name: /cancel/i });
    const confirm = screen.getByRole("button", { name: /forget permanently/i });

    await waitFor(() => {
      expect(cancel).toHaveFocus();
    });
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it("calls forgetMemoryImpl and then onComplete when confirmed", async () => {
    const forgetImpl = vi
      .fn()
      .mockResolvedValue({ forgotten: true as const, memoryId: "mem-forget-1" });
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(
      <ForgetConfirmDialog
        record={makeRecord()}
        onComplete={onComplete}
        onClose={vi.fn()}
        forgetMemoryImpl={forgetImpl}
      />,
    );
    await user.click(screen.getByRole("button", { name: /forget permanently/i }));
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledOnce();
    });
    expect(forgetImpl).toHaveBeenCalledWith("mem-forget-1", expect.any(String));
  });

  it("calls deleteMemoryImpl and then onComplete in delete mode", async () => {
    const deleteImpl = vi
      .fn()
      .mockResolvedValue({ deleted: true as const, memoryId: "mem-forget-1" });
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(
      <ForgetConfirmDialog
        mode="delete"
        record={makeRecord()}
        onComplete={onComplete}
        onClose={vi.fn()}
        deleteMemoryImpl={deleteImpl}
      />,
    );
    await user.click(screen.getByRole("button", { name: /delete permanently/i }));
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledOnce();
    });
    expect(deleteImpl).toHaveBeenCalledWith("mem-forget-1");
  });

  it("shows error alert when the destructive action rejects", async () => {
    const forgetImpl = vi.fn().mockRejectedValue(new Error("forget failed"));
    const user = userEvent.setup();
    render(
      <ForgetConfirmDialog
        record={makeRecord()}
        onComplete={vi.fn()}
        onClose={vi.fn()}
        forgetMemoryImpl={forgetImpl}
      />,
    );
    await user.click(screen.getByRole("button", { name: /forget permanently/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/forget failed/i)).toBeInTheDocument();
    });
  });
});

describe("ForgetConfirmDialog — a11y", () => {
  it("jest-axe: dialog has no violations", async () => {
    const { container } = render(
      <ForgetConfirmDialog
        record={makeRecord()}
        onComplete={vi.fn()}
        onClose={vi.fn()}
        forgetMemoryImpl={vi.fn()}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
