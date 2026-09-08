/**
 * #3390 — the DOM contract the qualification lane reads the Code task through.
 *
 * The lane (`tests/e2e/support/coding-issue-journey-live-observed.ts`) locates each status card by
 * its own test id and then reads that card's facts by `data-fact`, using the NEAREST enclosing
 * `<section>` as the scope. That resolution is invisible to the component tests beside this one:
 * they assert that a card renders `data-state` and `data-fact`, not that a reader scoping the way
 * the lane scopes will find them together, and not that a fact of the same name on a sibling card
 * stays out of reach.
 *
 * Getting that wrong is this repository's most expensive defect class — a reader deriving a key the
 * writer never used, surfacing as a benign "unavailable" — and it is only observable in a paid live
 * run. So the resolution is pinned here, on the real rendered markup, at no cost.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingWorkbenchDraftDelivery } from "./CodingWorkbenchDraftDelivery";
import { CodingWorkbenchCiReadiness } from "./CodingWorkbenchCiReadiness";
import { CodingWorkbenchCommitResult } from "./CodingWorkbenchCommitResult";
import { CodingWorkbenchJourneyOutcome } from "./CodingWorkbenchJourneyOutcome";
import { journeyFixture } from "./_journeyOutcomeTestSupport";
import { draftDeliverySnapshot } from "./_draftDeliveryTestSupport";
import { descriptionStatusSnapshot } from "./_workbenchDescriptionStatusTestSupport";
import { ciReadinessSnapshot } from "./_ciReadinessTestSupport";
import type { VerifiedCommitResult } from "@oscharko-dev/keiko-contracts";

/** The lane's own scope resolution: the nearest enclosing section of the card's test id. */
function card(testId: string): HTMLElement {
  const section = screen.getByTestId(testId).closest("section");
  if (section === null) throw new Error(`no enclosing section for "${testId}"`);
  return section;
}

function fact(testId: string, id: string): string {
  return card(testId).querySelector(`[data-fact="${id}"] dd`)?.textContent?.trim() ?? "";
}

function commitReceipt(): VerifiedCommitResult {
  return {
    schemaVersion: "1",
    status: "succeeded",
    reason: "completed",
    recordedAt: "2026-09-04T10:00:00.000Z",
    proposalId: "proposal-1",
    runId: "run-1",
    envelopeDigest: "a".repeat(64),
    runtimeAuthorityDigest: "b".repeat(64),
    workspaceDigest: "c".repeat(64),
    repositoryDigest: "d".repeat(64),
    baseSha: "1".repeat(40),
    parentSha: "2".repeat(40),
    stagedTreeDigest: "3".repeat(64),
    messageDigest: "4".repeat(64),
    verificationEvidenceId: "verification-3386",
    headSha: "5".repeat(40),
    committedTreeDigest: "3".repeat(64),
  };
}

