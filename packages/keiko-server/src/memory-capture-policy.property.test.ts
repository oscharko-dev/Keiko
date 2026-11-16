// Property/enumeration tests for the capture decision function (#2546, #4206). No fast-check: the
// input space (ceilings x configuration x sensitivity x requiresApproval x outcome-kind) is tiny
// and fully enumerated. These pin the load-bearing properties: a routine private fact is accepted
// whatever the mode, a team or project fact keeps the monotonic mode rule (project memory is step 3,
// not #4206), only an explicit operator restriction holds a private fact, hard denials are invariant,
// and the persistability enforcement is idempotent.

import { describe, expect, it } from "vitest";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_MODES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type {
  MemoryProposal,
  MemoryProposalId,
  MemorySensitivity,
  MemoryScope,
  ProjectId,
  UserId,
} from "@oscharko-dev/keiko-contracts/memory";
import type { CaptureOutcome } from "@oscharko-dev/keiko-memory-capture";
import {
  enforcePersistableMemoryOutcome,
  isPersistableMemoryCandidate,
  memoryCaptureAutoAcceptEligible,
  memoryOperatorRestrictsAcceptance,
  memoryUnattendedAcceptanceAllowed,
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

const PRIVATE_SCOPE: MemoryScope = { kind: "user", userId: "local-operator" as UserId };
const PROJECT_SCOPE: MemoryScope = { kind: "project", projectId: "proj-1" as ProjectId };
const SCOPES: readonly MemoryScope[] = [PRIVATE_SCOPE, PROJECT_SCOPE];

function candidateProposal(sensitivity: MemorySensitivity, scope: MemoryScope): MemoryProposal {
  return {
    schemaVersion: "1",
    proposalId: "proposal-1" as MemoryProposalId,
    proposedAt: 1_700_000_000_000,
    scope,
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
  scope: MemoryScope = PRIVATE_SCOPE,
): CaptureOutcome {
  return { kind: "candidate", proposal: candidateProposal(sensitivity, scope), requiresApproval };
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

describe("memoryUnattendedAcceptanceAllowed — monotonicity over the mode order", () => {
  it("is false for governed-assist and for an absent mode, true above it", () => {
    expect(memoryUnattendedAcceptanceAllowed(undefined)).toBe(false);
    expect(memoryUnattendedAcceptanceAllowed("governed-assist")).toBe(false);
    expect(memoryUnattendedAcceptanceAllowed("supervised-coding")).toBe(true);
    expect(memoryUnattendedAcceptanceAllowed("autonomous-delivery")).toBe(true);
  });

  it("is upward-closed: allowed at one mode means allowed at every stronger mode", () => {
    for (const lower of CODING_WORKBENCH_MODES) {
      for (const higher of CODING_WORKBENCH_MODES) {
        if (authorityRank(higher) < authorityRank(lower)) continue;
        if (memoryUnattendedAcceptanceAllowed(lower)) {
          expect(memoryUnattendedAcceptanceAllowed(higher)).toBe(true);
        }
      }
    }
  });
});

describe("memoryCaptureAutoAcceptEligible — a routine private fact needs no approval (#4206)", () => {
  it("accepts a private routine fact in every mode under every unrestricted composition", () => {
    let checked = 0;
    for (const deps of UNRESTRICTED_DEPS) {
      expect(memoryOperatorRestrictsAcceptance(deps)).toBe(false);
      for (const mode of CODING_WORKBENCH_MODES) {
        const effective = resolveMemoryCaptureAutonomyMode(deps, mode);
        const outcome = candidateOutcome("public", false, PRIVATE_SCOPE);
        expect(memoryCaptureAutoAcceptEligible(deps, effective, outcome)).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBe(UNRESTRICTED_DEPS.length * CODING_WORKBENCH_MODES.length);
  });

  it("keeps the monotonic mode rule for a team or project fact", () => {
    const outcome = candidateOutcome("public", false, PROJECT_SCOPE);
    for (const deps of UNRESTRICTED_DEPS) {
      for (const mode of CODING_WORKBENCH_MODES) {
        expect(memoryCaptureAutoAcceptEligible(deps, mode, outcome)).toBe(
          memoryUnattendedAcceptanceAllowed(mode),
        );
      }
      expect(memoryCaptureAutoAcceptEligible(deps, "governed-assist", outcome)).toBe(false);
    }
  });

  it("holds every candidate in every scope and mode under an explicit operator restriction", () => {
    for (const deps of RESTRICTED_DEPS) {
      expect(memoryOperatorRestrictsAcceptance(deps)).toBe(true);
      for (const mode of CODING_WORKBENCH_MODES) {
        for (const scope of SCOPES) {
          for (const sensitivity of SENSITIVITIES) {
            for (const requiresApproval of [false, true]) {
              const outcome = candidateOutcome(sensitivity, requiresApproval, scope);
              expect(memoryCaptureAutoAcceptEligible(deps, mode, outcome)).toBe(false);
            }
          }
        }
      }
    }
  });
});

describe("hard-denial invariance across every composition, scope and mode", () => {
  const everyDeps = [...UNRESTRICTED_DEPS, ...RESTRICTED_DEPS];

  function neverEligible(outcome: CaptureOutcome): void {
    for (const deps of everyDeps) {
      for (const mode of CODING_WORKBENCH_MODES) {
        expect(memoryCaptureAutoAcceptEligible(deps, mode, outcome)).toBe(false);
      }
    }
  }

  it("restricted is never persistable and never eligible", () => {
    for (const scope of SCOPES) {
      const outcome = candidateOutcome("restricted", false, scope);
      expect(isPersistableMemoryCandidate(outcome)).toBe(false);
      neverEligible(outcome);
    }
  });

  it("confidential content is refused, never parked for a review that no longer exists", () => {
    for (const scope of SCOPES) {
      for (const requiresApproval of [false, true]) {
        const outcome = candidateOutcome("confidential", requiresApproval, scope);
        expect(isPersistableMemoryCandidate(outcome)).toBe(false);
        neverEligible(outcome);
      }
    }
  });

  it("a candidate that still asks for approval is refused even when public", () => {
    for (const scope of SCOPES) {
      const outcome = candidateOutcome("public", true, scope);
      expect(isPersistableMemoryCandidate(outcome)).toBe(false);
      neverEligible(outcome);
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
        for (const mode of CODING_WORKBENCH_MODES) {
          expect(memoryCaptureAutoAcceptEligible(deps, mode, outcome)).toBe(false);
        }
      }
    }
  });
});
