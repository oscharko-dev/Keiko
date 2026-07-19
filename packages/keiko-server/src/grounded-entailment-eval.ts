// Grounded-answer ENTAILMENT (citation-support) eval — Knowledge M1.2 / Issue #2563.
//
// Membership reconciliation (grounded-faithfulness.ts) verifies a citation was in the pack. This
// gate scores the ENTAILMENT stage: does the cited excerpt actually SUPPORT the claim? It exercises
// the REAL segmentation/reconciliation/marker logic (`reconcileClaimEntailment`) over distractor-
// dense fixtures whose excerpts declare the intended verdict inline, judged by a DETERMINISTIC
// scripted judge that implements the same `EntailmentJudge` port as the gateway judge — no network,
// hermetic, no wall-clock dependence.
//
// The gate is non-tautological by construction: a fixed "checker-disabled" probe re-runs the
// unsupported-claim fixtures with a PASS-THROUGH judge (always "supported"). If the score still
// detected those claims, the reconciliation would not depend on the checker — a false moat — so
// `nonTautologyProven` is false and the gate fails. Floors are 1.0 (a correctness invariant): every
// unsupported claim MUST be flagged, no supported claim may be falsely flagged, and the judge's
// `unavailable` verdict MUST degrade to a WARN, never to a silent "supported".

import {
  DEFAULT_ENTAILMENT_OPTIONS,
  buildPackCitationIndex,
  buildPackExcerptTextResolver,
  reconcileClaimEntailment,
  reconcileInlineCitations,
  type EntailmentJudge,
  type EntailmentReconciliation,
  type EntailmentVerdict,
} from "./grounded-faithfulness.js";
import { buildEvalContextPack, evalFileEntry } from "./grounded-eval-support.js";
import type {
  ConnectedContextPack,
  EvalBudget,
  EvalFloorResult,
  LineRange,
} from "@oscharko-dev/keiko-contracts";

type EntailmentVariant = "supported" | "unsupported-claim" | "unavailable";

interface FixtureExcerpt {
  readonly lineRange: LineRange;
  readonly content: string;
}

interface EntailmentFixture {
  readonly name: string;
  readonly variant: EntailmentVariant;
  readonly answerText: string;
  // Per cited path: the in-pack excerpt window + content. The content declares the verdict inline
  // ([[CONTRADICT]] / [[UNAVAIL]] / neither ⇒ supported) so the scripted judge is trivial and the
  // gate scores the segmentation/reconciliation, not the judge.
  readonly excerpts: Readonly<Record<string, FixtureExcerpt>>;
}

// Distractor-dense shared evidence: every fixture cites into a pack that also holds unrelated,
// supported evidence, so an unsupported claim is a genuine content mismatch, not a trivially-absent
// citation. Connector-pod paths (Confluence/Jira, Epic #2238) sit alongside repository evidence so
// entailment is gated over synced connector content too.
const SUPPORTING = "The retention period is 30 days for audit logs.";
const CONTRADICTING = "The retention period is 30 days. [[CONTRADICT]]";
const UNJUDGEABLE = "[[UNAVAIL]]";

