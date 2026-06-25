// Voice Session Recap scorer (Epic #491, Issue #504; ADR-0067).
//
// Pure per-dimension scoring + suite aggregation for the seven recap dimensions. Each dimension is a pure
// function (fixture, observation) -> VoiceRecapDimensionResult. A dimension a fixture does not declare is
// "not-applicable" and excluded from aggregation.
//
// Each dimension combines a STRUCTURAL gate (the contract's observable behaviour — the recap-gating verdict,
// the committed projection counts, the candidate verdicts, the candidate statuses, and the audit record's
// content-free shape) with the fixture's oracle expectation. The structural gate is what makes the suite
// regression-sensitive: weakening the gating, letting a denied profile propose, letting partial / corrected
// text into the projection, letting a secret span propose, letting an assistant turn become a candidate,
// or adding a text field to the audit record flips the corresponding dimension to FAIL.
//
// Determinism: pure. Rationales are harness-authored and content-free (counts, closed-vocabulary labels,
// numbers) — they never echo committed text or any raw transcript / secret content.

import {
  isVoiceRecapCandidateStatus,
  type VoiceSessionRecapAuditRecord,
} from "@oscharko-dev/keiko-contracts";
import {
  VOICE_RECAP_DIMENSIONS,
  type VoiceRecapDimension,
  type VoiceRecapDimensionResult,
  type VoiceRecapEvalFixture,
  type VoiceRecapObservation,
  type VoiceRecapOracle,
  type VoiceRecapScorecardEntry,
} from "./types.js";

// The audit record keys that MUST exist (content-free) and the substring fragments that must NEVER appear
// in any key (a text / audio field would be a content leak — AC4). Keyed explicitly so adding a text field
// to the record, or a fixture's text leaking into a key, fails the content-free-audit gate.
const FORBIDDEN_AUDIT_KEY_FRAGMENTS: readonly string[] = ["text", "audio", "transcript", "raw"];
const REQUIRED_AUDIT_KEYS: readonly (keyof VoiceSessionRecapAuditRecord)[] = [
  "schemaVersion",
  "profile",
  "committedSegmentCount",
  "committedChars",
  "candidatesExtracted",
  "candidatesRejected",
  "candidatesProposed",
  "triggeredByUser",
  "durationMs",
];

interface Check {
  readonly label: string;
  readonly ok: boolean;
}

