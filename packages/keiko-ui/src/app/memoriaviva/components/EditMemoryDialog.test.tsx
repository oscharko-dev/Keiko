// Issue #211 — tests for EditMemoryDialog: form fields, save, cancel, validation, focus trap.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { EditMemoryDialog } from "./EditMemoryDialog";
import { MemoryDetail } from "./MemoryDetail";
import { ApiError } from "@/lib/api-shared-primitives";
import { acceptMemoryProposal, editMemory, type MemoryDetailResponse } from "@/lib/memory-api";
import { deferred } from "./__tests__/test-support";
import type { MemoryRecord, MemoryId } from "@oscharko-dev/keiko-contracts";
import { PROFILE_EXCLUDED_MEMORY_TAG } from "@oscharko-dev/keiko-contracts/runtime/memory";

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
  it("restores keyboard focus during a slow canonical reload without reopening stale content", async () => {
    const original = makeRecord();
    const edited = {
      ...original,
      body: "Revised keyboard note",
      updatedAt: original.updatedAt + 1,
    };
    const refresh = deferred<MemoryDetailResponse>();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ memory: original })
      .mockReturnValue(refresh.promise);
    const user = userEvent.setup();
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ memory: edited }));
    try {
      render(<MemoryDetail id={original.id} fetchMemoryImpl={load} />);
      const trigger = await screen.findByRole("button", { name: /edit memory body/i });
      trigger.focus();
      await user.keyboard("{Enter}");
      const field = screen.getByRole("textbox", { name: /^body/i });
      await user.clear(field);
      await user.type(field, edited.body);
      await user.click(screen.getByRole("button", { name: /^save/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(trigger).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByText(original.body)).not.toBeInTheDocument();
      await act(async () => {
        refresh.resolve({ memory: edited });
      });
      expect(await screen.findByText(edited.body)).toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(trigger).toHaveAttribute("aria-disabled", "false");
    } finally {
      network.mockRestore();
    }
  });

  it("preserves the open form and draft when another view accepts the proposal", async () => {
    const proposed = makeRecord({ status: "proposed" });
    const accepted = {
      ...proposed,
      status: "accepted" as const,
      updatedAt: proposed.updatedAt + 1,
    };
    const refresh = deferred<MemoryDetailResponse>();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ memory: proposed })
      .mockReturnValueOnce(refresh.promise);
    const user = userEvent.setup();
    render(<MemoryDetail id={proposed.id} fetchMemoryImpl={load} onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /edit memory body/i }));
    const input = screen.getByRole("textbox", { name: /^body/i });
    await user.clear(input);
    await user.type(input, "My unsaved replacement");
    await act(async () => {
      await acceptMemoryProposal(proposed.id, {}, async () => ({ memory: accepted }));
    });
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("My unsaved replacement");
    await act(async () => refresh.resolve({ memory: accepted }));
    expect(input).toHaveFocus();
    expect(input).toHaveValue("My unsaved replacement");
  });

  it("keeps the draft and explains a conflicting content edit from another view", async () => {
    const previous = makeRecord();
    const edited = { ...previous, body: "Other window edit", updatedAt: previous.updatedAt + 1 };
    const load = vi
      .fn()
      .mockResolvedValueOnce({ memory: previous })
      .mockResolvedValueOnce({ memory: edited });
    const user = userEvent.setup();
    render(<MemoryDetail id={previous.id} fetchMemoryImpl={load} onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /edit memory body/i }));
    const input = screen.getByRole("textbox", { name: /^body/i });
    await user.clear(input);
    await user.type(input, "My unsaved replacement");
    await act(async () => {
      await editMemory(previous.id, { body: edited.body }, async () => ({ memory: edited }));
    });
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("My unsaved replacement");
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed/i);
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

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

  it("leaves Keiko's profile exclusion out of the editable tags (#4228)", () => {
    render(
      <EditMemoryDialog
        record={makeRecord({ tags: ["typescript", PROFILE_EXCLUDED_MEMORY_TAG] })}
        onSave={vi.fn()}
        onClose={vi.fn()}
        editMemoryImpl={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/tags/i)).toHaveValue("typescript");
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
  it("locks workspace shell interactions while the modal is mounted", () => {
    const view = render(
      <EditMemoryDialog
        record={makeRecord()}
        onSave={vi.fn()}
        onClose={vi.fn()}
        editMemoryImpl={vi.fn()}
      />,
    );

    expect(document.documentElement).toHaveAttribute("data-keiko-modal-open", "true");

    view.unmount();
    expect(document.documentElement).not.toHaveAttribute("data-keiko-modal-open");
  });

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
    await waitFor(() => expect(screen.getByLabelText(/body/i)).toHaveFocus());
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
    expect(editImpl).toHaveBeenCalledWith("mem-edit-1", {
      body: "Updated body",
      expectedUpdatedAt: updatedRecord.updatedAt,
    });
  });

  it("sends only edited tags and leaves a learned body's evidence and sensitivity untouched", async () => {
    const record = makeRecord();
    const save = vi.fn().mockResolvedValue({ memory: record });
    const user = userEvent.setup();
    render(
      <EditMemoryDialog record={record} editMemoryImpl={save} onSave={vi.fn()} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByRole("textbox", { name: /^body/i })).toHaveFocus());
    const input = screen.getByRole("textbox", { name: /tags/i });
    await user.clear(input);
    await user.type(input, "new tag");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(save).toHaveBeenCalledExactlyOnceWith(record.id, {
      tags: ["new tag"],
      expectedUpdatedAt: record.updatedAt,
    });
  });

  it("closes an unchanged form without writing a new revision", async () => {
    const record = makeRecord({ tags: ["design, research", "release"] });
    const save = vi.fn().mockResolvedValue({ memory: record });
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <EditMemoryDialog record={record} editMemoryImpl={save} onSave={onSave} onClose={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(save).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(record);
  });

  it("calls correctMemoryImpl and returns the new correction record in correction mode", async () => {
    const correction = makeRecord({
      id: "mem-correction-1" as MemoryId,
      type: "correction",
      status: "proposed",
    });
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

  it("retains the draft when the server detects a newer edit before a view notification arrives", async () => {
    const record = makeRecord();
    const edit = vi.fn().mockRejectedValue(new ApiError("CONFLICT", "Version changed", 409));
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <EditMemoryDialog record={record} editMemoryImpl={edit} onSave={onSave} onClose={vi.fn()} />,
    );
    const input = screen.getByRole("textbox", { name: /^body/i });
    await user.clear(input);
    await user.type(input, "My pending edit");
    const save = screen.getByRole("button", { name: /^save$/i });
    await user.click(save);
    expect(edit).toHaveBeenCalledExactlyOnceWith(
      record.id,
      expect.objectContaining({
        body: "My pending edit",
        expectedUpdatedAt: record.updatedAt,
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed/i);
    expect(input).toHaveValue("My pending edit");
    expect(save).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
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
    await user.type(screen.getByRole("textbox", { name: /^body/i }), " edited");
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
