// Issue #280 (Epic #270) — CandidatesPane component tests.
//
// Tests cover:
//   - Empty state: no candidates → "No test cases" message.
//   - Card rendering: one card per candidate with title, priority, riskClass, review badge,
//     preconditions, steps, expectedResults lists, and tags.
//   - onReview present: Approve/Reject/Request-changes buttons render.
//   - onReview present: clicking Approve calls onReview(id, "approve").
//   - onReview present: clicking Reject calls onReview(id, "reject").
//   - onReview present: clicking Request-changes calls onReview(id, "request-changes").
//   - onReview absent: no review buttons rendered.
//   - Progressive rendering: >25 candidates renders exactly 25 cards + "Show more" button.
//   - Show more: clicking "Show more" reveals additional cards.
//   - aria-pressed on review buttons reflects candidate.reviewState.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CandidatesPane } from "./CandidatesPane";
import type { QualityIntelligenceUiCandidate } from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
//
// The pane consumes the browser-safe `QualityIntelligenceUiCandidate` projection, which carries the
// human `reviewState` ("open" until a reviewer acts) alongside the generation `status`. The review
// badge and the Approve/Reject/Request-changes pressed states are driven by `reviewState`, NOT by the
// generation `status` — they are distinct concepts on the wire shape.

let candidateCounter = 0;

function makeCandidate(
  overrides: Partial<QualityIntelligenceUiCandidate> = {},
): QualityIntelligenceUiCandidate {
  candidateCounter += 1;
  const id = `tc-${String(candidateCounter).padStart(3, "0")}`;
  return {
    id,
    derivedFromAtomIds: [],
    title: `Test case ${id}`,
    preconditions: ["User is logged in"],
    steps: ["Navigate to the page", "Click submit"],
    expectedResults: ["Form is submitted successfully"],
    priority: "P1",
    riskClass: "functional",
    tags: ["smoke", "regression"],
    status: "proposed",
    reviewState: "open",
    ...overrides,
  };
}

function makeCandidates(count: number): QualityIntelligenceUiCandidate[] {
  return Array.from({ length: count }, () => makeCandidate());
}

// ---------------------------------------------------------------------------
// Tests — empty state
// ---------------------------------------------------------------------------

