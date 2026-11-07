// Property/enumeration tests for the capture decision function (#2546, #4206). No fast-check: the
// input space (ceilings x configuration x sensitivity x requiresApproval x outcome-kind) is tiny
// and fully enumerated. These pin the load-bearing properties: a routine fact is accepted whatever
// the mode, only an explicit operator restriction holds it, hard denials are invariant, and the
// persistability enforcement is idempotent.

import { describe, expect, it } from "vitest";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_MODES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
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
  memoryOperatorRestrictsAcceptance,
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

type CeilingDeps = Parameters<typeof memoryCaptureAutoAcceptEligible>[0];

// Every way a composition can state, or not state, its Memory ceiling.
const UNRESTRICTED_DEPS: readonly CeilingDeps[] = [
  {},
  { memoryDeploymentCeiling: "governed-assist", memoryDeploymentCeilingConfigured: false },
  ...CODING_WORKBENCH_MODES.filter((mode) => mode !== "governed-assist").flatMap(
    (mode): CeilingDeps[] => [
      { memoryDeploymentCeiling: mode },
      { codingRuntimeDeploymentCeiling: mode },
      { memoryDeploymentCeiling: mode, memoryDeploymentCeilingConfigured: true },
    ],
  ),
];
const RESTRICTED_DEPS: readonly CeilingDeps[] = [
  { memoryDeploymentCeiling: "governed-assist" },
  { codingRuntimeDeploymentCeiling: "governed-assist" },
  { memoryDeploymentCeiling: "governed-assist", memoryDeploymentCeilingConfigured: true },
  // A configured Coding ceiling does not lift a configured Memory restriction.
  {
    memoryDeploymentCeiling: "governed-assist",
    memoryDeploymentCeilingConfigured: true,
    codingRuntimeDeploymentCeiling: "autonomous-delivery",
  },
];

describe("memoryCaptureAutoAcceptEligible — a routine fact needs no approval (#4206)", () => {
  it("accepts a public, no-approval candidate under every unrestricted composition", () => {
    for (const deps of UNRESTRICTED_DEPS) {
      expect(memoryOperatorRestrictsAcceptance(deps)).toBe(false);
      expect(memoryCaptureAutoAcceptEligible(deps, candidateOutcome("public", false))).toBe(true);
    }
  });

  it("does not depend on the mode a person selected", () => {
    for (const requested of CODING_WORKBENCH_MODES) {
      const mode = resolveMemoryCaptureAutonomyMode({}, requested);
      expect(mode).toBe("governed-assist");
      expect(memoryCaptureAutoAcceptEligible({}, candidateOutcome("public", false))).toBe(true);
    }
  });

  it("holds every candidate for review under an explicit operator restriction", () => {
    for (const deps of RESTRICTED_DEPS) {
      expect(memoryOperatorRestrictsAcceptance(deps)).toBe(true);
      for (const sensitivity of SENSITIVITIES) {
        for (const requiresApproval of [false, true]) {
          const outcome = candidateOutcome(sensitivity, requiresApproval);
          expect(memoryCaptureAutoAcceptEligible(deps, outcome)).toBe(false);
        }
      }
    }
  });
});

describe("hard-denial invariance across every composition", () => {
  const everyDeps = [...UNRESTRICTED_DEPS, ...RESTRICTED_DEPS];

  it("restricted is never persistable and never eligible", () => {
    const outcome = candidateOutcome("restricted", false);
    expect(isPersistableMemoryCandidate(outcome)).toBe(false);
    for (const deps of everyDeps) {
      expect(memoryCaptureAutoAcceptEligible(deps, outcome)).toBe(false);
    }
  });

  it("confidential content is refused, never parked for a review that no longer exists", () => {
    for (const requiresApproval of [false, true]) {
      const outcome = candidateOutcome("confidential", requiresApproval);
      expect(isPersistableMemoryCandidate(outcome)).toBe(false);
      for (const deps of everyDeps) {
        expect(memoryCaptureAutoAcceptEligible(deps, outcome)).toBe(false);
      }
    }
  });

  it("a candidate that still asks for approval is refused even when public", () => {
    const outcome = candidateOutcome("public", true);
    expect(isPersistableMemoryCandidate(outcome)).toBe(false);
    for (const deps of everyDeps) {
      expect(memoryCaptureAutoAcceptEligible(deps, outcome)).toBe(false);
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

  it("rewrites every non-routine candidate to rejected; leaves a routine candidate intact", () => {
    for (const sensitivity of SENSITIVITIES) {
      for (const requiresApproval of [false, true]) {
        const outcome = candidateOutcome(sensitivity, requiresApproval);
        const enforced = enforcePersistableMemoryOutcome(outcome);
        if (sensitivity === "public" && !requiresApproval) {
          expect(enforced).toEqual(outcome);
        } else {
          expect(enforced).toEqual({
            kind: "rejected",
            reason: "sensitive-memory-requires-approval",
          });
        }
      }
    }
  });

  it("never turns a non-candidate outcome into a candidate", () => {
    for (const outcome of NON_CANDIDATE_OUTCOMES) {
      const enforced = enforcePersistableMemoryOutcome(outcome);
      expect(enforced.kind).not.toBe("candidate");
      expect(enforced).toEqual(outcome);
      for (const deps of [...UNRESTRICTED_DEPS, ...RESTRICTED_DEPS]) {
        expect(memoryCaptureAutoAcceptEligible(deps, outcome)).toBe(false);
      }
    }
  });
});
