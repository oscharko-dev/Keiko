// Grounded-answer faithfulness + citation-support eval (RB-4, GEN-AI-EVAL-003 / GEN-AI-GROUNDING-001
// / GEN-AI-GROUNDING-008 / GEN-TEST-MISSING-010).
//
// The estate had ZERO citation-faithfulness coverage: every citation test asserted pack→wire
// projection, so an answer citing evidence it never received (or answering confidently over empty
// evidence) was invisible. This harness scores the REAL reconciliation/abstention logic
// (grounded-faithfulness.ts) over scripted answerer variants — faithful, hallucinated-citation,
// confident-over-empty, refusal — with non-tautological floors, so a regression that stops flagging
// fabricated citations (or stops abstaining on empty evidence) turns the gate red.

import {
  buildPackCitationIndex,
  classifyGroundedAnswerKind,
  missingCitationMarker,
  missingCitationMarkerFor,
  packHasUsableEvidence,
  reconcileInlineCitations,
  type PackCitationIndex,
} from "./grounded-faithfulness.js";
import {
  connectedSearchNoEvidenceAnswer,
  isCanonicalConnectedSearchAbstention,
} from "@oscharko-dev/keiko-contracts/runtime/no-evidence-answer";
import { buildEvalContextPack, evalFileEntry, evalUncertainty } from "./grounded-eval-support.js";
import type {
  ConnectedContextPack,
  EvalBudget,
  EvalFloorResult,
  LineRange,
} from "@oscharko-dev/keiko-contracts";

import type { GroundedAnswerKind } from "@oscharko-dev/keiko-contracts/bff-wire";

type FaithfulnessVariant =
  "faithful" | "hallucinated-citation" | "confident-over-empty" | "refusal";

interface FaithfulnessFixture {
  readonly name: string;
  readonly variant: FaithfulnessVariant;
  // Evidence paths present in the pack that reached the model. Empty ⇒ no usable evidence.
  readonly packScopePaths: readonly string[];
  // Per-path excerpt windows (optional) for line-range validation.
  readonly packLineWindows?: Readonly<Record<string, readonly LineRange[]>>;
  readonly answerText: string;
  readonly expectedUnsupportedCitations: readonly string[];
}

// Distractor-dense: every fixture shares the same non-empty evidence pack (except the empty-evidence
// case), so a hallucinated citation is a genuine out-of-pack reference, not a trivially-absent one.
// The pack includes connector-pod document references (Epic #2238, Issues #2242/#2243) so citation
// reconciliation over synced Confluence AND Jira content is gated alongside repository evidence.
const CONNECTOR_PAGE_PATH = "confluence/ENG/pages/98311.html";
const CONNECTOR_ISSUE_PATH = "jira/PLAT/issues/10002.html";
const PACK_PATHS = [
  "src/auth/login.ts",
  "src/http/routes.ts",
  "src/config/env.ts",
  CONNECTOR_PAGE_PATH,
  CONNECTOR_ISSUE_PATH,
];
const DEFAULT_PACK_LINE_WINDOWS: readonly LineRange[] = [{ startLine: 1, endLine: 100 }];
const NO_UNSUPPORTED_CITATIONS: readonly string[] = [];

