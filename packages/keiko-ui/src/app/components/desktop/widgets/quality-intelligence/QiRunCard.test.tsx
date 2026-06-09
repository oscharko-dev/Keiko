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
    expect(badge).toHaveTextContent("85");
    expect(badge).toHaveAttribute("aria-label", "Quality score: 85 out of 100");
    // 70-89 → mid tier (amber).
    expect(badge.className).toContain("qi-quality-mid");
  });

  it("renders an em-dash quality badge when qualityScore is null", async () => {
    const detail = makeDetail("qi-run-q2", [], [], 0, null);
    render(<QiRunCard runId="qi-run-q2" fetchDetailImpl={fetchOk(detail)} />);
    const badge = await screen.findByTestId("qi-quality-badge");
    expect(badge).toHaveTextContent("—");
    expect(badge).toHaveAttribute("aria-label", "Quality score: not available");
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

  it("renders the drift panel when a connected source is provided", async () => {
    const detail = makeDetail("qi-run-d1", [makeCandidate("tc-1", "A test")]);
    render(
      <QiRunCard
        runId="qi-run-d1"
        fetchDetailImpl={fetchOk(detail)}
        connectedSource={{ kind: "file", label: "Fachkonzept.md", path: "/abs/Fachkonzept.md" }}
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
});
