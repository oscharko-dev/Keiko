// Unit tests for CandidateEditForm (Epic #712, Issue #727). Covers the minimal changed-field diff
// (only edited fields submitted; lines→list, comma→tags), keyboard accessibility (the title field is
// focused when the form opens so a keyboard user is not stranded, and Escape cancels when focus is in
// the form), and the disabled-while-saving affordance.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CandidateEditForm } from "./CandidateEditForm";
import type { QualityIntelligenceUiCandidate } from "@oscharko-dev/keiko-contracts";

function makeCandidate(
  overrides: Partial<QualityIntelligenceUiCandidate> = {},
): QualityIntelligenceUiCandidate {
  return {
    id: "tc-edit-1",
    derivedFromAtomIds: [],
    title: "Original title",
    preconditions: ["pre one"],
    steps: ["step one", "step two"],
    expectedResults: ["result one"],
    priority: "P2",
    riskClass: "functional",
    tags: ["smoke", "regression"],
    status: "proposed",
    reviewState: "open",
    ...overrides,
  };
}

describe("CandidateEditForm", () => {
  it("focuses the title field when the form opens (no keyboard dead-end)", () => {
    render(<CandidateEditForm candidate={makeCandidate()} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: /^title$/i })).toHaveFocus();
  });

  it("submits only the changed fields (minimal diff)", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CandidateEditForm candidate={makeCandidate()} onSave={onSave} onCancel={vi.fn()} />);
    const title = screen.getByRole("textbox", { name: /^title$/i });
    await user.clear(title);
    await user.type(title, "Curated title");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ title: "Curated title" });
  });

  it("parses a multi-line steps field into a trimmed, non-empty list", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CandidateEditForm candidate={makeCandidate()} onSave={onSave} onCancel={vi.fn()} />);
    const steps = screen.getByRole("textbox", { name: /steps/i });
    await user.clear(steps);
    await user.type(steps, "  do A  {enter}{enter}do B  ");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ steps: ["do A", "do B"] });
  });

  it("parses a comma-separated tags field, dropping blanks", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CandidateEditForm candidate={makeCandidate()} onSave={onSave} onCancel={vi.fn()} />);
    const tags = screen.getByRole("textbox", { name: /tags/i });
    await user.clear(tags);
    await user.type(tags, "alpha, , beta");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ tags: ["alpha", "beta"] });
  });

  it("does not submit any field when nothing changed", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CandidateEditForm candidate={makeCandidate()} onSave={onSave} onCancel={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({});
  });

  it("Escape cancels the edit when focus is inside the form", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<CandidateEditForm candidate={makeCandidate()} onSave={vi.fn()} onCancel={onCancel} />);
    // The title field is auto-focused on open, so focus is inside the form.
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does NOT cancel on Escape when focus is outside the form", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <>
        <button type="button">outside</button>
        <CandidateEditForm candidate={makeCandidate()} onSave={vi.fn()} onCancel={onCancel} />
      </>,
    );
    screen.getByRole("button", { name: "outside" }).focus();
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("requires a second Escape to discard unsaved changes (two-stage discard, F029 C279)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<CandidateEditForm candidate={makeCandidate()} onSave={vi.fn()} onCancel={onCancel} />);
    await user.type(screen.getByRole("textbox", { name: /^title$/i }), " edited");
    await user.keyboard("{Escape}");
    // First Escape warns instead of destroying the edits.
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/unsaved changes/i);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("re-arms the discard warning when the user keeps editing after the first Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<CandidateEditForm candidate={makeCandidate()} onSave={vi.fn()} onCancel={onCancel} />);
    const title = screen.getByRole("textbox", { name: /^title$/i });
    await user.type(title, " edited");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("status")).toHaveTextContent(/unsaved changes/i);
    // Continuing to edit clears the warning; the next Escape warns again instead of discarding.
    await user.type(title, "!");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels immediately via the Cancel button when the form is pristine", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<CandidateEditForm candidate={makeCandidate()} onSave={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