const FIXTURES: readonly FaithfulnessFixture[] = [
  {
    name: "faithful-single",
    variant: "faithful",
    packScopePaths: PACK_PATHS,
    answerText: "Login validates the session in [src/auth/login.ts:10-20].",
    expectedUnsupportedCitations: NO_UNSUPPORTED_CITATIONS,
  },
  {
    name: "faithful-multi",
    variant: "faithful",
    packScopePaths: PACK_PATHS,
    answerText:
      "The route is registered in [src/http/routes.ts:5-9] and reads config from [src/config/env.ts].",
    expectedUnsupportedCitations: NO_UNSUPPORTED_CITATIONS,
  },
  {
    name: "faithful-no-citations",
    variant: "faithful",
    packScopePaths: PACK_PATHS,
    answerText: "The service authenticates users and dispatches HTTP routes.",
    expectedUnsupportedCitations: NO_UNSUPPORTED_CITATIONS,
  },
  {
    name: "hallucinated-path",
    variant: "hallucinated-citation",
    packScopePaths: PACK_PATHS,
    answerText:
      "Login validates in [src/auth/login.ts:10-20] and reads secrets from [src/secret/keys.ts:40-55].",
    expectedUnsupportedCitations: ["src/secret/keys.ts:40-55"],
  },
  {
    name: "hallucinated-bare-path",
    variant: "hallucinated-citation",
    packScopePaths: PACK_PATHS,
    answerText: "See src/secret/keys.ts:40-55.",
    expectedUnsupportedCitations: ["src/secret/keys.ts:40-55"],
  },
  {
    name: "hallucinated-code-path",
    variant: "hallucinated-citation",
    packScopePaths: PACK_PATHS,
    answerText: "See `src/secret/keys.ts:40-55`.",
    expectedUnsupportedCitations: ["src/secret/keys.ts:40-55"],
  },
  {
    name: "hallucinated-table-path",
    variant: "hallucinated-citation",
    packScopePaths: PACK_PATHS,
    answerText: "| Source | src/secret/keys.ts:40-55 |",
    expectedUnsupportedCitations: ["src/secret/keys.ts:40-55"],
  },
  {
    name: "hallucinated-only",
    variant: "hallucinated-citation",
    packScopePaths: PACK_PATHS,
    answerText: "The token is signed in [src/crypto/never-retrieved.ts:1-3].",
    expectedUnsupportedCitations: ["src/crypto/never-retrieved.ts:1-3"],
  },
  {
    name: "hallucinated-line-out-of-window",
    variant: "hallucinated-citation",
    packScopePaths: PACK_PATHS,
    packLineWindows: { "src/auth/login.ts": [{ startLine: 1, endLine: 30 }] },
    answerText: "See [src/auth/login.ts:900-950] for the handler.",
    expectedUnsupportedCitations: ["src/auth/login.ts:900-950"],
  },
  {
    name: "faithful-connector-page",
    variant: "faithful",
    packScopePaths: PACK_PATHS,
    answerText: `The restart procedure is documented in [${CONNECTOR_PAGE_PATH}:3-9].`,
    expectedUnsupportedCitations: NO_UNSUPPORTED_CITATIONS,
  },
  {
    name: "hallucinated-connector-page",
    variant: "hallucinated-citation",
    packScopePaths: PACK_PATHS,
    answerText:
      "The rollback steps are documented in [confluence/ENG/pages/424242.html:1-12] of the wiki.",
    expectedUnsupportedCitations: ["confluence/ENG/pages/424242.html:1-12"],
  },
  {
    name: "faithful-connector-issue",
    variant: "faithful",
    packScopePaths: PACK_PATHS,
    answerText: `PLAT-2 tracks the login regression; see [${CONNECTOR_ISSUE_PATH}:2-6].`,
    expectedUnsupportedCitations: NO_UNSUPPORTED_CITATIONS,
  },
  {
    name: "hallucinated-connector-issue",
    variant: "hallucinated-citation",
    packScopePaths: PACK_PATHS,
    answerText: "The estimate is recorded on [jira/PLAT/issues/424242.html:1-4] in the tracker.",
    expectedUnsupportedCitations: ["jira/PLAT/issues/424242.html:1-4"],
  },
  {
    name: "confident-over-empty",
    variant: "confident-over-empty",
    packScopePaths: [],
    answerText: "The system uses OAuth2 with PKCE and rotates refresh tokens every 24 hours.",
    expectedUnsupportedCitations: NO_UNSUPPORTED_CITATIONS,
  },
  {
    name: "refusal-on-empty-en",
    variant: "refusal",
    packScopePaths: [],
    answerText: connectedSearchNoEvidenceAnswer("What evidence exists?"),
    expectedUnsupportedCitations: NO_UNSUPPORTED_CITATIONS,
  },
  {
    name: "refusal-on-empty-de",
    variant: "refusal",
    packScopePaths: [],
    answerText: connectedSearchNoEvidenceAnswer("Welche Belege gibt es?"),
    expectedUnsupportedCitations: NO_UNSUPPORTED_CITATIONS,
  },
];

interface AnswerKindFixture {
  readonly name: string;
  readonly text: string;
  readonly kind: GroundedAnswerKind;
  readonly warns: boolean;
}