const FIXTURES: readonly EntailmentFixture[] = [
  {
    name: "supported-single",
    variant: "supported",
    answerText: "Audit logs are retained for 30 days [src/policy/retention.ts:1-8].",
    excerpts: {
      "src/policy/retention.ts": { lineRange: { startLine: 1, endLine: 8 }, content: SUPPORTING },
    },
  },
  {
    name: "supported-multi",
    variant: "supported",
    answerText:
      "Retention is 30 days [src/policy/retention.ts:1-8] and the wiki agrees [confluence/ENG/pages/98311.html:2-6].",
    excerpts: {
      "src/policy/retention.ts": { lineRange: { startLine: 1, endLine: 8 }, content: SUPPORTING },
      "confluence/ENG/pages/98311.html": {
        lineRange: { startLine: 2, endLine: 6 },
        content: SUPPORTING,
      },
    },
  },
  {
    name: "unsupported-claim-contradiction",
    variant: "unsupported-claim",
    answerText: "The retention period is ten years [src/policy/retention.ts:1-8].",
    excerpts: {
      "src/policy/retention.ts": {
        lineRange: { startLine: 1, endLine: 8 },
        content: CONTRADICTING,
      },
    },
  },
  {
    name: "unsupported-claim-connector",
    variant: "unsupported-claim",
    answerText: "The rollback deletes all tenants [jira/PLAT/issues/10002.html:2-6].",
    excerpts: {
      "jira/PLAT/issues/10002.html": {
        lineRange: { startLine: 2, endLine: 6 },
        content: CONTRADICTING,
      },
    },
  },
  {
    name: "unsupported-claim-amid-supported",
    variant: "unsupported-claim",
    answerText:
      "Logs are kept 30 days [src/policy/retention.ts:1-8]. Backups run hourly [ops/backup.md:3-9].",
    excerpts: {
      "src/policy/retention.ts": { lineRange: { startLine: 1, endLine: 8 }, content: SUPPORTING },
      "ops/backup.md": { lineRange: { startLine: 3, endLine: 9 }, content: CONTRADICTING },
    },
  },
  {
    name: "unavailable-degradation",
    variant: "unavailable",
    answerText: "The encryption uses AES-256 [src/crypto/cipher.ts:10-20].",
    excerpts: {
      "src/crypto/cipher.ts": { lineRange: { startLine: 10, endLine: 20 }, content: UNJUDGEABLE },
    },
  },
];

function verdictFromToken(excerptText: string): EntailmentVerdict {
  if (excerptText.includes("[[UNAVAIL]]")) return "unavailable";
  if (excerptText.includes("[[CONTRADICT]]")) return "unsupported";
  return "supported";
}

// The scripted judge for the gate: reads the verdict the fixture excerpt declares. Same port the
// gateway judge implements; deterministic and offline.
const TOKEN_JUDGE: EntailmentJudge = {
  judge: (input): Promise<EntailmentVerdict> =>
    Promise.resolve(verdictFromToken(input.excerptText)),
};

// The non-tautology probe: ignores the excerpt and always answers "supported". If the reconciliation
// still flags an unsupported fixture with this judge, the score does not depend on the checker.
const PASS_THROUGH_JUDGE: EntailmentJudge = {
  judge: (): Promise<EntailmentVerdict> => Promise.resolve("supported"),
};

function packFor(fixture: EntailmentFixture): ConnectedContextPack {
  return buildEvalContextPack(
    Object.entries(fixture.excerpts).map(([scopePath, excerpt]) =>
      evalFileEntry(scopePath, [{ content: excerpt.content, lineRange: excerpt.lineRange }]),
    ),
  );
}

async function evaluateFixture(
  fixture: EntailmentFixture,
  judge: EntailmentJudge,
): Promise<EntailmentReconciliation> {
  const packs = [packFor(fixture)];
  const membership = reconcileInlineCitations(fixture.answerText, buildPackCitationIndex(packs));
  const resolveExcerptText = buildPackExcerptTextResolver(packs);
  return reconcileClaimEntailment(
    fixture.answerText,
    membership,
    resolveExcerptText,
    judge,
    DEFAULT_ENTAILMENT_OPTIONS,
  );
}

export interface GroundedEntailmentScorecard {
  readonly fixtures: number;
  // Of the unsupported-claim fixtures, the fraction where the unsupported claim was flagged.
  readonly unsupportedClaimDetectionRate: number;
  // Of the supported fixtures, the fraction with NO false-positive unsupported-claim flag.
  readonly claimPrecision: number;
  // Of the unavailable fixtures, the fraction that degrade to WARN (unavailable counted, none flagged).
  readonly degradationCorrectnessRate: number;
  // True when a pass-through judge fails to detect ANY unsupported fixture (the checker is load-bearing).
  readonly nonTautologyProven: boolean;
  readonly failures: readonly string[];
}

function rate(hits: number, total: number): number {
  return total === 0 ? 1 : hits / total;
}

async function scoreDetection(
  fixtures: readonly EntailmentFixture[],
  failures: string[],
): Promise<number> {
  let detected = 0;
  for (const fixture of fixtures) {
    const result = await evaluateFixture(fixture, TOKEN_JUDGE);
    if (result.unentailed.length > 0) detected += 1;
    else failures.push(`missed unsupported claim in '${fixture.name}'`);
  }
  return rate(detected, fixtures.length);
}

