// Epic #270 / #734 — QiRunCard tests. The card fetches a run's detail by id, renders the summary +
// the generated test cases, routes per-candidate review decisions, and shows coverage intelligence
// (coverage % badge and gap radar for uncovered/weakly-covered atoms).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QiRunCard } from "./QiRunCard";
import type {
  QualityIntelligenceUiRunDetail,
  QualityIntelligenceUiCandidate,
  QualityIntelligenceUiAtomCoverage,
} from "@oscharko-dev/keiko-contracts";

function makeCandidate(id: string, title: string): QualityIntelligenceUiCandidate {
  return {
    id,
    title,
    preconditions: ["User is logged in"],
    steps: ["Do the thing"],
    expectedResults: ["It worked"],
    priority: "P2",
    riskClass: "regression",
    tags: ["smoke"],
    status: "proposed",
    reviewState: "open",
    derivedFromAtomIds: [],
  };
}

function makeDetail(
  runId: string,
  candidates: readonly QualityIntelligenceUiCandidate[],
  coverageByAtom: readonly QualityIntelligenceUiAtomCoverage[] = [],
  coveragePercentage = 0,
  qualityScore: number | null = null,
): QualityIntelligenceUiRunDetail {
  return {
    id: runId,
    status: "succeeded",
    requestedAt: "2026-06-01T10:00:00.000Z",
    completedAt: "2026-06-01T10:01:00.000Z",
    totals: { candidates: candidates.length, findings: 0, exports: 0 },
    findingRefs: [],
    candidateIds: candidates.map((c) => c.id),
    candidates,
    evidenceRefs: [],
    reviewState: "open",
    manifestSchemaVersion: 1,
    coveragePercentage,
    coverageByAtom,
    qualityScore,
    drift: {
      status: "unavailable",
      sourceFingerprintCount: 0,
      atomFingerprintCount: 0,
      reCheckSupported: false,
      regenerateStaleSupported: false,
    },
  };
}

const fetchOk = (
  detail: QualityIntelligenceUiRunDetail,
): typeof import("@/lib/quality-intelligence-api").fetchQiRunDetail =>
  vi
    .fn()
    .mockResolvedValue(
      detail,
    ) as unknown as typeof import("@/lib/quality-intelligence-api").fetchQiRunDetail;

beforeEach(() => {
  window.localStorage.clear();
});