const ANSWER_KIND_FIXTURES: readonly AnswerKindFixture[] = [
  { name: "substantive", text: "The route validates sessions.", kind: "answer", warns: true },
  {
    name: "clarification-en",
    text: "Which version do you mean?",
    kind: "clarification",
    warns: false,
  },
  {
    name: "clarification-de",
    text: "Welche Version meinst du?",
    kind: "clarification",
    warns: false,
  },
  {
    name: "insufficiency",
    text: "Missing evidence: [src/auth/login.ts]",
    kind: "insufficiency",
    warns: false,
  },
  {
    name: "refusal",
    text: connectedSearchNoEvidenceAnswer("What evidence exists?"),
    kind: "refusal",
    warns: false,
  },
  {
    name: "mixed-claim",
    text: "The route validates sessions. Which version do you mean?",
    kind: "answer",
    warns: true,
  },
];

export type GroundedFaithfulnessEvalVariant = "baseline" | "treat-clarification-as-answer";

function answerKindScores(variant: GroundedFaithfulnessEvalVariant): {
  readonly answerKindAccuracy: number;
  readonly missingCitationAccuracy: number;
  readonly failures: readonly string[];
} {
  let kinds = 0;
  let warnings = 0;
  const failures: string[] = [];
  for (const fixture of ANSWER_KIND_FIXTURES) {
    const actualKind = classifyGroundedAnswerKind(fixture.text);
    const mutated = variant === "treat-clarification-as-answer" && actualKind === "clarification";
    const kind = mutated ? "answer" : actualKind;
    const marker = mutated ? missingCitationMarker(1) : missingCitationMarkerFor(fixture.text, 1);
    if (kind === fixture.kind) kinds += 1;
    else failures.push(`answer-kind mismatch in '${fixture.name}'`);
    if ((marker !== undefined) === fixture.warns) warnings += 1;
    else failures.push(`citation-warning mismatch in '${fixture.name}'`);
  }
  return {
    answerKindAccuracy: rate(kinds, ANSWER_KIND_FIXTURES.length),
    missingCitationAccuracy: rate(warnings, ANSWER_KIND_FIXTURES.length),
    failures,
  };
}

function indexFor(fixture: FaithfulnessFixture): PackCitationIndex {
  return buildPackCitationIndex([packFor(fixture)]);
}

// A minimal pack carrying exactly the fixture's evidence, so packHasUsableEvidence reflects the
// real abstention predicate rather than a hand-set boolean.
function packFor(fixture: FaithfulnessFixture): ConnectedContextPack {
  return buildEvalContextPack(
    fixture.packScopePaths.map((scopePath) =>
      evalFileEntry(
        scopePath,
        (fixture.packLineWindows?.[scopePath] ?? DEFAULT_PACK_LINE_WINDOWS).map((lineRange) => ({
          content: "eval evidence",
          lineRange,
        })),
      ),
    ),
    fixture.packScopePaths.length === 0 ? [evalUncertainty("no-evidence")] : [],
  );
}

export interface GroundedFaithfulnessScorecard {
  readonly fixtures: number;
  // Of the hallucinated fixtures, the fraction where the fabricated citation was detected.
  readonly unsupportedDetectionRate: number;
  // Of the faithful fixtures, the fraction with NO false-positive unsupported flag.
  readonly citationPrecision: number;
  // Of the empty-evidence fixtures, the fraction whose answer text is correctly classified:
  // the canonical refusal abstains, while a confident answer is detected as a bad output.
  readonly abstentionOnEmptyRate: number;
  readonly answerKindAccuracy: number;
  readonly missingCitationAccuracy: number;
  readonly failures: readonly string[];
}

function rate(hits: number, total: number): number {
  return total === 0 ? 1 : hits / total;
}