async function scorePrecision(
  fixtures: readonly EntailmentFixture[],
  failures: string[],
): Promise<number> {
  let clean = 0;
  for (const fixture of fixtures) {
    const result = await evaluateFixture(fixture, TOKEN_JUDGE);
    if (result.unentailed.length === 0) clean += 1;
    else failures.push(`false-positive unsupported-claim flag in '${fixture.name}'`);
  }
  return rate(clean, fixtures.length);
}

async function scoreDegradation(
  fixtures: readonly EntailmentFixture[],
  failures: string[],
): Promise<number> {
  let degraded = 0;
  for (const fixture of fixtures) {
    const result = await evaluateFixture(fixture, TOKEN_JUDGE);
    if (result.unavailableClaims > 0 && result.unentailed.length === 0) degraded += 1;
    else failures.push(`degradation fixture '${fixture.name}' did not fail closed to WARN`);
  }
  return rate(degraded, fixtures.length);
}

async function proveNonTautology(
  unsupported: readonly EntailmentFixture[],
  failures: string[],
): Promise<boolean> {
  let leaks = 0;
  for (const fixture of unsupported) {
    const result = await evaluateFixture(fixture, PASS_THROUGH_JUDGE);
    if (result.unentailed.length > 0) leaks += 1;
  }
  const proven = unsupported.length > 0 && leaks === 0;
  if (!proven) failures.push("non-tautology probe: a pass-through judge still flagged claims");
  return proven;
}

export async function runGroundedEntailmentEval(): Promise<GroundedEntailmentScorecard> {
  const failures: string[] = [];
  const supported = FIXTURES.filter((f) => f.variant === "supported");
  const unsupported = FIXTURES.filter((f) => f.variant === "unsupported-claim");
  const unavailable = FIXTURES.filter((f) => f.variant === "unavailable");
  const unsupportedClaimDetectionRate = await scoreDetection(unsupported, failures);
  const claimPrecision = await scorePrecision(supported, failures);
  const degradationCorrectnessRate = await scoreDegradation(unavailable, failures);
  const nonTautologyProven = await proveNonTautology(unsupported, failures);
  return {
    fixtures: FIXTURES.length,
    unsupportedClaimDetectionRate,
    claimPrecision,
    degradationCorrectnessRate,
    nonTautologyProven,
    failures,
  };
}

type GroundedEntailmentBudgetMetric =
  "minUnsupportedClaimDetectionRate" | "minClaimPrecision" | "minDegradationCorrectnessRate";

export type GroundedEntailmentBudget = EvalBudget<GroundedEntailmentBudgetMetric> & {
  readonly requireNonTautology: boolean;
};

// Entailment is a correctness invariant like faithfulness: an unsupported claim must ALWAYS be
// flagged, a supported claim must NEVER be, and an undecidable claim must ALWAYS degrade to WARN.
export const DEFAULT_GROUNDED_ENTAILMENT_BUDGET: GroundedEntailmentBudget = {
  minUnsupportedClaimDetectionRate: 1,
  minClaimPrecision: 1,
  minDegradationCorrectnessRate: 1,
  requireNonTautology: true,
};

export function evaluateGroundedEntailmentBudget(
  scorecard: GroundedEntailmentScorecard,
  budget: GroundedEntailmentBudget = DEFAULT_GROUNDED_ENTAILMENT_BUDGET,
): EvalFloorResult {
  const failures = [...scorecard.failures];
  if (scorecard.unsupportedClaimDetectionRate < budget.minUnsupportedClaimDetectionRate)
    failures.push("unsupportedClaimDetectionRate");
  if (scorecard.claimPrecision < budget.minClaimPrecision) failures.push("claimPrecision");
  if (scorecard.degradationCorrectnessRate < budget.minDegradationCorrectnessRate)
    failures.push("degradationCorrectnessRate");
  if (budget.requireNonTautology && !scorecard.nonTautologyProven)
    failures.push("nonTautologyProven");
  return { ok: failures.length === 0, failures };
}
