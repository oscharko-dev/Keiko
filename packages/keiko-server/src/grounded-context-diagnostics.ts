// PR4-W1 grounded diagnostics observer (ADR-0055 D1). A PURE, no-IO, no-clock function that
// accepts a fully assembled `ConnectedContextPack` and a `ContextProfile` and returns a pack
// whose `diagnostics.contextBudget?` is populated with a deterministic `ContextBudget` derived by
// running the keiko-workflows allocator over lanes mapped from the pack.
//
// NON-NEGOTIABLE INVARIANT (AC5): this observer MUST NOT touch any field a prompt builder reads.
// `buildGroundedGatewayMessages` (grounded-qa.ts) reads only pack.schemaVersion / stableId /
// scope / query / budget / usage / omitted / files / uncertainty — never pack.diagnostics. The
// observer therefore changes ONLY the additive optional `diagnostics.contextBudget?` field while
// preserving the existing `diagnostics.rankedCandidates` (the first-lexical-ring explainability).
// pack.files, pack.budget, pack.usage and pack.stableId are returned reference-identical.

import type {
  ConnectedContextPack,
  ContextPackDiagnostics,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  type ContextAssemblyDiagnostics,
  type ContextBudget,
  type ContextProfile,
} from "@oscharko-dev/keiko-contracts";
import {
  allocateContext,
  DEFAULT_CONTEXT_BUDGET,
  type AllocateContextResult,
  type ContextLaneInput,
  type ContextLaneItemInput,
} from "@oscharko-dev/keiko-workflows";

// The grounded path carries repository evidence excerpts only; the system-contract / user-task /
// plan / tool / memory / history / verification lanes are not assembled here, so they are passed
// empty. Diagnostics over the populated repo-evidence lane are the W1 deliverable.
function repoEvidenceLaneItems(pack: ConnectedContextPack): readonly ContextLaneItemInput[] {
  const items: ContextLaneItemInput[] = [];
  for (const file of pack.files) {
    for (const excerpt of file.excerpts) {
      items.push({
        id: excerpt.atom.stableId,
        text: excerpt.content,
        score: excerpt.atom.score,
      });
    }
  }
  return items;
}

function groundedLanes(pack: ConnectedContextPack): readonly ContextLaneInput[] {
  return [{ laneId: "repo-evidence", items: repoEvidenceLaneItems(pack) }];
}

// Builds a ContextBudget whose `profile` is the supplied profile (so validateContextBudget's
// profile-identity check holds) while reusing the canonical, tunable lane rows. Pure — no clock,
// no IO, never mutates the inputs.
function budgetForProfile(profile: ContextProfile): ContextBudget {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    profile,
    lanes: DEFAULT_CONTEXT_BUDGET.lanes,
  };
}

function diagnosticsWithBudget(
  existing: ContextPackDiagnostics | undefined,
  budget: ContextBudget,
): ContextPackDiagnostics {
  const rankedCandidates = existing?.rankedCandidates ?? [];
  return { ...existing, rankedCandidates, contextBudget: budget };
}

// SHARED lane-derivation + allocation pass (single source of truth for the observer AND the
// evidence producer below). Pure, no-IO, no-clock: maps the pack's repo-evidence lane, builds the
// profile budget, and runs the deterministic allocator once. Both the BFF/UI ContextBudget slot
// and the regulated ContextAssemblyDiagnostics are projected from THIS result — there is no
// divergent derivation path that could let the two views disagree for the same pack + profile.
function allocateGroundedContext(
  pack: ConnectedContextPack,
  profile: ContextProfile,
): { readonly budget: ContextBudget; readonly result: AllocateContextResult } {
  const budget = budgetForProfile(profile);
  const result = allocateContext({ profile, budget, lanes: groundedLanes(pack) });
  return { budget, result };
}

// EVIDENCE producer (ADR-0056 W3). Returns the rich ContextAssemblyDiagnostics
// (allocateContext(...).diagnostics) for the pack's repo-evidence lane under the supplied profile.
// This is the value persisted to EvidenceManifest.contextAssembly? — NOT the ContextBudget that
// ContextPackDiagnostics.contextBudget? carries. Derives the lane via the same shared helper the
// observer uses, so the persisted diagnostics describe exactly the budget plan the observer
// attached. Pure and deterministic.
export function deriveGroundedContextAssembly(
  pack: ConnectedContextPack,
  profile: ContextProfile,
): ContextAssemblyDiagnostics {
  return allocateGroundedContext(pack, profile).result.diagnostics;
}

// Runs the deterministic allocator over the pack-derived lanes and attaches the resulting
// ContextBudget to pack.diagnostics.contextBudget. The allocator pass exercises the budget plan
// over real lane items (proving the budget is meaningful for this pack); the attached value is the
// ContextBudget that ContextPackDiagnostics.contextBudget? carries (the only diagnostics slot the
// pack contract exposes). All other pack fields are returned unchanged.
export function attachContextBudgetDiagnostics(
  pack: ConnectedContextPack,
  profile: ContextProfile,
): ConnectedContextPack {
  const { budget } = allocateGroundedContext(pack, profile);
  return {
    ...pack,
    diagnostics: diagnosticsWithBudget(pack.diagnostics, budget),
  };
}