describe("CandidatesPane — empty state", () => {
  it("renders a 'No test cases' message when candidates is empty", () => {
    render(<CandidatesPane candidates={[]} />);
    expect(screen.getByText(/no test cases/i)).toBeInTheDocument();
  });

  it("does not render any candidate cards when candidates is empty", () => {
    render(<CandidatesPane candidates={[]} />);
    // No article/li with a candidate title should exist.
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — card rendering
// ---------------------------------------------------------------------------

describe("CandidatesPane — card rendering", () => {
  it("renders one card per candidate", () => {
    const candidates = makeCandidates(3);
    render(<CandidatesPane candidates={candidates} />);
    // Each candidate title is unique and must appear once.
    for (const c of candidates) {
      expect(screen.getByText(c.title)).toBeInTheDocument();
    }
  });

  it("renders the candidate title in each card", () => {
    const c = makeCandidate({ title: "Login with valid credentials succeeds" });
    render(<CandidatesPane candidates={[c]} />);
    expect(screen.getByText("Login with valid credentials succeeds")).toBeInTheDocument();
  });

  it("renders the candidate priority in each card", () => {
    const c = makeCandidate({ priority: "P0" });
    render(<CandidatesPane candidates={[c]} />);
    expect(screen.getByText(/P0/)).toBeInTheDocument();
  });

  it("renders the candidate riskClass in each card", () => {
    const c = makeCandidate({ riskClass: "safety" });
    render(<CandidatesPane candidates={[c]} />);
    expect(screen.getByText(/safety/i)).toBeInTheDocument();
  });

  it("renders a review badge reflecting the candidate review state", () => {
    const c = makeCandidate({ reviewState: "approved" });
    render(<CandidatesPane candidates={[c]} />);
    expect(screen.getByText(/^approved$/i)).toBeInTheDocument();
  });

  it("renders the preconditions list", () => {
    const c = makeCandidate({
      preconditions: ["User has admin role", "Feature flag is enabled"],
    });
    render(<CandidatesPane candidates={[c]} />);
    expect(screen.getByText("User has admin role")).toBeInTheDocument();
    expect(screen.getByText("Feature flag is enabled")).toBeInTheDocument();
  });

  it("renders the steps list", () => {
    const c = makeCandidate({
      steps: ["Open the settings page", "Toggle the preference switch"],
    });
    render(<CandidatesPane candidates={[c]} />);
    expect(screen.getByText("Open the settings page")).toBeInTheDocument();
    expect(screen.getByText("Toggle the preference switch")).toBeInTheDocument();
  });

  it("renders the expectedResults list", () => {
    const c = makeCandidate({
      expectedResults: ["Preference is persisted across sessions"],
    });
    render(<CandidatesPane candidates={[c]} />);
    expect(screen.getByText("Preference is persisted across sessions")).toBeInTheDocument();
  });

  it("renders the tags", () => {
    const c = makeCandidate({ tags: ["e2e", "auth"] });
    render(<CandidatesPane candidates={[c]} />);
    expect(screen.getByText(/e2e/i)).toBeInTheDocument();
    expect(screen.getByText(/auth/i)).toBeInTheDocument();
  });

  it("renders all three riskClass variants without throwing", () => {
    const candidates = [
      makeCandidate({ riskClass: "compliance" }),
      makeCandidate({ riskClass: "regression" }),
      makeCandidate({ riskClass: "visual" }),
    ];
    expect(() => render(<CandidatesPane candidates={candidates} />)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — review buttons (onReview provided)
// ---------------------------------------------------------------------------

describe("CandidatesPane — review buttons when onReview is provided", () => {
  it("renders Approve, Reject, and Request-changes buttons for each candidate", () => {
    const c = makeCandidate();
    const onReview = vi.fn();
    render(<CandidatesPane candidates={[c]} onReview={onReview} />);

    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request.changes/i })).toBeInTheDocument();
  });

  it("calls onReview with (candidateId, 'approve') when Approve is clicked", async () => {
    const user = userEvent.setup();
    const c = makeCandidate();
    const onReview = vi.fn();
    render(<CandidatesPane candidates={[c]} onReview={onReview} />);

    await user.click(screen.getByRole("button", { name: /approve/i }));
    expect(onReview).toHaveBeenCalledOnce();
    expect(onReview).toHaveBeenCalledWith(c.id, "approve");
  });

  it("calls onReview with (candidateId, 'reject') when Reject is clicked", async () => {
    const user = userEvent.setup();
    const c = makeCandidate();
    const onReview = vi.fn();
    render(<CandidatesPane candidates={[c]} onReview={onReview} />);

    await user.click(screen.getByRole("button", { name: /reject/i }));
    expect(onReview).toHaveBeenCalledOnce();
    expect(onReview).toHaveBeenCalledWith(c.id, "reject");
  });

  it("calls onReview with (candidateId, 'request-changes') when Request-changes is clicked", async () => {
    const user = userEvent.setup();
    const c = makeCandidate();
    const onReview = vi.fn();
    render(<CandidatesPane candidates={[c]} onReview={onReview} />);

    await user.click(screen.getByRole("button", { name: /request.changes/i }));
    expect(onReview).toHaveBeenCalledOnce();
    expect(onReview).toHaveBeenCalledWith(c.id, "request-changes");
  });

  it("calls onReview with the correct candidateId when multiple candidates are shown", async () => {
    const user = userEvent.setup();
    const c1 = makeCandidate({ title: "First candidate" });
    const c2 = makeCandidate({ title: "Second candidate" });
    const onReview = vi.fn();
    render(<CandidatesPane candidates={[c1, c2]} onReview={onReview} />);

    // Each card should have its own Approve button; click the second card's.
    const approveButtons = screen.getAllByRole("button", { name: /approve/i });
    expect(approveButtons).toHaveLength(2);
    await user.click(approveButtons[1]!);
    expect(onReview).toHaveBeenCalledWith(c2.id, "approve");
  });
});

// ---------------------------------------------------------------------------
// Tests — review buttons absent (onReview not provided)
// ---------------------------------------------------------------------------

describe("CandidatesPane — no review buttons when onReview is absent", () => {
  it("does not render Approve buttons when onReview is not provided", () => {
    render(<CandidatesPane candidates={[makeCandidate()]} />);
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  });

  it("does not render Reject buttons when onReview is not provided", () => {
    render(<CandidatesPane candidates={[makeCandidate()]} />);
    expect(screen.queryByRole("button", { name: /reject/i })).not.toBeInTheDocument();
  });

  it("does not render Request-changes buttons when onReview is not provided", () => {
    render(<CandidatesPane candidates={[makeCandidate()]} />);
    expect(screen.queryByRole("button", { name: /request.changes/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — aria-pressed on review buttons
// ---------------------------------------------------------------------------

describe("CandidatesPane — aria-pressed on review buttons", () => {
  it("sets aria-pressed=true on the Approve button when reviewState is 'approved'", () => {
    const c = makeCandidate({ reviewState: "approved" });
    const onReview = vi.fn();
    render(<CandidatesPane candidates={[c]} onReview={onReview} />);

    const approveBtn = screen.getByRole("button", { name: /approve/i });
    expect(approveBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("sets aria-pressed=false on the Approve button when reviewState is 'open'", () => {
    const c = makeCandidate({ reviewState: "open" });
    const onReview = vi.fn();
    render(<CandidatesPane candidates={[c]} onReview={onReview} />);

    const approveBtn = screen.getByRole("button", { name: /approve/i });
    expect(approveBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("sets aria-pressed=true on the Reject button when reviewState is 'rejected'", () => {
    const c = makeCandidate({ reviewState: "rejected" });
    const onReview = vi.fn();
    render(<CandidatesPane candidates={[c]} onReview={onReview} />);

    const rejectBtn = screen.getByRole("button", { name: /reject/i });
    expect(rejectBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("sets aria-pressed=true on the Request-changes button when reviewState is 'changes-requested'", () => {
    const c = makeCandidate({ reviewState: "changes-requested" });
    const onReview = vi.fn();
    render(<CandidatesPane candidates={[c]} onReview={onReview} />);

    const reqBtn = screen.getByRole("button", { name: /request.changes/i });
    expect(reqBtn).toHaveAttribute("aria-pressed", "true");
  });
});

// ---------------------------------------------------------------------------
// Tests — terminal-state controls + Reopen (Issue #282 FIX A-UI / A11y-4)
// ---------------------------------------------------------------------------
//
// When a candidate is in a terminal state (approved | rejected | withdrawn), the server will reject
// any Approve / Reject / Request-changes action with 409 QI_REVIEW_TRANSITION_NOT_ALLOWED. The UI
// pre-empts the error by aria-disabling those three buttons and surfacing a Reopen button instead.
// Non-terminal states (open | changes-requested) keep the original behaviour: three actions enabled,
// no Reopen button.

describe("CandidatesPane — terminal-state controls (Issue #282)", () => {
  it.each(["approved", "rejected", "withdrawn"] as const)(
    "aria-disables Approve when reviewState is '%s' (terminal)",
    (state) => {
      const c = makeCandidate({ reviewState: state });
      render(<CandidatesPane candidates={[c]} onReview={vi.fn()} />);
      const approveBtn = screen.getByRole("button", { name: /^approve$/i });
      expect(approveBtn).toHaveAttribute("aria-disabled", "true");
    },
  );

  it.each(["approved", "rejected", "withdrawn"] as const)(
    "aria-disables Reject when reviewState is '%s' (terminal)",
    (state) => {
      const c = makeCandidate({ reviewState: state });
      render(<CandidatesPane candidates={[c]} onReview={vi.fn()} />);
      // Reject and Request-changes may share the same accessible name pattern; target by exact name.
      const rejectBtn = screen.getByRole("button", { name: /^reject$/i });
      expect(rejectBtn).toHaveAttribute("aria-disabled", "true");
    },
  );

  it.each(["approved", "rejected", "withdrawn"] as const)(
    "renders a Reopen button when reviewState is '%s' (terminal)",
    (state) => {
      const c = makeCandidate({ reviewState: state });
      render(<CandidatesPane candidates={[c]} onReview={vi.fn()} />);
      expect(screen.getByRole("button", { name: /^reopen$/i })).toBeInTheDocument();
    },
  );

  it("calls onReview(id, 'reopen') when the Reopen button is clicked", async () => {
    const user = userEvent.setup();
    const c = makeCandidate({ reviewState: "approved" });
    const onReview = vi.fn();
    render(<CandidatesPane candidates={[c]} onReview={onReview} />);
    await user.click(screen.getByRole("button", { name: /^reopen$/i }));
    expect(onReview).toHaveBeenCalledWith(c.id, "reopen");
  });

  it("Approve/Reject/Request-changes have an aria-describedby pointing to the final-note in terminal state", () => {
    const c = makeCandidate({ reviewState: "approved" });
    render(<CandidatesPane candidates={[c]} onReview={vi.fn()} />);
    const approveBtn = screen.getByRole("button", { name: /^approve$/i });
    const describedById = approveBtn.getAttribute("aria-describedby");
    expect(describedById).not.toBeNull();
    // The referenced element must exist in the DOM and contain the final-note text.
    const note = document.getElementById(describedById!);
    expect(note).not.toBeNull();
    expect(note?.textContent).toMatch(/reopen to change it/i);
  });

  it.each(["open", "changes-requested"] as const)(
    "does NOT render a Reopen button when reviewState is '%s' (non-terminal)",
    (state) => {
      const c = makeCandidate({ reviewState: state });
      render(<CandidatesPane candidates={[c]} onReview={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /^reopen$/i })).not.toBeInTheDocument();
    },
  );

  it.each(["open", "changes-requested"] as const)(
    "Approve is NOT aria-disabled when reviewState is '%s' (non-terminal)",
    (state) => {
      const c = makeCandidate({ reviewState: state });
      render(<CandidatesPane candidates={[c]} onReview={vi.fn()} />);
      expect(screen.getByRole("button", { name: /^approve$/i })).not.toHaveAttribute(
        "aria-disabled",
      );
    },
  );

  it("Reopen is aria-disabled while a review is in flight (busy lock)", async () => {
    const user = userEvent.setup();
    const c = makeCandidate({ reviewState: "approved" });
    let resolveReopen: (() => void) | undefined;
    const onReview = vi.fn();
    // Render with a pending review for a *different* action to simulate in-flight state.
    render(
      <CandidatesPane
        candidates={[c]}
        onReview={onReview}
        pendingReview={{ candidateId: c.id, action: "reopen" }}
      />,
    );
    const reopenBtn = screen.getByRole("button", { name: /saving…/i });
    expect(reopenBtn).toHaveAttribute("aria-disabled", "true");
    void resolveReopen;
    await user.click(reopenBtn); // must no-op (aria-disabled guard)
    expect(onReview).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — progressive rendering (>25 candidates)
// ---------------------------------------------------------------------------

describe("CandidatesPane — progressive rendering", () => {
  it("renders exactly 25 cards when given 30 candidates (not all at once)", () => {
    const candidates = makeCandidates(30);
    render(<CandidatesPane candidates={candidates} />);

    // Count how many of the 30 unique titles appear in the document.
    const visibleCount = candidates.filter((c) => screen.queryByText(c.title)).length;
    expect(visibleCount).toBe(25);
  });

  it("renders a 'Show more' button when there are more than 25 candidates", () => {
    render(<CandidatesPane candidates={makeCandidates(26)} />);
    expect(screen.getByRole("button", { name: /show more/i })).toBeInTheDocument();
  });

  it("does not render a 'Show more' button when there are 25 or fewer candidates", () => {
    render(<CandidatesPane candidates={makeCandidates(25)} />);
    expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
  });

  it("reveals additional cards after clicking 'Show more'", async () => {
    const user = userEvent.setup();
    const candidates = makeCandidates(30);
    render(<CandidatesPane candidates={candidates} />);

    await user.click(screen.getByRole("button", { name: /show more/i }));

    // After clicking, all 30 titles should be visible.
    for (const c of candidates) {
      expect(screen.getByText(c.title)).toBeInTheDocument();
    }
  });

  it("hides 'Show more' after all candidates have been revealed", async () => {
    const user = userEvent.setup();
    render(<CandidatesPane candidates={makeCandidates(26)} />);

    await user.click(screen.getByRole("button", { name: /show more/i }));

    expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
  });

  it("renders all cards when candidates length is exactly 25", () => {
    const candidates = makeCandidates(25);
    render(<CandidatesPane candidates={candidates} />);
    for (const c of candidates) {
      expect(screen.getByText(c.title)).toBeInTheDocument();
    }
  });

  it("renders all cards when candidates length is exactly 26 after Show more click", async () => {
    const user = userEvent.setup();
    const candidates = makeCandidates(26);
    render(<CandidatesPane candidates={candidates} />);

    await user.click(screen.getByRole("button", { name: /show more/i }));

    for (const c of candidates) {
      expect(screen.getByText(c.title)).toBeInTheDocument();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — weak-test flag (Epic #736 / Issue #748)
// ---------------------------------------------------------------------------

describe("CandidatesPane — weak-test flag", () => {
  it("renders the weak-test flag with its rationale when the judge flagged the candidate", () => {
    const c = makeCandidate({
      weakTestFlag: {
        severity: "high",
        rationale: "Test quality score 22/100 — candidate judged weak.",
      },
    });
    render(<CandidatesPane candidates={[c]} />);
    expect(screen.getByTestId("qi-weak-flag")).toBeInTheDocument();
    expect(screen.getByText(/Test quality score 22\/100/)).toBeInTheDocument();
  });

  it("names the weak-test flag for assistive tech via an accessible note", () => {
    const c = makeCandidate({
      weakTestFlag: { severity: "medium", rationale: "Vague expected results." },
    });
    render(<CandidatesPane candidates={[c]} />);
    expect(
      screen.getByRole("note", {
        name: /Weak test flagged by the quality judge: Vague expected results\./i,
      }),
    ).toBeInTheDocument();
  });

  it("does not render a weak-test flag when the candidate has none", () => {
    render(<CandidatesPane candidates={[makeCandidate()]} />);
    expect(screen.queryByTestId("qi-weak-flag")).not.toBeInTheDocument();
  });

  it("renders a weak-test flag only on the flagged candidate among several", () => {
    const flagged = makeCandidate({
      title: "Weak one",
      weakTestFlag: { severity: "high", rationale: "Non-deterministic steps." },
    });
    const strong = makeCandidate({ title: "Strong one" });
    render(<CandidatesPane candidates={[flagged, strong]} />);
    expect(screen.getAllByTestId("qi-weak-flag")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — boundary and edge cases
// ---------------------------------------------------------------------------

describe("CandidatesPane — edge cases", () => {
  it("renders a single candidate without throwing", () => {
    expect(() => render(<CandidatesPane candidates={[makeCandidate()]} />)).not.toThrow();
  });

  it("renders candidates with empty preconditions, steps, and expectedResults lists", () => {
    const c = makeCandidate({ preconditions: [], steps: [], expectedResults: [] });
    expect(() => render(<CandidatesPane candidates={[c]} />)).not.toThrow();
  });

  it("renders candidates with empty tags without throwing", () => {
    const c = makeCandidate({ tags: [] });
    expect(() => render(<CandidatesPane candidates={[c]} />)).not.toThrow();
  });

  it("keeps each candidate's review buttons scoped to its own card", async () => {
    // Ensure clicking Approve on card 1 does NOT call onReview for card 2's id.
    const user = userEvent.setup();
    const c1 = makeCandidate({ title: "Card one" });
    const c2 = makeCandidate({ title: "Card two" });
    const onReview = vi.fn();
    render(<CandidatesPane candidates={[c1, c2]} onReview={onReview} />);

    const approveButtons = screen.getAllByRole("button", { name: /approve/i });
    await user.click(approveButtons[0]!);
    expect(onReview).toHaveBeenCalledWith(c1.id, "approve");
    expect(onReview).not.toHaveBeenCalledWith(c2.id, expect.anything());
  });

  it("renders the 'Open' review badge on a newly generated candidate", () => {
    const c = makeCandidate({ reviewState: "open" });
    render(<CandidatesPane candidates={[c]} />);
    expect(screen.getByText(/^open$/i)).toBeInTheDocument();
  });

  it("renders review buttons for all visible candidates when onReview is provided and count > 25", () => {
    const candidates = makeCandidates(30);
    const onReview = vi.fn();
    render(<CandidatesPane candidates={candidates} onReview={onReview} />);

    // 25 visible cards → 25 Approve buttons.
    const approveButtons = screen.getAllByRole("button", { name: /approve/i });
    expect(approveButtons).toHaveLength(25);
  });
});

// ---------------------------------------------------------------------------
// Tests — inline editing (Epic #712, Issue #727)
// ---------------------------------------------------------------------------

describe("CandidatesPane — inline editing", () => {
  it("renders no Edit button when onEdit is absent", () => {
    render(<CandidatesPane candidates={[makeCandidate()]} />);
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it("renders an Edit button per card when onEdit is provided", () => {
    render(<CandidatesPane candidates={[makeCandidate()]} onEdit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeInTheDocument();
  });

  it("clicking Edit reveals the inline edit form pre-filled with the candidate title", async () => {
    const user = userEvent.setup();
    const c = makeCandidate({ title: "Original title" });
    render(<CandidatesPane candidates={[c]} onEdit={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(screen.getByRole("form", { name: /edit original title/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Original title");
  });

  it("expands the active edit card across the candidate grid", async () => {
    const user = userEvent.setup();
    const c = makeCandidate({ title: "Original title" });
    render(
      <CandidatesPane candidates={[c, makeCandidate({ title: "Other title" })]} onEdit={vi.fn()} />,
    );
    const firstEditButton = screen.getAllByRole("button", { name: /^edit$/i })[0];
    if (firstEditButton === undefined) throw new Error("Expected at least one Edit button.");
    await user.click(firstEditButton);

    const editingCard = screen.getByRole("form", { name: /edit original title/i }).closest("li");
    if (editingCard === null) throw new Error("Expected the edit form to be inside a list item.");
    expect(editingCard).toHaveClass("qi-cand-card-editing");
  });

  it("editing the title and saving calls onEdit with only the changed field", async () => {
    const user = userEvent.setup();
    const c = makeCandidate({ title: "Old title" });
    const onEdit = vi.fn().mockResolvedValue(undefined);
    render(<CandidatesPane candidates={[c]} onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const titleInput = screen.getByLabelText("Title");
    await user.clear(titleInput);
    await user.type(titleInput, "New title");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onEdit).toHaveBeenCalledWith(c.id, { title: "New title" });
  });

  it("Cancel hides the form without calling onEdit", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<CandidatesPane candidates={[makeCandidate()]} onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("Escape cancels the edit form without calling onEdit", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<CandidatesPane candidates={[makeCandidate()]} onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    await user.type(screen.getByLabelText("Title"), "{Escape}");
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("returns focus to the Edit button when the form is cancelled (no keyboard dead-end)", async () => {
    const user = userEvent.setup();
    render(<CandidatesPane candidates={[makeCandidate()]} onEdit={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    // The title field receives focus when the form opens.
    expect(screen.getByRole("textbox", { name: /^title$/i })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    // On close, focus returns to the Edit trigger rather than dropping to <body>.
    expect(screen.getByRole("button", { name: /^edit$/i })).toHaveFocus();
  });

  it("returns focus to the Edit button after a successful save (no keyboard dead-end)", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn().mockResolvedValue(undefined);
    render(<CandidatesPane candidates={[makeCandidate({ title: "Old title" })]} onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const titleInput = screen.getByRole("textbox", { name: /^title$/i });
    expect(titleInput).toHaveFocus();
    await user.clear(titleInput);
    await user.type(titleInput, "New title");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    // After the save resolves the form unmounts; focus must return to the Edit trigger rather than
    // dropping to <body>. This exercises the Save-close path — distinct from the Cancel-close path
    // above, which restores focus synchronously rather than after an awaited save.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^edit$/i })).toHaveFocus();
    });
  });

  it("renders the governance note and disables actions when governance is blocked", () => {
    render(
      <CandidatesPane
        candidates={[makeCandidate()]}
        onEdit={vi.fn()}
        onReview={vi.fn()}
        actionsDisabled
        actionsDisabledReason="Set a reviewer label to review or edit candidates."
      />,
    );
    const note = screen.getByText(/set a reviewer label to review or edit candidates/i);
    expect(note).toBeInTheDocument();
    // Governance-gated controls use aria-disabled (NOT native disabled) so they stay focusable and
    // a screen reader announces the reason via aria-describedby pointing at the governance note.
    const editButton = screen.getByRole("button", { name: /^edit$/i });
    const approveButton = screen.getByRole("button", { name: /approve/i });
    expect(editButton).toHaveAttribute("aria-disabled", "true");
    expect(approveButton).toHaveAttribute("aria-disabled", "true");
    expect(note.id).toBeTruthy();
    expect(editButton).toHaveAttribute("aria-describedby", note.id);
    expect(approveButton).toHaveAttribute("aria-describedby", note.id);
  });

  it("does not start editing when the Edit button is governance-disabled (aria-disabled guard)", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(
      <CandidatesPane
        candidates={[makeCandidate()]}
        onEdit={onEdit}
        actionsDisabled
        actionsDisabledReason="Set a reviewer label to review or edit candidates."
      />,
    );
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(screen.queryByRole("textbox", { name: /^title$/i })).not.toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("renders save errors inline and keeps the form open", async () => {
    const user = userEvent.setup();
    const onEdit = vi
      .fn()
      .mockRejectedValueOnce(new Error("QI_BAD_EDIT: A valid candidate edit is required."));
    render(<CandidatesPane candidates={[makeCandidate({ title: "Editable" })]} onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const titleInput = screen.getByLabelText("Title");
    await user.clear(titleInput);
    await user.type(titleInput, "Still invalid");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(
      await screen.findByText("QI_BAD_EDIT: A valid candidate edit is required."),
    ).toBeInTheDocument();
    expect(screen.getByRole("form", { name: /edit editable/i })).toBeInTheDocument();
  });

  it("surfaces the validation error when a required field is cleared (submits an empty list)", async () => {
    const user = userEvent.setup();
    const candidate = makeCandidate({
      title: "Has steps",
      steps: ["Navigate to the page", "Click submit"],
    });
    const onEdit = vi
      .fn()
      .mockRejectedValueOnce(new Error('QI_BAD_EDIT: The "steps" field is empty or invalid.'));
    render(<CandidatesPane candidates={[candidate]} onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    await user.clear(screen.getByRole("textbox", { name: /steps/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    // Clearing a required list field submits an empty list; the server's minItems:1 gate rejects it
    // and the UI surfaces the coded error while keeping the form open with the reviewer's edits.
    expect(onEdit).toHaveBeenCalledWith(candidate.id, { steps: [] });
    expect(
      await screen.findByText('QI_BAD_EDIT: The "steps" field is empty or invalid.'),
    ).toBeInTheDocument();
    expect(screen.getByRole("form")).toBeInTheDocument();
  });

  it("clears the save error when the reviewer edits the form again", async () => {
    const user = userEvent.setup();
    const onEdit = vi
      .fn()
      .mockRejectedValueOnce(new Error("QI_BAD_EDIT: A valid candidate edit is required."));
    render(<CandidatesPane candidates={[makeCandidate({ title: "Editable" })]} onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const titleInput = screen.getByLabelText("Title");
    await user.clear(titleInput);
    await user.type(titleInput, "Still invalid");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await screen.findByText("QI_BAD_EDIT: A valid candidate edit is required.");

    await user.type(titleInput, " updated");
    expect(
      screen.queryByText("QI_BAD_EDIT: A valid candidate edit is required."),
    ).not.toBeInTheDocument();
  });

  it("disables Save/Cancel and blocks duplicate submits while a save is pending", async () => {
    const user = userEvent.setup();
    let resolveSave: (() => void) | undefined;
    const onEdit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<CandidatesPane candidates={[makeCandidate({ title: "Editable" })]} onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const titleInput = screen.getByLabelText("Title");
    await user.clear(titleInput);
    await user.type(titleInput, "Updated title");

    const saveButton = screen.getByRole("button", { name: /^save$/i });
    const cancelButton = screen.getByRole("button", { name: /^cancel$/i });
    await user.click(saveButton);

    expect(onEdit).toHaveBeenCalledTimes(1);
    // Save/Cancel use aria-disabled (not native disabled) while the save is in flight so the
    // just-activated control keeps focus; duplicate submits are blocked in the handler.
    expect(saveButton).toHaveAttribute("aria-disabled", "true");
    expect(cancelButton).toHaveAttribute("aria-disabled", "true");

    await user.click(saveButton);
    expect(onEdit).toHaveBeenCalledTimes(1);

    resolveSave?.();
    await waitFor(() => {
      expect(screen.queryByRole("form", { name: /edit editable/i })).not.toBeInTheDocument();
    });
  });
});
