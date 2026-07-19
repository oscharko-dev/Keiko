// Property/enumeration tests for the mode-aware capture decision function (issue #2546). No
// fast-check: the input space (modes x sensitivity x requiresApproval x outcome-kind) is tiny and
// fully enumerated. These pin the three load-bearing algebraic properties from the design's failure
// matrix: monotonicity of auto-accept eligibility over the mode order, hard-denial invariance, and
// idempotence of the persistability enforcement.

import { describe, expect, it } from "vitest";
import { CODING_WORKBENCH_MODES, type CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type {
  MemoryProposal,
  MemoryProposalId,
  MemorySensitivity,
  ProjectId,
} from "@oscharko-dev/keiko-contracts/memory";
import type { CaptureOutcome } from "@oscharko-dev/keiko-memory-capture";
import {
  enforcePersistableMemoryOutcome,
  isPersistableMemoryCandidate,
  memoryCaptureAutoAcceptEligible,
  resolveMemoryCaptureAutonomyMode,
} from "./memory-capture-policy.js";

const SENSITIVITIES: readonly MemorySensitivity[] = ["public", "confidential", "restricted"];

describe("requested memory mode authority clamp", () => {
  it("never exceeds the deployment ceiling and preserves legacy ceiling behavior when absent", () => {
    const deploymentCeilings = CODING_WORKBENCH_MODES;
    for (const ceiling of deploymentCeilings) {
      expect(resolveMemoryCaptureAutonomyMode({ codingRuntimeDeploymentCeiling: ceiling })).toBe(
        ceiling,
      );
      for (const requested of CODING_WORKBENCH_MODES) {
        const effective = resolveMemoryCaptureAutonomyMode(
          { codingRuntimeDeploymentCeiling: ceiling },
          requested,
        );
        expect(authorityRank(effective)).toBeLessThanOrEqual(authorityRank(ceiling));
        expect(authorityRank(effective)).toBeLessThanOrEqual(authorityRank(requested));
      }
    }
  });
});

// CODING_WORKBENCH_MODES is the authority-ordered array (governed-assist < supervised-coding <
// autonomous-delivery); its index is the monotonic authority rank the eligibility set is
// upward-closed over.
function authorityRank(mode: CodingWorkbenchMode): number {
  return CODING_WORKBENCH_MODES.indexOf(mode);
}

function candidateProposal(sensitivity: MemorySensitivity): MemoryProposal {
  return {
    schemaVersion: "1",
    proposalId: "proposal-1" as MemoryProposalId,
    proposedAt: 1_700_000_000_000,
    scope: { kind: "project", projectId: "proj-1" as ProjectId },
    type: "semantic-fact",
    body: "The platform team ships releases on a fortnightly cadence.",
    tags: [],
    provenance: {
      sourceKind: "system-default",
      capturedAt: 1_700_000_000_000,
      confidence: 0.7,
      sensitivity,
    },
    validity: { validFrom: 1_700_000_000_000 },
    initialStatus: "proposed",
  };
}

function candidateOutcome(
  sensitivity: MemorySensitivity,
  requiresApproval: boolean,
): CaptureOutcome {
  return { kind: "candidate", proposal: candidateProposal(sensitivity), requiresApproval };
}

// Non-candidate outcomes: enforcement and eligibility must never mutate or "upgrade" these.
const NON_CANDIDATE_OUTCOMES: readonly CaptureOutcome[] = [
  { kind: "rejected", reason: "empty-content" },
  {
    kind: "forget",
    operation: {
      schemaVersion: "1",
      memoryId: "mem-1" as never,
      reason: "user-request",
      requestedAt: 1_700_000_000_000,
    } as never,
    requiresConfirmation: true,
  },
];

describe("memoryCaptureAutoAcceptEligible — monotonicity over the mode order", () => {
  it("is upward-closed: once eligible at a mode, it stays eligible for every higher-authority mode", () => {
    for (const sensitivity of SENSITIVITIES) {
      for (const requiresApproval of [false, true]) {
        const outcome = candidateOutcome(sensitivity, requiresApproval);
        for (const lower of CODING_WORKBENCH_MODES) {
          for (const higher of CODING_WORKBENCH_MODES) {
            if (authorityRank(higher) < authorityRank(lower)) continue;
            if (memoryCaptureAutoAcceptEligible(lower, outcome)) {
              expect(memoryCaptureAutoAcceptEligible(higher, outcome)).toBe(true);
            }
          }
        }
      }
    }
  });

  it("is never eligible under governed-assist (the fail-closed baseline)", () => {
    for (const sensitivity of SENSITIVITIES) {
      for (const requiresApproval of [false, true]) {
        const outcome = candidateOutcome(sensitivity, requiresApproval);
        expect(memoryCaptureAutoAcceptEligible("governed-assist", outcome)).toBe(false);
      }
    }
  });

  it("is eligible ONLY for a public, no-approval candidate above governed-assist", () => {
    const elevated: readonly CodingWorkbenchMode[] = ["supervised-coding", "autonomous-delivery"];
    for (const mode of elevated) {
      expect(memoryCaptureAutoAcceptEligible(mode, candidateOutcome("public", false))).toBe(true);
      expect(memoryCaptureAutoAcceptEligible(mode, candidateOutcome("public", true))).toBe(false);
      expect(memoryCaptureAutoAcceptEligible(mode, candidateOutcome("confidential", false))).toBe(
        false,
      );
      expect(memoryCaptureAutoAcceptEligible(mode, candidateOutcome("restricted", false))).toBe(
        false,
      );
    }
  });
});

describe("hard-denial invariance across every mode", () => {
  it("restricted is never persistable and never eligible in any mode", () => {
    const outcome = candidateOutcome("restricted", false);
    expect(isPersistableMemoryCandidate(outcome)).toBe(false);
    for (const mode of CODING_WORKBENCH_MODES) {
      expect(memoryCaptureAutoAcceptEligible(mode, outcome)).toBe(false);
    }
  });

  it("confidential (requires approval) is never eligible in any mode", () => {
    const outcome = candidateOutcome("confidential", true);
    for (const mode of CODING_WORKBENCH_MODES) {
      expect(memoryCaptureAutoAcceptEligible(mode, outcome)).toBe(false);
    }
  });
});

describe("enforcePersistableMemoryOutcome — idempotence and kind preservation", () => {
  it("is idempotent for every sensitivity x requiresApproval candidate", () => {
    for (const sensitivity of SENSITIVITIES) {
      for (const requiresApproval of [false, true]) {
        const outcome = candidateOutcome(sensitivity, requiresApproval);
        const once = enforcePersistableMemoryOutcome(outcome);
        const twice = enforcePersistableMemoryOutcome(once);
        expect(twice).toEqual(once);
      }
    }
  });

  it("rewrites only restricted candidates to rejected; leaves persistable candidates intact", () => {
    for (const sensitivity of SENSITIVITIES) {
      const outcome = candidateOutcome(sensitivity, false);
      const enforced = enforcePersistableMemoryOutcome(outcome);
      if (sensitivity === "restricted") {
        expect(enforced.kind).toBe("rejected");
      } else {
        expect(enforced).toEqual(outcome);
      }
    }
  });

  it("never turns a non-candidate outcome into a candidate", () => {
    for (const outcome of NON_CANDIDATE_OUTCOMES) {
      const enforced = enforcePersistableMemoryOutcome(outcome);
      expect(enforced.kind).not.toBe("candidate");
      expect(enforced).toEqual(outcome);
      for (const mode of CODING_WORKBENCH_MODES) {
        expect(memoryCaptureAutoAcceptEligible(mode, outcome)).toBe(false);
      }
    }
  });
});
