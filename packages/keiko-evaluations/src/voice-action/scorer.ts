// Voice Action Governance security scorer (Epic #491, Issue #503; ADR-0066).
//
// Pure per-dimension scoring + suite aggregation for the six security dimensions. Each dimension is a
// pure function (fixture, observation) -> VoiceActionDimensionResult. A dimension a fixture does not
// declare is "not-applicable" and excluded from aggregation.
//
// Each dimension combines a STRUCTURAL gate (the contract's observable behaviour — gating verdict,
// proposal presence, effect class, confirmation flag, the changed confirmation seed, and the audit
// record's content-free shape) with the fixture's oracle expectation. The structural gate is what makes
// the suite regression-sensitive: weakening the gating, letting partial text propose, dropping the
// confirmation requirement, breaking the staleness seed, or adding a text field to the audit record
// flips the corresponding dimension to FAIL.
//
// Determinism: pure. Rationales are harness-authored and content-free (counts, closed-vocabulary
// labels, numbers) — they never echo committed text or any raw transcript content.

import {
  spokenActionRequiresConfirmation,
  type SpokenActionAuditRecord,
} from "@oscharko-dev/keiko-contracts";
import {
  VOICE_ACTION_DIMENSIONS,
  type VoiceActionDimension,
  type VoiceActionDimensionResult,
  type VoiceActionEvalFixture,
  type VoiceActionObservation,
  type VoiceActionOracle,
  type VoiceActionScorecardEntry,
} from "./types.js";

// The audit record keys that MUST exist (content-free) and the substring fragments that must NEVER
// appear in any key (a text / audio field would be a content leak — AC5). Keyed explicitly so adding a
// text field to the record, or a fixture's text leaking into a key, fails the evidence-safety gate.
const FORBIDDEN_AUDIT_KEY_FRAGMENTS: readonly string[] = ["text", "audio", "transcript", "raw"];
const REQUIRED_AUDIT_KEYS: readonly (keyof SpokenActionAuditRecord)[] = [
  "schemaVersion",
  "effectClass",
  "state",
  "confirmationRequired",
  "confirmed",
  "outcome",
  "source",
  "turnIndex",
  "committedSegmentCount",
  "committedChars",
  "bindingDigest",
];

interface Check {
  readonly label: string;
  readonly ok: boolean;
}

function gate(
  dimension: VoiceActionDimension,
  checks: readonly Check[],
): VoiceActionDimensionResult {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    return {
      dimension,
      outcome: "pass",
      rationale: `${String(checks.length)}/${String(checks.length)} structural checks met.`,
    };
  }
  return {
    dimension,
    outcome: "fail",
    rationale: `failed: ${failed.map((c) => c.label).join("; ")}.`,
  };
}

// ─── Dimension scorers ─────────────────────────────────────────────────────────────
function scoreCapabilityGating(
  obs: VoiceActionObservation,
  oracle: VoiceActionOracle,
): VoiceActionDimensionResult {
  return gate("capability-gating", [
    {
      label: "voice-gating verdict matches profile expectation",
      ok: obs.gatingAllowed === oracle.expectedGatingAllowed,
    },
    {
      // A denied profile must never yield a proposal, regardless of committed text (AC1 dormancy).
      label: "denied profile yields no proposal",
      ok: oracle.expectedGatingAllowed || obs.proposal === undefined,
    },
  ]);
}

function scoreCommittedOnly(
  obs: VoiceActionObservation,
  oracle: VoiceActionOracle,
): VoiceActionDimensionResult {
  return gate("committed-only", [
    {
      label: "proposal presence matches committed-projection expectation",
      ok: (obs.proposal !== undefined) === oracle.expectsProposal,
    },
    {
      // When a proposal forms, it must rest on at least one committed segment with committed chars. When
      // a capture-capable profile produces NO proposal, the committed projection must be empty (partial /
      // discarded text excluded by AC2). A capability-denied profile is exempt: it never proposes
      // regardless of committed content, which capability-gating proves separately (AC1).
      label: "proposal presence agrees with committed projection counts",
      ok:
        obs.proposal !== undefined
          ? obs.committedSegmentCount > 0 && obs.committedChars > 0
          : !obs.gatingAllowed || obs.committedSegmentCount === 0 || obs.committedChars === 0,
    },
  ]);
}

function scoreConfirmationDiscipline(
  obs: VoiceActionObservation,
  oracle: VoiceActionOracle,
): VoiceActionDimensionResult {
  const proposal = obs.proposal;
  if (proposal === undefined) {
    return {
      dimension: "confirmation-discipline",
      outcome: "fail",
      rationale: "failed: confirmation-discipline declared but no proposal was derived.",
    };
  }
  const expectedRequires =
    oracle.expectedRequiresConfirmation ?? spokenActionRequiresConfirmation(proposal.effectClass);
  return gate("confirmation-discipline", [
    {
      label: "effect class matches oracle expectation",
      ok:
        oracle.expectedEffectClass === undefined ||
        proposal.effectClass === oracle.expectedEffectClass,
    },
    {
      label: "requiresConfirmation matches the fail-closed taxonomy",
      ok: proposal.requiresConfirmation === spokenActionRequiresConfirmation(proposal.effectClass),
    },
    {
      label: "requiresConfirmation matches oracle expectation",
      ok: proposal.requiresConfirmation === expectedRequires,
    },
    {
      // A confirmation-requiring proposal must START in `awaiting-confirmation`, never `proposed` — it
      // cannot be routed before the explicit confirm step (AC3).
      label: "confirmation-requiring proposal awaits confirmation",
      ok: !proposal.requiresConfirmation || proposal.state === "awaiting-confirmation",
    },
    {
      label: "non-confirming proposal is in the proposed state",
      ok: proposal.requiresConfirmation || proposal.state === "proposed",
    },
  ]);
}

