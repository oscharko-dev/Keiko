import { describe, expect, it } from "vitest";

import type { MemoryId, MemoryProposalId } from "@oscharko-dev/keiko-contracts/memory";
import {
  validateMemoryProposal,
  validateMemorySupersession,
} from "@oscharko-dev/keiko-contracts/memory";

import { buildCorrection } from "./correction.js";
import { GovernanceError } from "./errors.js";
import { ctx, FIXED_NOW_MS, makeRecord } from "./_support.js";

describe("buildCorrection", () => {
  it("returns a validated correction proposal AND a validated supersession", () => {
    const older = makeRecord({ id: "m-old", body: "we ship on Friday" });
    const { proposal, supersession } = buildCorrection({
      olderMemory: older,
      correctedBody: "we ship on Thursday",
      context: ctx(),
      newProposalId: "p-1" as MemoryProposalId,
      newMemoryId: "m-new" as MemoryId,
    });

    expect(validateMemoryProposal(proposal).ok).toBe(true);
    expect(validateMemorySupersession(supersession).ok).toBe(true);

    expect(proposal.type).toBe("correction");
    expect(proposal.body).toBe("we ship on Thursday");
    expect(proposal.initialStatus).toBe("proposed");
    expect(proposal.provenance.sourceKind).toBe("accepted-correction");
    expect(proposal.scope).toEqual(older.scope);
    expect(proposal.proposedAt).toBe(FIXED_NOW_MS);

    expect(supersession.oldMemoryId).toBe("m-old");
    expect(supersession.newMemoryId).toBe("m-new");
    expect(supersession.edgeKind).toBe("supersedes");
  });

  it("inherits the older memory's confidence and sensitivity by default", () => {
    const older = makeRecord({ id: "m-old", confidence: 0.42 });
    const { proposal } = buildCorrection({
      olderMemory: older,
      correctedBody: "the new fact",
      context: ctx(),
      newProposalId: "p-2" as MemoryProposalId,
      newMemoryId: "m-new" as MemoryId,
    });
    expect(proposal.provenance.confidence).toBeCloseTo(0.42);
    expect(proposal.provenance.sensitivity).toBe("confidential");
  });

  it("honours an explicit sensitivity override", () => {
    const older = makeRecord({ id: "m-old" });
    const { proposal } = buildCorrection({
      olderMemory: older,
      correctedBody: "an even more sensitive correction",
      context: ctx(),
      newProposalId: "p-3" as MemoryProposalId,
      newMemoryId: "m-new" as MemoryId,
      sensitivity: "restricted",
    });
    expect(proposal.provenance.sensitivity).toBe("restricted");
  });

  it("threads the caller-supplied reason into both envelopes", () => {
    const older = makeRecord({ id: "m-old" });
    const { proposal, supersession } = buildCorrection({
      olderMemory: older,
      correctedBody: "the new body",
      context: ctx(),
      newProposalId: "p-4" as MemoryProposalId,
      newMemoryId: "m-new" as MemoryId,
      reason: "user reported the fact was outdated",
    });
    expect(proposal.captureReason).toBe("user reported the fact was outdated");
    expect(supersession.reason).toBe("user reported the fact was outdated");
  });

  it("rejects a correction whose old id equals the new id", () => {
    const older = makeRecord({ id: "m-same" });
    expect(() =>
      buildCorrection({
        olderMemory: older,
        correctedBody: "x",
        context: ctx(),
        newProposalId: "p-5" as MemoryProposalId,
        newMemoryId: "m-same" as MemoryId,
      }),
    ).toThrow(GovernanceError);
  });

  it("rejects a correction with an empty body via the contracts validator", () => {
    const older = makeRecord({ id: "m-old" });
    expect(() =>
      buildCorrection({
        olderMemory: older,
        correctedBody: "",
        context: ctx(),
        newProposalId: "p-6" as MemoryProposalId,
        newMemoryId: "m-new" as MemoryId,
      }),
    ).toThrow(/envelope-validation-failed/);
  });
});
