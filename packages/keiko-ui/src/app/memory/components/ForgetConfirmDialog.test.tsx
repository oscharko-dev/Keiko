// Issue #211 — tests for ForgetConfirmDialog: confirmation flow, cancel, error recovery.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { ForgetConfirmDialog } from "./ForgetConfirmDialog";
import type { MemoryRecord, MemoryId } from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ForgetConfirmDialog — rendering", () => {
  it("renders the memory body in the blockquote", () => {
    render(
      <ForgetConfirmDialog
        record={makeRecord()}
        onForgotten={vi.fn()}
        onClose={vi.fn()}
        forgetMemoryImpl={vi.fn()}
      />,
    );
    expect(screen.getByRole("blockquote")).toHaveTextContent("Use strict mode always.");
  });

  it("has Cancel and Forget permanently buttons", () => {
    render(
      <ForgetConfirmDialog
        record={makeRecord()}
        onForgotten={vi.fn()}
        onClose={vi.fn()}
        forgetMemoryImpl={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /forget permanently/i })).toBeInTheDocument();
  });

  it("truncates long body text in the quote", () => {
    const longBody = "x".repeat(150);
    render(
      <ForgetConfirmDialog
        record={makeRecord(longBody)}
        onForgotten={vi.fn()}
        onClose={vi.fn()}
        forgetMemoryImpl={vi.fn()}
      />,
    );
    const quote = screen.getByRole("blockquote");
    expect(quote.textContent?.length).toBeLessThan(130);
    expect(quote.textContent).toContain("…");
  });
});

describe("ForgetConfirmDialog — interaction", () => {
  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ForgetConfirmDialog
        record={makeRecord()}
        onForgotten={vi.fn()}
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
        onForgotten={vi.fn()}
        onClose={onClose}
        forgetMemoryImpl={vi.fn()}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls forgetMemoryImpl and then onForgotten when confirmed", async () => {
    const forgetImpl = vi
      .fn()
      .mockResolvedValue({ forgotten: true as const, memoryId: "mem-forget-1" });
    const onForgotten = vi.fn();
    const user = userEvent.setup();
    render(
      <ForgetConfirmDialog
        record={makeRecord()}
        onForgotten={onForgotten}
        onClose={vi.fn()}
        forgetMemoryImpl={forgetImpl}
      />,
    );
    await user.click(screen.getByRole("button", { name: /forget permanently/i }));
    await waitFor(() => {
      expect(onForgotten).toHaveBeenCalledOnce();
    });
    expect(forgetImpl).toHaveBeenCalledWith("mem-forget-1", expect.any(String));
  });

  it("shows error alert when forgetMemoryImpl rejects", async () => {
    const forgetImpl = vi.fn().mockRejectedValue(new Error("forget failed"));
    const user = userEvent.setup();
    render(
      <ForgetConfirmDialog
        record={makeRecord()}
        onForgotten={vi.fn()}
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
        onForgotten={vi.fn()}
        onClose={vi.fn()}
        forgetMemoryImpl={vi.fn()}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