describe("QiRunCard", () => {
  it("fetches and renders the run summary + test cases for the given runId", async () => {
    const detail = makeDetail("qi-run-aaaa1111", [
      makeCandidate("tc-1", "Successful login"),
      makeCandidate("tc-2", "Rejected login"),
    ]);
    render(<QiRunCard runId="qi-run-aaaa1111" fetchDetailImpl={fetchOk(detail)} />);
    expect(await screen.findByText("Successful login")).toBeInTheDocument();
    expect(screen.getByText("Rejected login")).toBeInTheDocument();
  });

  it("requests detail for the runId passed in", async () => {
    const impl = fetchOk(makeDetail("qi-run-zzzz9999", []));
    render(<QiRunCard runId="qi-run-zzzz9999" fetchDetailImpl={impl} />);
    await waitFor(() => {
      expect(impl).toHaveBeenCalledWith("qi-run-zzzz9999");
    });
  });

  it("routes an Approve decision through the review seam and reloads", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("keiko.qi.reviewerLabel", "Alice");
    const detail = makeDetail("qi-run-aaaa1111", [makeCandidate("tc-1", "Successful login")]);
    const fetchImpl = fetchOk(detail);
    const reviewImpl = vi.fn().mockResolvedValue({
      runState: "open",
      candidateStates: { "tc-1": "approved" },
      auditCount: 1,
    }) as unknown as typeof import("@/lib/quality-intelligence-api").reviewQiRun;

    render(
      <QiRunCard runId="qi-run-aaaa1111" fetchDetailImpl={fetchImpl} reviewImpl={reviewImpl} />,
    );
    const approveButton = await screen.findByRole("button", { name: /approve/i });
    await waitFor(() => {
      expect(approveButton).toBeEnabled();
    });
    await user.click(approveButton);
    await waitFor(() => {
      expect(reviewImpl).toHaveBeenCalledWith("qi-run-aaaa1111", "approve", "tc-1", "Alice");
    });
    // Detail is reloaded after the decision (initial load + post-review reload).
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("locks the review controls and labels the clicked button Saving… while a review is in flight (F029 C275)", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("keiko.qi.reviewerLabel", "Alice");
    const detail = makeDetail("qi-run-pending", [makeCandidate("tc-1", "Successful login")]);
    let resolveReview: (() => void) | undefined;
    const reviewImpl = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveReview = resolve;
        }),
    ) as unknown as typeof import("@/lib/quality-intelligence-api").reviewQiRun;

    render(
      <QiRunCard
        runId="qi-run-pending"
        fetchDetailImpl={fetchOk(detail)}
        reviewImpl={reviewImpl}
      />,
    );
    const approveButton = await screen.findByRole("button", { name: /approve/i });
    await user.click(approveButton);

    // The clicked button shows in-flight feedback; the whole group is aria-disabled (focusable).
    expect(approveButton).toHaveTextContent("Saving…");
    expect(approveButton).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /^reject$/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    // An impatient second click must not fire a duplicate review request (duplicate audit entry).
    await user.click(approveButton);
    expect(reviewImpl).toHaveBeenCalledTimes(1);

    resolveReview?.();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^approve$/i })).not.toHaveAttribute(
        "aria-disabled",
      );
    });
  });

  it("keeps the run content rendered and shows a dismissible alert when a review action fails (F030 C113)", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("keiko.qi.reviewerLabel", "Alice");
    const detail = makeDetail("qi-run-rev-fail", [makeCandidate("tc-1", "Successful login")]);
    const reviewImpl = vi
      .fn()
      .mockRejectedValue(
        new Error("FORBIDDEN: review not allowed."),
      ) as unknown as typeof import("@/lib/quality-intelligence-api").reviewQiRun;

    render(
      <QiRunCard
        runId="qi-run-rev-fail"
        fetchDetailImpl={fetchOk(detail)}
        reviewImpl={reviewImpl}
      />,
    );
    const approveButton = await screen.findByRole("button", { name: /approve/i });
    await waitFor(() => {
      expect(approveButton).toBeEnabled();
    });
    await user.click(approveButton);

    const alert = await screen.findByTestId("qi-action-error");
    expect(alert).toHaveTextContent("FORBIDDEN: review not allowed.");
    // The card content must NOT be replaced by a full ErrorState — the work context stays.
    expect(screen.getByText("Successful login")).toBeInTheDocument();
    expect(screen.queryByTestId("qi-error-state")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByTestId("qi-action-error")).not.toBeInTheDocument();
  });

  // Issue #282 A11y-1 (WCAG 4.1.3): a dedicated live region must announce the review outcome so
  // screen-reader users receive feedback after a review action. The announcement must contain
  // the candidate title and the resulting state label so it is informative and AT re-announces it
  // (as opposed to the existing "Run loaded: N test cases" region which is byte-identical across
  // all review actions and therefore suppressed by AT de-duplication).
  it("updates the review-announce live region after a successful Approve (A11y-1 / Issue #282)", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("keiko.qi.reviewerLabel", "Alice");
    const detail = makeDetail("qi-run-rev-announce", [
      makeCandidate("tc-announce-1", "Verify checkout flow"),
    ]);
    const reviewImpl = vi.fn().mockResolvedValue({
      runState: "open",
      candidateStates: { "tc-announce-1": "approved" },
      auditCount: 1,
    }) as unknown as typeof import("@/lib/quality-intelligence-api").reviewQiRun;

    render(
      <QiRunCard
        runId="qi-run-rev-announce"
        fetchDetailImpl={fetchOk(detail)}
        reviewImpl={reviewImpl}
      />,
    );
    const approveButton = await screen.findByRole("button", { name: /approve/i });
    await waitFor(() => {
      expect(approveButton).toBeEnabled();
    });
    await user.click(approveButton);

    // After the review settles, the dedicated live region must carry the outcome text.
    await waitFor(() => {
      const region = screen.getByTestId("qi-review-announce");
      expect(region).toHaveTextContent(/marked Approved/i);
      expect(region).toHaveTextContent(/Verify checkout flow/i);
    });
  });

  it("surfaces a retryable error when the detail fetch fails", async () => {
    const failing = vi
      .fn()
      .mockRejectedValue(
        new Error("nope"),
      ) as unknown as typeof import("@/lib/quality-intelligence-api").fetchQiRunDetail;
    render(<QiRunCard runId="qi-run-aaaa1111" fetchDetailImpl={failing} />);
    expect(await screen.findByTestId("qi-error-state")).toBeInTheDocument();
  });

  it("routes an inline edit through the edit seam and reloads the detail (Epic #712)", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("keiko.qi.reviewerLabel", "Alice");
    const detail = makeDetail("qi-run-aaaa1111", [makeCandidate("tc-1", "Login")]);
    const fetchImpl = fetchOk(detail);
    const editImpl = vi
      .fn()
      .mockResolvedValue(
        makeCandidate("tc-1", "Edited login"),
      ) as unknown as typeof import("@/lib/quality-intelligence-api").editQiCandidate;

    render(<QiRunCard runId="qi-run-aaaa1111" fetchDetailImpl={fetchImpl} editImpl={editImpl} />);
    const editButton = await screen.findByRole("button", { name: /^edit$/i });
    await waitFor(() => {
      expect(editButton).toBeEnabled();
    });
    await user.click(editButton);
    const titleInput = screen.getByLabelText("Title");
    await user.clear(titleInput);
    await user.type(titleInput, "Edited login");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(editImpl).toHaveBeenCalledWith(
        "qi-run-aaaa1111",
        "tc-1",
        { title: "Edited login" },
        "Alice",
      );
    });
    // Detail is reloaded after the edit (initial load + post-edit reload).
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("blocks review and edit actions until a reviewer label is set", async () => {
    const detail = makeDetail("qi-run-blocked", [makeCandidate("tc-1", "Login")]);
    render(<QiRunCard runId="qi-run-blocked" fetchDetailImpl={fetchOk(detail)} />);

    await screen.findByText("Login");
    // Governance-gated controls are aria-disabled (focusable + reason announced), not natively
    // disabled. The reviewer-label input is flagged aria-invalid until a label is supplied.
    expect(screen.getByRole("button", { name: /^edit$/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: /approve/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByLabelText(/reviewer label/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText(/set a reviewer label to review or edit candidates/i)).toHaveLength(
      2,
    );
  });

  it("clears aria-invalid on the reviewer-label input once a label is entered", async () => {
    const user = userEvent.setup();
    const detail = makeDetail("qi-run-aria", [makeCandidate("tc-1", "Login")]);
    render(<QiRunCard runId="qi-run-aria" fetchDetailImpl={fetchOk(detail)} />);
    await screen.findByText("Login");
    const labelInput = screen.getByLabelText(/reviewer label/i);
    expect(labelInput).toHaveAttribute("aria-invalid", "true");
    await user.type(labelInput, "Alice");
    expect(labelInput).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByRole("button", { name: /^edit$/i })).not.toHaveAttribute("aria-disabled");
  });

  it("keeps the edit form open and surfaces the save error when the edit request fails", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("keiko.qi.reviewerLabel", "Alice");
    const detail = makeDetail("qi-run-edit-fail", [makeCandidate("tc-1", "Login")]);
    const fetchImpl = fetchOk(detail);
    const editImpl = vi
      .fn()
      .mockRejectedValue(
        new Error("QI_BAD_EDIT: A valid candidate edit is required."),
      ) as unknown as typeof import("@/lib/quality-intelligence-api").editQiCandidate;

    render(<QiRunCard runId="qi-run-edit-fail" fetchDetailImpl={fetchImpl} editImpl={editImpl} />);
    const editButton = await screen.findByRole("button", { name: /^edit$/i });
    await waitFor(() => {
      expect(editButton).toBeEnabled();
    });
    await user.click(editButton);
    const titleInput = screen.getByLabelText("Title");
    await user.clear(titleInput);
    await user.type(titleInput, "Edited login");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(
      await screen.findByText("QI_BAD_EDIT: A valid candidate edit is required."),
    ).toBeInTheDocument();
    expect(screen.getByRole("form", { name: /edit login/i })).toBeInTheDocument();
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("renders the coverage percentage badge when coverageByAtom is non-empty", async () => {
    const atoms: QualityIntelligenceUiAtomCoverage[] = [
      { atomId: "atom-1", status: "covered", confidence: 0.9 },
      { atomId: "atom-2", status: "covered", confidence: 0.8 },
    ];
    const detail = makeDetail("qi-run-cov1", [], atoms, 100);
    render(<QiRunCard runId="qi-run-cov1" fetchDetailImpl={fetchOk(detail)} />);
    expect(await screen.findByTestId("qi-coverage-pct")).toHaveTextContent("100%");
  });

  it("renders uncovered atom in the gap radar with an accessible label", async () => {
    const atoms: QualityIntelligenceUiAtomCoverage[] = [
      { atomId: "atom-a", status: "covered", confidence: 0.9 },
      { atomId: "atom-b", status: "uncovered", confidence: 0.1 },
    ];
    const detail = makeDetail("qi-run-cov2", [], atoms, 50);
    render(<QiRunCard runId="qi-run-cov2" fetchDetailImpl={fetchOk(detail)} />);
    expect(await screen.findByLabelText(/Atom atom-b: Uncovered/i)).toBeInTheDocument();
  });

  it("renders the requirement excerpt in the gap radar and names it in the label (#790)", async () => {
    const atoms: QualityIntelligenceUiAtomCoverage[] = [
      {
        atomId: "atom-b",
        status: "uncovered",
        confidence: 0,
        requirementExcerptRedacted: "Lock the account after five failed logins.",
      },
      // Legacy run recorded before #790: no excerpt — keeps the id-only presentation.
      { atomId: "atom-c", status: "weakly-covered", confidence: 0.5 },
    ];
    const detail = makeDetail("qi-run-cov4", [], atoms, 0);
    render(<QiRunCard runId="qi-run-cov4" fetchDetailImpl={fetchOk(detail)} />);
    const item = await screen.findByLabelText(
      /Requirement "Lock the account after five failed logins\." \(atom atom-b\): Uncovered/i,
    );
    expect(item).toBeInTheDocument();
    expect(screen.getByTestId("qi-coverage-gap-text")).toHaveTextContent(
      "Lock the account after five failed logins.",
    );
    expect(screen.getByLabelText(/Atom atom-c: Weakly covered/i)).toBeInTheDocument();
  });

  it("shows a covered/total summary and gap count alongside the percentage", async () => {
    const atoms: QualityIntelligenceUiAtomCoverage[] = [
      { atomId: "atom-a", status: "covered", confidence: 0.9 },
      { atomId: "atom-b", status: "weakly-covered", confidence: 0.5 },
      { atomId: "atom-c", status: "uncovered", confidence: 0 },
    ];
    const detail = makeDetail("qi-run-cov3", [], atoms, 33);
    render(<QiRunCard runId="qi-run-cov3" fetchDetailImpl={fetchOk(detail)} />);
    const summary = await screen.findByTestId("qi-coverage-summary");
    expect(summary).toHaveTextContent("1 of 3 requirements covered");
    expect(summary).toHaveTextContent("2 gaps");
    // The weakly-covered badge carries the qi-cov-weak class (decorative colour) plus a text label.
    const weak = screen.getByLabelText(/Atom atom-b: Weakly covered/i);
    expect(weak.querySelector(".qi-cov-weak")).not.toBeNull();
  });

  it("renders the quality score badge with the rounded score and tier class", async () => {
    const detail = makeDetail("qi-run-q1", [makeCandidate("tc-1", "A test")], [], 0, 84.6);
    render(<QiRunCard runId="qi-run-q1" fetchDetailImpl={fetchOk(detail)} />);
    const badge = await screen.findByTestId("qi-quality-badge");
    // The score context is sr-only text (aria-label is prohibited on a generic <span>).
    expect(badge).toHaveTextContent("85 out of 100");
    expect(badge).not.toHaveAttribute("aria-label");
    // 70-89 → mid tier (amber).
    expect(badge.className).toContain("qi-quality-mid");
  });

  it("renders an em-dash quality badge when qualityScore is null", async () => {
    const detail = makeDetail("qi-run-q2", [], [], 0, null);
    render(<QiRunCard runId="qi-run-q2" fetchDetailImpl={fetchOk(detail)} />);
    const badge = await screen.findByTestId("qi-quality-badge");
    expect(badge).toHaveTextContent("—");
    // The em-dash alone is meaningless to assistive tech — sr-only text carries the meaning.
    expect(badge).toHaveTextContent("Quality score not available");
  });

  it("applies the high tier class for a score of 90 or above", async () => {
    const detail = makeDetail("qi-run-q3", [], [], 0, 100);
    render(<QiRunCard runId="qi-run-q3" fetchDetailImpl={fetchOk(detail)} />);
    const badge = await screen.findByTestId("qi-quality-badge");
    expect(badge.className).toContain("qi-quality-high");
  });

  it("applies the low tier class for a score below 70", async () => {
    const detail = makeDetail("qi-run-q4", [], [], 0, 42);
    render(<QiRunCard runId="qi-run-q4" fetchDetailImpl={fetchOk(detail)} />);
    const badge = await screen.findByTestId("qi-quality-badge");
    expect(badge.className).toContain("qi-quality-low");
  });

  it("renders the drift panel when connected sources are provided", async () => {
    const detail = makeDetail("qi-run-d1", [makeCandidate("tc-1", "A test")]);
    render(
      <QiRunCard
        runId="qi-run-d1"
        fetchDetailImpl={fetchOk(detail)}
        connectedSources={[{ kind: "file", label: "Fachkonzept.md", path: "/abs/Fachkonzept.md" }]}
      />,
    );
    expect(await screen.findByTestId("qi-drift-recheck")).toBeInTheDocument();
  });

  it("hides the drift panel when no connected source is provided", async () => {
    const detail = makeDetail("qi-run-d2", [makeCandidate("tc-1", "A test")]);
    render(<QiRunCard runId="qi-run-d2" fetchDetailImpl={fetchOk(detail)} />);
    await screen.findByText("A test");
    expect(screen.queryByTestId("qi-drift-recheck")).not.toBeInTheDocument();
  });

  it("shows disabled drift guidance when fingerprints exist but no source handle is available", async () => {
    const detail: QualityIntelligenceUiRunDetail = {
      ...makeDetail("qi-run-d4", [makeCandidate("tc-1", "A test")]),
      drift: {
        status: "not-checked",
        sourceFingerprintCount: 1,
        atomFingerprintCount: 1,
        reCheckSupported: true,
        regenerateStaleSupported: true,
      },
    };
    render(<QiRunCard runId="qi-run-d4" fetchDetailImpl={fetchOk(detail)} />);
    expect(await screen.findByTestId("qi-drift-unavailable")).toHaveTextContent(
      /no current source handle/i,
    );
    // a11y m-03: aria-disabled (focusable + describes why) rather than native disabled.
    const unavailableBtn = screen.getByTestId("qi-drift-recheck-unavailable");
    expect(unavailableBtn).not.toBeDisabled();
    expect(unavailableBtn).toHaveAttribute("aria-disabled", "true");
    expect(unavailableBtn).toHaveAccessibleDescription(/no current source handle/i);
  });

  it("hides the drift panel when connected sources is an empty array", async () => {
    const detail = makeDetail("qi-run-d3", [makeCandidate("tc-1", "A test")]);
    render(<QiRunCard runId="qi-run-d3" fetchDetailImpl={fetchOk(detail)} connectedSources={[]} />);
    await screen.findByText("A test");
    expect(screen.queryByTestId("qi-drift-recheck")).not.toBeInTheDocument();
  });
});

describe("QiRunCard — progressive rendering of large lists (#280)", () => {
  it("paginates the findings list and reveals the rest on Show more", async () => {
    const findingRefs = Array.from({ length: 25 }, (_, i) => ({
      id: `find-${i.toString()}`,
      kind: "logic-defect" as const,
      severity: "medium" as const,
      summaryRedacted: `Finding number ${i.toString()}`,
    }));
    const detail: QualityIntelligenceUiRunDetail = {
      ...makeDetail("qi-run-findings", [makeCandidate("tc-1", "A test")]),
      findingRefs,
    };
    render(<QiRunCard runId="qi-run-findings" fetchDetailImpl={fetchOk(detail)} />);

    expect(await screen.findByText("Finding number 0")).toBeInTheDocument();
    // First page only: 20 visible, items 20–24 hidden behind Show more.
    expect(screen.getByText("Finding number 19")).toBeInTheDocument();
    expect(screen.queryByText("Finding number 20")).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /show more findings \(5 remaining\)/i }));

    expect(screen.getByText("Finding number 24")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show more findings/i })).not.toBeInTheDocument();
  });

  it("paginates the coverage gap radar and reveals the rest on Show more", async () => {
    const atoms = Array.from({ length: 25 }, (_, i) => ({
      atomId: `atom-${i.toString()}`,
      status: "uncovered" as const,
      confidence: 0,
      requirementExcerptRedacted: `Requirement ${i.toString()}`,
    }));
    const detail = makeDetail("qi-run-gaps", [], atoms, 0);
    render(<QiRunCard runId="qi-run-gaps" fetchDetailImpl={fetchOk(detail)} />);

    expect(await screen.findByText("Requirement 0")).toBeInTheDocument();
    expect(screen.getByText("Requirement 19")).toBeInTheDocument();
    expect(screen.queryByText("Requirement 20")).not.toBeInTheDocument();
    // The radar header still reports the FULL gap count, not the visible slice.
    expect(screen.getByText(/Gap radar \(25\)/i)).toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /show more gaps \(5 remaining\)/i }));

    expect(screen.getByText("Requirement 24")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show more gaps/i })).not.toBeInTheDocument();
  });
});