describe("Code task observation contract (#3390)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The lane reads each card in ONE round trip so every value comes from the same paint, and that
  // atomic read finds the card's status with a bare `[data-state]` query inside the card. A second
  // `data-state` anywhere in the same card would make it read the wrong element.
  it.each([
    [
      "cwb-draft-delivery-state",
      (): void => void render(<CodingWorkbenchDraftDelivery snapshot={draftDeliverySnapshot()} />),
    ],
    [
      "cwb-description-status",
      (): void =>
        void render(<CodingWorkbenchDraftDelivery snapshot={descriptionStatusSnapshot()} />),
    ],
    [
      "cwb-commit-result",
      (): void =>
        void render(<CodingWorkbenchCommitResult result={commitReceipt()} runId="run-1" />),
    ],
  ] as const)("carries exactly one data-state element inside the %s card", (testId, mount) => {
    mount();
    expect(card(testId).querySelectorAll("[data-state]")).toHaveLength(1);
  });

  it("resolves every delivery fact from the delivery card's own scope", () => {
    render(<CodingWorkbenchDraftDelivery snapshot={draftDeliverySnapshot()} />);
    const state = screen.getByTestId("cwb-draft-delivery-state");
    expect(state).toHaveAttribute("data-state", "draft-created");
    expect(state).toHaveAttribute("data-reason", "completed");
    // Every id `observedDelivery` asks for, from the scope it asks in.
    expect(fact("cwb-draft-delivery-state", "repository")).toBe("owner/repository");
    expect(fact("cwb-draft-delivery-state", "issueNumber")).toBe("#42");
    expect(fact("cwb-draft-delivery-state", "headRef")).toBe("feature/issue-42");
    expect(fact("cwb-draft-delivery-state", "headSha")).toBe("3".repeat(40));
    expect(fact("cwb-draft-delivery-state", "baseRef")).toBe("main");
    expect(fact("cwb-draft-delivery-state", "baseSha")).toBe("1".repeat(40));
    expect(fact("cwb-draft-delivery-state", "proposalId")).toBe("draft-1");
    expect(fact("cwb-draft-delivery-state", "remoteHead")).toBe("3".repeat(40));
    expect(fact("cwb-draft-delivery-state", "remoteBase")).toBe("1".repeat(40));
    // The pull request number is taken from the link's HREF, never from its translated label.
    const href = card("cwb-draft-delivery-state").querySelector("a")?.getAttribute("href") ?? "";
    expect(/\/pull\/(\d+)(?:[/?#]|$)/u.exec(href)?.[1]).toBe("7");
  });

  it("keeps the description card's facts out of the delivery card's scope, and the reverse", () => {
    // Both cards render a `headSha` fact and are siblings under the same window. A reader scoping
    // to an OUTER section would resolve whichever came first in the DOM for both.
    render(<CodingWorkbenchDraftDelivery snapshot={descriptionStatusSnapshot()} />);
    const status = screen.getByTestId("cwb-description-status");
    expect(status).toHaveAttribute("data-state", "current");
    expect(status).toHaveAttribute("data-reason", "generated");
    expect(fact("cwb-description-status", "headSha")).toBe("3".repeat(40));
    expect(fact("cwb-description-status", "generationVersion")).toBe("1");
    expect(card("cwb-description-status").querySelector('[data-fact="repository"]')).toBeNull();
  });

  // The CI card reports a DISPLAYED state, which becomes `stale` once the observation window has
  // passed — the lane depends on exactly that, so the clock is pinned inside the window here the
  // same way the card's own suite pins it.
  it("resolves the CI observation's facts and check counts from the CI card's own scope", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-09-05T00:00:05.000Z").getTime());
    render(<CodingWorkbenchCiReadiness snapshot={ciReadinessSnapshot()} />);
    expect(screen.getByTestId("cwb-ci-state")).toHaveAttribute("data-state", "technical-ready");
    expect(fact("cwb-ci-state", "headSha")).toBe("3".repeat(40));
    const scope = card("cwb-ci-state");
    for (const kind of ["required", "advisory"] as const) {
      const group = scope.querySelector(`[data-checks="${kind}"]`);
      expect(group, `${kind} check counts must be addressable`).not.toBeNull();
      for (const count of ["total", "passed", "failed", "pending", "blocked", "unknown"]) {
        expect(group?.querySelector(`[data-count="${count}"] dd`)?.textContent).toMatch(/^\d+$/u);
      }
    }
  });

  // After the run has settled, the Issue handoff card's CI group is the operator's only current CI
  // reading, and the lane reads it through the same mapper as the CI card (`observedCiPicture`).
  // Its scope is the group's OWN section, nested inside the handoff card: the handoff's state and
  // the CI group's state are two different facts and must never resolve to each other.
  it("resolves the handoff's CI group from its own nested scope, apart from the handoff state", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-09-05T00:00:05.000Z").getTime());
    render(<CodingWorkbenchJourneyOutcome {...journeyFixture()} />);
    const journey = card("cwb-journey-state");
    const ci = card("cwb-journey-ci");
    expect(ci).not.toBe(journey);
    expect(journey.contains(ci)).toBe(true);
    expect(screen.getByTestId("cwb-journey-ci")).toHaveAttribute("data-state", "technical-ready");
    expect(fact("cwb-journey-ci", "headSha")).toBe("3".repeat(40));
    for (const kind of ["required", "advisory"] as const) {
      const group = ci.querySelector(`[data-checks="${kind}"]`);
      expect(group, `${kind} check counts must be addressable`).not.toBeNull();
      for (const count of ["total", "passed", "failed", "pending", "blocked", "unknown"]) {
        expect(group?.querySelector(`[data-count="${count}"] dd`)?.textContent).toMatch(/^\d+$/u);
      }
    }
    // The CI group's state is the only data-state inside its own scope.
    expect(ci.querySelectorAll("[data-state]")).toHaveLength(1);
  });

  it("resolves the commit receipt's facts from the receipt card's own scope", () => {
    render(<CodingWorkbenchCommitResult result={commitReceipt()} runId="run-1" />);
    const state = screen.getByTestId("cwb-commit-result");
    expect(state).toHaveAttribute("data-state", "succeeded");
    expect(state).toHaveAttribute("data-reason", "completed");
    expect(fact("cwb-commit-result", "headSha")).toBe("5".repeat(40));
    expect(fact("cwb-commit-result", "verificationEvidenceId")).toBe("verification-3386");
    expect(fact("cwb-commit-result", "proposalId")).toBe("proposal-1");
  });
});