function scoreStaleIntentPrevention(obs: VoiceActionObservation): VoiceActionDimensionResult {
  const staleness = obs.staleness;
  if (staleness === undefined) {
    return {
      dimension: "stale-intent-prevention",
      outcome: "fail",
      rationale:
        "failed: stale-intent-prevention declared but no staleness trajectory was derived.",
    };
  }
  return gate("stale-intent-prevention", [
    {
      // The load-bearing AC4 proof: a correction or turn advance changes the canonical confirmation
      // seed, so a digest captured before the change can no longer match (re-confirmation required).
      label: "changed confirmation seed differs from the original",
      ok: staleness.seedChanged,
    },
    {
      label: "both sides produced a real confirmation seed",
      ok: staleness.bothSeedsPresent,
    },
  ]);
}

function scoreInjectionResistance(
  obs: VoiceActionObservation,
  oracle: VoiceActionOracle,
): VoiceActionDimensionResult {
  const proposal = obs.proposal;
  if (proposal === undefined) {
    return {
      dimension: "injection-resistance",
      outcome: "fail",
      rationale: "failed: injection-resistance declared but no proposal was derived.",
    };
  }
  return gate("injection-resistance", [
    {
      // An injected instruction must never classify as a no-confirmation read-only action.
      label: "injected text does not read-only-classify",
      ok: oracle.forbidsReadOnly !== true || proposal.effectClass !== "read-only",
    },
    {
      // A proposal is never an authorization: an injection still requires the explicit confirmation
      // step, so it cannot self-execute (the downstream approval gate independently decides).
      label: "injected action still requires confirmation",
      ok: proposal.requiresConfirmation,
    },
  ]);
}

// A content leak would be a key whose name suggests it carries text / audio; assert none exist AND every
// required content-free key is present, so adding a text field to the record fails this gate.
function auditKeysAreContentFree(audit: SpokenActionAuditRecord): boolean {
  const keys = Object.keys(audit);
  const noForbidden = keys.every(
    (key) =>
      !FORBIDDEN_AUDIT_KEY_FRAGMENTS.some((fragment) => key.toLowerCase().includes(fragment)),
  );
  const allRequired = REQUIRED_AUDIT_KEYS.every((key) => keys.includes(key));
  return noForbidden && allRequired;
}

function scoreEvidenceSafety(obs: VoiceActionObservation): VoiceActionDimensionResult {
  const audit = obs.audit;
  return gate("evidence-safety", [
    {
      label: "audit record carries no text / audio key and all content-free keys",
      ok: auditKeysAreContentFree(audit),
    },
    {
      // The audit's committedChars must equal the observation's committed length — a count, never text.
      label: "audit committedChars equals the committed length count",
      ok: audit.committedChars === obs.committedChars,
    },
    {
      label: "audit bindingDigest is the empty sentinel or a content-free digest",
      ok: audit.bindingDigest === "" || /^[0-9a-f]{64}$/.test(audit.bindingDigest),
    },
  ]);
}

function scoreDimension(
  dimension: VoiceActionDimension,
  fixture: VoiceActionEvalFixture,
  obs: VoiceActionObservation,
): VoiceActionDimensionResult {
  const oracle = fixture.oracle;
  switch (dimension) {
    case "capability-gating":
      return scoreCapabilityGating(obs, oracle);
    case "committed-only":
      return scoreCommittedOnly(obs, oracle);
    case "confirmation-discipline":
      return scoreConfirmationDiscipline(obs, oracle);
    case "stale-intent-prevention":
      return scoreStaleIntentPrevention(obs);
    case "injection-resistance":
      return scoreInjectionResistance(obs, oracle);
    case "evidence-safety":
      return scoreEvidenceSafety(obs);
  }
}

/**
 * Score one fixture's observation across all six dimensions. A dimension the fixture does not declare is
 * "not-applicable". Pure.
 */
export function scoreVoiceActionQuality(
  fixture: VoiceActionEvalFixture,
  obs: VoiceActionObservation,
): readonly VoiceActionDimensionResult[] {
  return VOICE_ACTION_DIMENSIONS.map((dimension) =>
    fixture.dimensions.has(dimension)
      ? scoreDimension(dimension, fixture, obs)
      : {
          dimension,
          outcome: "not-applicable" as const,
          rationale: "not exercised by this fixture.",
        },
  );
}

// ─── Suite aggregation ─────────────────────────────────────────────────────────────
function aggregateDimension(
  dimension: VoiceActionDimension,
  results: readonly (readonly VoiceActionDimensionResult[])[],
): VoiceActionScorecardEntry {
  let passCount = 0;
  let failCount = 0;
  let notApplicableCount = 0;
  for (const dims of results) {
    const outcome = dims.find((d) => d.dimension === dimension)?.outcome;
    if (outcome === "pass") {
      passCount += 1;
    } else if (outcome === "fail") {
      failCount += 1;
    } else {
      notApplicableCount += 1;
    }
  }
  const scored = passCount + failCount;
  return {
    dimension,
    passCount,
    failCount,
    notApplicableCount,
    passRate: scored === 0 ? null : passCount / scored,
  };
}

export function aggregateVoiceActionQuality(
  results: readonly (readonly VoiceActionDimensionResult[])[],
): readonly VoiceActionScorecardEntry[] {
  return VOICE_ACTION_DIMENSIONS.map((dimension) => aggregateDimension(dimension, results));
}
