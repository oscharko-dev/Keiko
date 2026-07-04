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
  packHasUsableEvidence,
  reconcileInlineCitations,
  type PackCitationIndex,
} from "./grounded-faithfulness.js";
import type { ConnectedContextPack, LineRange } from "@oscharko-dev/keiko-contracts";

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
}

// Distractor-dense: every fixture shares the same non-empty evidence pack (except the empty-evidence
// case), so a hallucinated citation is a genuine out-of-pack reference, not a trivially-absent one.
const PACK_PATHS = ["src/auth/login.ts", "src/http/routes.ts", "src/config/env.ts"];

const FIXTURES: readonly FaithfulnessFixture[] = [
  {
    name: "faithful-single",
    variant: "faithful",
    packScopePaths: PACK_PATHS,
    answerText: "Login validates the session in [src/auth/login.ts:10-20].",
  },
  {
    name: "faithful-multi",
    variant: "faithful",
    packScopePaths: PACK_PATHS,
    answerText:
      "The route is registered in [src/http/routes.ts:5-9] and reads config from [src/config/env.ts].",
  },
  {
    name: "faithful-no-citations",
    variant: "faithful",
    packScopePaths: PACK_PATHS,
    answerText: "The service authenticates users and dispatches HTTP routes.",
  },
  {
    name: "hallucinated-path",
    variant: "hallucinated-citation",
    packScopePaths: PACK_PATHS,
    answerText:
      "Login validates in [src/auth/login.ts:10-20] and reads secrets from [src/secret/keys.ts:40-55].",
  },
  {
    name: "hallucinated-only",
    variant: "hallucinated-citation",
    packScopePaths: PACK_PATHS,
    answerText: "The token is signed in [src/crypto/never-retrieved.ts:1-3].",
  },
  {
    name: "hallucinated-line-out-of-window",
    variant: "hallucinated-citation",
    packScopePaths: PACK_PATHS,
    packLineWindows: { "src/auth/login.ts": [{ startLine: 1, endLine: 30 }] },
    answerText: "See [src/auth/login.ts:900-950] for the handler.",
  },
  {
    name: "confident-over-empty",
    variant: "confident-over-empty",
    packScopePaths: [],
    answerText: "The system uses OAuth2 with PKCE and rotates refresh tokens every 24 hours.",
  },
  {
    name: "refusal-on-empty",
    variant: "refusal",
    packScopePaths: [],
    answerText:
      "I could not find repository evidence in the connected scope to answer this question.",
  },
];

function indexFor(fixture: FaithfulnessFixture): PackCitationIndex {
  return {
    scopePaths: new Set(fixture.packScopePaths),
    lineWindowsByPath: new Map(
      Object.entries(fixture.packLineWindows ?? {}).map(([path, windows]) => [path, windows]),
    ),
  };
}

// A minimal pack carrying exactly the fixture's evidence, so packHasUsableEvidence reflects the
// real abstention predicate rather than a hand-set boolean.
function packFor(fixture: FaithfulnessFixture): ConnectedContextPack {
  return {
    files: fixture.packScopePaths.map((scopePath) => ({
      scopePath,
      excerpts: [{ atom: { scopePath } }],
    })),
    uncertainty: fixture.packScopePaths.length === 0 ? [{ kind: "no-evidence" }] : [],
  } as unknown as ConnectedContextPack;
}

export interface GroundedFaithfulnessScorecard {
  readonly fixtures: number;
  // Of the hallucinated fixtures, the fraction where the fabricated citation was detected.
  readonly unsupportedDetectionRate: number;
  // Of the faithful fixtures, the fraction with NO false-positive unsupported flag.
  readonly citationPrecision: number;
  // Of the empty-evidence fixtures, the fraction that abstain (no usable evidence ⇒ must abstain).
  readonly abstentionOnEmptyRate: number;
  readonly failures: readonly string[];
}

function rate(hits: number, total: number): number {
  return total === 0 ? 1 : hits / total;
}

export function runGroundedFaithfulnessEval(): GroundedFaithfulnessScorecard {
  const failures: string[] = [];
  const hallucinated = FIXTURES.filter((f) => f.variant === "hallucinated-citation");
  const faithful = FIXTURES.filter((f) => f.variant === "faithful");
  const empty = FIXTURES.filter(
    (f) => f.variant === "confident-over-empty" || f.variant === "refusal",
  );

  let detected = 0;
  for (const fixture of hallucinated) {
    const result = reconcileInlineCitations(fixture.answerText, indexFor(fixture));
    if (result.unsupported.length > 0) {
      detected += 1;
    } else {
      failures.push(`missed fabricated citation in '${fixture.name}'`);
    }
  }

  let clean = 0;
  for (const fixture of faithful) {
    const result = reconcileInlineCitations(fixture.answerText, indexFor(fixture));
    if (result.unsupported.length === 0) {
      clean += 1;
    } else {
      failures.push(`false-positive unsupported flag in '${fixture.name}'`);
    }
  }

  let abstained = 0;
  for (const fixture of empty) {
    if (!packHasUsableEvidence(packFor(fixture))) {
      abstained += 1;
    } else {
      failures.push(`empty-evidence fixture '${fixture.name}' did not abstain`);
    }
  }

  return {
    fixtures: FIXTURES.length,
    unsupportedDetectionRate: rate(detected, hallucinated.length),
    citationPrecision: rate(clean, faithful.length),
    abstentionOnEmptyRate: rate(abstained, empty.length),
    failures,
  };
}

export interface GroundedFaithfulnessBudget {
  readonly minUnsupportedDetectionRate: number;
  readonly minCitationPrecision: number;
  readonly minAbstentionOnEmptyRate: number;
}

// Faithfulness is a correctness invariant: fabricated citations must ALWAYS be flagged and empty
// evidence must ALWAYS abstain (rates = 1). Citation precision is gated < 1 tolerance is NOT allowed
// here — a false positive would strip a real citation — but the metric being < 1 is a real failure.
export const DEFAULT_GROUNDED_FAITHFULNESS_BUDGET: GroundedFaithfulnessBudget = {
  minUnsupportedDetectionRate: 1,
  minCitationPrecision: 1,
  minAbstentionOnEmptyRate: 1,
};

export function evaluateGroundedFaithfulnessBudget(
  scorecard: GroundedFaithfulnessScorecard,
  budget: GroundedFaithfulnessBudget = DEFAULT_GROUNDED_FAITHFULNESS_BUDGET,
): { readonly ok: boolean; readonly failures: readonly string[] } {
  const failures = [...scorecard.failures];
  if (scorecard.unsupportedDetectionRate < budget.minUnsupportedDetectionRate)
    failures.push("unsupportedDetectionRate");
  if (scorecard.citationPrecision < budget.minCitationPrecision) failures.push("citationPrecision");
  if (scorecard.abstentionOnEmptyRate < budget.minAbstentionOnEmptyRate)
    failures.push("abstentionOnEmptyRate");
  return { ok: failures.length === 0, failures };
}