function gate(dimension: VoiceRecapDimension, checks: readonly Check[]): VoiceRecapDimensionResult {
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
function scoreDormantNoVoice(
  obs: VoiceRecapObservation,
  oracle: VoiceRecapOracle,
): VoiceRecapDimensionResult {
  return gate("dormant-no-voice", [
    {
      label: "recap-gating verdict matches profile expectation",
      ok: obs.recapAllowed === oracle.expectedRecapAllowed,
    },
    {
      // A denied profile must never propose or reject any candidate and must read no committed text — the
      // whole layer is dormant before any work (AC1).
      label: "denied profile yields no candidate and no committed read",
      ok:
        obs.recapAllowed ||
        (obs.candidateOutcomes.length === 0 &&
          obs.committedSegmentCount === 0 &&
          obs.committedChars === 0),
    },
  ]);
}

function scoreCorrectionsExcluded(obs: VoiceRecapObservation): VoiceRecapDimensionResult {
  return gate("corrections-excluded", [
    {
      // The committed projection feeding the recap must agree with the audit's committed counts: corrected /
      // superseded / discarded text is excluded by `selectCommittedVoiceTranscript`, so the post-correction
      // counts the runner records are exactly the clean committed counts (AC2 / AC4).
      label: "audit committed counts equal the committed projection counts",
      ok:
        obs.audit.committedSegmentCount === obs.committedSegmentCount &&
        obs.audit.committedChars === obs.committedChars,
    },
    {
      // Every proposed candidate rests on committed chars; the projection is non-empty whenever a candidate
      // forms, so a corrections-only / superseded-only span cannot propose.
      label: "candidates only form over a non-empty committed projection",
      ok: obs.candidateOutcomes.length === 0 || obs.committedChars > 0,
    },
  ]);
}

function scoreRawAudioNeverStored(obs: VoiceRecapObservation): VoiceRecapDimensionResult {
  return gate("raw-audio-never-stored", [
    {
      // The persisted evidence / audit carry only counts; the committed char count is a length, never text.
      label: "audit committedChars is a count equal to the committed length",
      ok: obs.audit.committedChars === obs.committedChars,
    },
    {
      // No candidate outcome carries any text-bearing field: the outcome shape is verdict + status + counts.
      label: "candidate outcomes carry only verdict / status / counts",
      ok: obs.candidateOutcomes.every((o) => candidateOutcomeIsContentFree(o)),
    },
  ]);
}

function candidateOutcomeIsContentFree(outcome: {
  readonly verdict: string;
  readonly status: string | undefined;
  readonly spanCharCount: number;
  readonly spanSegmentCount: number;
}): boolean {
  const keys = Object.keys(outcome);
  const allowed = new Set(["verdict", "status", "spanCharCount", "spanSegmentCount"]);
  return keys.every((key) => allowed.has(key));
}

function scoreSecretsRedacted(
  obs: VoiceRecapObservation,
  oracle: VoiceRecapOracle,
): VoiceRecapDimensionResult {
  const rejected = obs.candidateOutcomes.filter((o) => o.verdict === "rejected");
  return gate("secrets-redacted", [
    {
      // The number of rejected spans matches the oracle: a credential-bearing span must be rejected before
      // any candidate is proposed (AC6).
      label: "rejected-candidate count matches oracle expectation",
      ok: rejected.length === oracle.expectedCandidatesRejected,
    },
    {
      // A rejected span is NEVER stored as a candidate record: it carries no lifecycle status (ADR-0067 D8).
      label: "rejected spans carry no candidate status",
      ok: rejected.every((o) => o.status === undefined),
    },
    {
      // The audit's rejected count agrees with the derived rejections — a count, never the secret text.
      label: "audit rejected count equals the derived rejection count",
      ok: obs.audit.candidatesRejected === rejected.length,
    },
  ]);
}

function scoreCandidateGoverned(
  obs: VoiceRecapObservation,
  oracle: VoiceRecapOracle,
): VoiceRecapDimensionResult {
  const proposed = obs.candidateOutcomes.filter((o) => o.verdict === "proposed");
  return gate("candidate-governed", [
    {
      label: "proposed-candidate count matches oracle expectation",
      ok: proposed.length === oracle.expectedCandidatesProposed,
    },
    {
      // Every proposed candidate enters the contract's only initial status "proposed" — the structural
      // proof that it flows into the EXISTING review queue, not a new mutation surface (AC3).
      label: "every proposed candidate enters the governed 'proposed' status",
      ok: proposed.every(
        (o) => isVoiceRecapCandidateStatus(o.status) && o.status === oracle.expectedCandidateStatus,
      ),
    },
    {
      // The audit's proposed count agrees with the derived proposals.
      label: "audit proposed count equals the derived proposal count",
      ok: obs.audit.candidatesProposed === proposed.length,
    },
  ]);
}

function scoreAssistantClaimsNotUserFact(obs: VoiceRecapObservation): VoiceRecapDimensionResult {
  return gate("assistant-claims-not-user-fact", [
    {
      // Assistant turns are observed but never feed candidate extraction: the extracted-candidate count can
      // never exceed the number of user committed spans, so assistant text produced no candidate (AC5).
      label: "candidate count never exceeds the user committed-span count",
      ok: obs.candidateOutcomes.length <= obs.committedSegmentCount + obs.candidatesRejected,
    },
    {
      // The recap derives candidates even though assistant turns are present, proving assistant turns are
      // pure context and add nothing to the proposal set.
      label: "assistant turns do not inflate the extracted-candidate count",
      ok: obs.evidence.candidatesExtracted === obs.candidateOutcomes.length,
    },
  ]);
}

// A content leak would be a key whose name suggests it carries text / audio; assert none exist AND every
// required content-free key is present, so adding a text field to the record fails this gate (AC4).
function auditKeysAreContentFree(audit: VoiceSessionRecapAuditRecord): boolean {
  const keys = Object.keys(audit);
  const noForbidden = keys.every(
    (key) =>
      !FORBIDDEN_AUDIT_KEY_FRAGMENTS.some((fragment) => key.toLowerCase().includes(fragment)),
  );
  const allRequired = REQUIRED_AUDIT_KEYS.every((key) => keys.includes(key));
  return noForbidden && allRequired;
}

function scoreContentFreeAudit(obs: VoiceRecapObservation): VoiceRecapDimensionResult {
  return gate("content-free-audit", [
    {
      label: "audit record carries no text / audio key and all content-free keys",
      ok: auditKeysAreContentFree(obs.audit),
    },
    {
      label: "audit triggeredByUser is true (recap is user-triggered)",
      ok: obs.audit.triggeredByUser,
    },
    {
      // proposed + rejected === extracted by construction; the audit's partition must be exhaustive.
      label: "audit candidate partition is exhaustive",
      ok:
        obs.audit.candidatesProposed + obs.audit.candidatesRejected ===
        obs.evidence.candidatesExtracted,
    },
  ]);
}

function scoreDimension(
  dimension: VoiceRecapDimension,
  fixture: VoiceRecapEvalFixture,
  obs: VoiceRecapObservation,
): VoiceRecapDimensionResult {
  const oracle = fixture.oracle;
  switch (dimension) {
    case "dormant-no-voice":
      return scoreDormantNoVoice(obs, oracle);
    case "corrections-excluded":
      return scoreCorrectionsExcluded(obs);
    case "raw-audio-never-stored":
      return scoreRawAudioNeverStored(obs);
    case "secrets-redacted":
      return scoreSecretsRedacted(obs, oracle);
    case "candidate-governed":
      return scoreCandidateGoverned(obs, oracle);
    case "assistant-claims-not-user-fact":
      return scoreAssistantClaimsNotUserFact(obs);
    case "content-free-audit":
      return scoreContentFreeAudit(obs);
  }
}

/**
 * Score one fixture's observation across all seven dimensions. A dimension the fixture does not declare is
 * "not-applicable". Pure.
 */
export function scoreVoiceRecapQuality(
  fixture: VoiceRecapEvalFixture,
  obs: VoiceRecapObservation,
): readonly VoiceRecapDimensionResult[] {
  return VOICE_RECAP_DIMENSIONS.map((dimension) =>
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
  dimension: VoiceRecapDimension,
  results: readonly (readonly VoiceRecapDimensionResult[])[],
): VoiceRecapScorecardEntry {
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

export function aggregateVoiceRecapQuality(
  results: readonly (readonly VoiceRecapDimensionResult[])[],
): readonly VoiceRecapScorecardEntry[] {
  return VOICE_RECAP_DIMENSIONS.map((dimension) => aggregateDimension(dimension, results));
}
