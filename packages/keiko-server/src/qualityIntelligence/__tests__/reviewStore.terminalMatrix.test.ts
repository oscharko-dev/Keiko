// GEN-DUP-SEMANTIC-008 regression: the terminal-review-state predicate that gates the
// edit-after-terminal-review reopen logic is now the shared
// `QualityIntelligence.isTerminalReviewState` from keiko-contracts (was a local
// `TERMINAL_REVIEW_STATES` Set). This matrix pins that the observable disable/reopen behaviour of
// `appendEditAudit` is byte-identical across every review state: editing a candidate whose effective
// review state is terminal (approved / rejected / withdrawn) reopens it to `changes-requested` with
// revalidation+rejudge governance flags and invalidates a run-level terminal approval, while editing
// a non-terminal candidate (open / changes-requested) leaves the state untouched.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import {
  appendEditAudit,
  applyReviewDecision,
  candidateReviewStateOf,
  loadRunReviewState,
} from "../reviewStore.js";

const dirs: string[] = [];
const identity = (value: unknown): unknown => value;
const NOW = "2026-07-03T10:00:00.000Z";
const ACTOR = { actorId: "reviewer", displayLabel: "Reviewer" } as const;

function freshEvidenceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "keiko-qi-review-terminal-"));
  dirs.push(dir);
  return dir;
}

// Drive a candidate into `state` through the legal transition chain, then edit it once.
function candidateStateAfterEdit(state: QualityIntelligence.QualityIntelligenceReviewState): {
  readonly runId: string;
  readonly evidenceDir: string;
} {
  const evidenceDir = freshEvidenceDir();
  const runId = `run-terminal-${state}`;
  const candidateId = "tc-1";
  const decide = (action: QualityIntelligence.QualityIntelligenceReviewAction): void => {
    applyReviewDecision({
      runId,
      evidenceDir,
      action,
      scope: "candidate",
      candidateId,
      actor: ACTOR,
      now: NOW,
      redact: identity,
    });
  };
  // open is the default; everything else is one legal hop from open.
  if (state === "approved") decide("approve");
  else if (state === "rejected") decide("reject");
  else if (state === "withdrawn") decide("withdraw");
  else if (state === "changes-requested") decide("request-changes");
  return { runId, evidenceDir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("appendEditAudit terminal-disable matrix (GEN-DUP-SEMANTIC-008)", () => {
  it("keeps the contract terminal set in lockstep with the tested matrix", () => {
    expect(QualityIntelligence.QUALITY_INTELLIGENCE_TERMINAL_REVIEW_STATES).toEqual([
      "approved",
      "rejected",
      "withdrawn",
    ]);
  });

  for (const state of QualityIntelligence.QUALITY_INTELLIGENCE_TERMINAL_REVIEW_STATES) {
    it(`reopens a candidate in terminal state "${state}" to changes-requested on edit`, () => {
      const { runId, evidenceDir } = candidateStateAfterEdit(state);
      const next = appendEditAudit({
        runId,
        evidenceDir,
        candidateId: "tc-1",
        reviewerLabel: "Reviewer",
        actor: ACTOR,
        now: NOW,
        redact: identity,
      });
      expect(next.candidateStates["tc-1"]).toBe("changes-requested");
      const editEntry = next.auditLog.at(-1);
      expect(editEntry?.action).toBe("edit");
      expect(editEntry?.fromState).toBe(state);
      expect(editEntry?.toState).toBe("changes-requested");
      expect(editEntry?.reason).toBe("candidate-edited-after-terminal-review");
      expect(editEntry?.governanceFlags).toEqual(["needs-revalidation", "needs-rejudge"]);
    });
  }

  for (const state of ["open", "changes-requested"] as const) {
    it(`leaves a non-terminal candidate in state "${state}" unchanged on edit`, () => {
      const { runId, evidenceDir } = candidateStateAfterEdit(state);
      const next = appendEditAudit({
        runId,
        evidenceDir,
        candidateId: "tc-1",
        reviewerLabel: "Reviewer",
        actor: ACTOR,
        now: NOW,
        redact: identity,
      });
      // A non-terminal edit never rewrites the candidate map — the effective review state is left
      // exactly where it was (materialized "changes-requested" stays; a fresh "open" candidate is
      // still resolved as "open" by candidateReviewStateOf, not persisted).
      expect(candidateReviewStateOf(next, "tc-1")).toBe(state);
      const editEntry = next.auditLog.at(-1);
      expect(editEntry?.action).toBe("edit");
      expect(editEntry?.fromState).toBe(state);
      expect(editEntry?.toState).toBe(state);
      expect(editEntry?.reason).toBeUndefined();
      expect(editEntry?.governanceFlags).toBeUndefined();
    });
  }

  it("invalidates a run-level terminal approval when any candidate is edited", () => {
    const evidenceDir = freshEvidenceDir();
    const runId = "run-terminal-run-approval";
    applyReviewDecision({
      runId,
      evidenceDir,
      action: "approve",
      scope: "run",
      actor: ACTOR,
      now: NOW,
      redact: identity,
    });
    expect(loadRunReviewState(runId, evidenceDir)?.runState).toBe("approved");

    const next = appendEditAudit({
      runId,
      evidenceDir,
      candidateId: "tc-1",
      reviewerLabel: "Reviewer",
      actor: ACTOR,
      now: NOW,
      redact: identity,
    });
    expect(next.runState).toBe("changes-requested");
    expect(next.candidateStates["tc-1"]).toBe("changes-requested");
  });
});
