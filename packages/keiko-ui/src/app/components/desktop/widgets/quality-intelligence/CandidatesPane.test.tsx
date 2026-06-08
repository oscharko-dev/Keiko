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

import { render, screen } from "@testing-library/react";
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