function citationsMatchExpected(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

export function isGroundedEmptyEvidenceAbstention(
  pack: ConnectedContextPack,
  answerText: string,
): boolean {
  return !packHasUsableEvidence(pack) && isCanonicalConnectedSearchAbstention(answerText);
}

function emptyEvidenceVariantMatched(fixture: FaithfulnessFixture): boolean {
  const abstained = isGroundedEmptyEvidenceAbstention(packFor(fixture), fixture.answerText);
  return abstained === (fixture.variant === "refusal");
}

function unsupportedCitationsMatch(fixture: FaithfulnessFixture): boolean {
  const result = reconcileInlineCitations(fixture.answerText, indexFor(fixture));
  return citationsMatchExpected(
    result.unsupported.map((citation) => citation.raw),
    fixture.expectedUnsupportedCitations,
  );
}

function noUnsupportedCitations(fixture: FaithfulnessFixture): boolean {
  return reconcileInlineCitations(fixture.answerText, indexFor(fixture)).unsupported.length === 0;
}

function fixtureScore(
  fixtures: readonly FaithfulnessFixture[],
  predicate: (fixture: FaithfulnessFixture) => boolean,
  message: string,
  failures: string[],
): number {
  let hits = 0;
  for (const fixture of fixtures) {
    if (predicate(fixture)) hits += 1;
    else failures.push(`${message} in '${fixture.name}'`);
  }
  return rate(hits, fixtures.length);
}

export function runGroundedFaithfulnessEval(
  variant: GroundedFaithfulnessEvalVariant = "baseline",
): GroundedFaithfulnessScorecard {
  const kindScores = answerKindScores(variant);
  const failures: string[] = [...kindScores.failures];
  return {
    fixtures: FIXTURES.length + ANSWER_KIND_FIXTURES.length,
    answerKindAccuracy: kindScores.answerKindAccuracy,
    missingCitationAccuracy: kindScores.missingCitationAccuracy,
    unsupportedDetectionRate: fixtureScore(
      FIXTURES.filter((f) => f.variant === "hallucinated-citation"),
      unsupportedCitationsMatch,
      "citation reconciliation mismatch",
      failures,
    ),
    citationPrecision: fixtureScore(
      FIXTURES.filter((f) => f.variant === "faithful"),
      noUnsupportedCitations,
      "false-positive unsupported flag",
      failures,
    ),
    abstentionOnEmptyRate: fixtureScore(
      FIXTURES.filter((f) => f.variant === "confident-over-empty" || f.variant === "refusal"),
      emptyEvidenceVariantMatched,
      "empty-evidence answer mismatch",
      failures,
    ),
    failures,
  };
}

type GroundedFaithfulnessBudgetMetric =
  | "minUnsupportedDetectionRate"
  | "minCitationPrecision"
  | "minAbstentionOnEmptyRate"
  | "minAnswerKindAccuracy"
  | "minMissingCitationAccuracy";

export type GroundedFaithfulnessBudget = EvalBudget<GroundedFaithfulnessBudgetMetric>;

// Faithfulness is a correctness invariant: fabricated citations must ALWAYS be flagged and empty
// evidence must ALWAYS abstain (rates = 1). Citation precision is gated < 1 tolerance is NOT allowed
// here — a false positive would strip a real citation — but the metric being < 1 is a real failure.
export const DEFAULT_GROUNDED_FAITHFULNESS_BUDGET: GroundedFaithfulnessBudget = {
  minUnsupportedDetectionRate: 1,
  minCitationPrecision: 1,
  minAbstentionOnEmptyRate: 1,
  minAnswerKindAccuracy: 1,
  minMissingCitationAccuracy: 1,
};

function missesFiniteFloor(value: number, floor: number): boolean {
  return !Number.isFinite(value) || !Number.isFinite(floor) || value < floor;
}

export function evaluateGroundedFaithfulnessBudget(
  scorecard: GroundedFaithfulnessScorecard,
  budget: GroundedFaithfulnessBudget = DEFAULT_GROUNDED_FAITHFULNESS_BUDGET,
): EvalFloorResult {
  const failures = [...scorecard.failures];
  const checks = [
    [
      "unsupportedDetectionRate",
      scorecard.unsupportedDetectionRate,
      budget.minUnsupportedDetectionRate,
    ],
    ["citationPrecision", scorecard.citationPrecision, budget.minCitationPrecision],
    ["abstentionOnEmptyRate", scorecard.abstentionOnEmptyRate, budget.minAbstentionOnEmptyRate],
    ["answerKindAccuracy", scorecard.answerKindAccuracy, budget.minAnswerKindAccuracy],
    [
      "missingCitationAccuracy",
      scorecard.missingCitationAccuracy,
      budget.minMissingCitationAccuracy,
    ],
  ] as const;
  for (const [name, value, floor] of checks) {
    if (missesFiniteFloor(value, floor)) failures.push(name);
  }
  return { ok: failures.length === 0, failures };
}
