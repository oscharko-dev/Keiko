// Behavioural + mutation proof for the sealed-pod governance goldset fixture (Epic #1826,
// child #2011). The structural registry/consistency checks live in `fixtures.test.ts`; this
// file proves the fixture actually exercises Epic #1819 sealed-pod enforcement through the
// SHIPPED retrieval path (`runLocalKnowledgeRetrieval`, invoked unchanged by the eval runner)
// and reports denial as a governance outcome rather than a retrieval-quality miss.
//
// The proof is self-verifying: `noEvidenceAccuracy` is 1.0 ONLY when the runner returns
// `noEvidence` with reason EXACTLY `policy-denied` (the fixture's `expectedNoEvidenceReason`).
// A `below-min-score` / `no-vectors` / any other reason would drop the dimension to 0, so a
// passing scorecard is a positive assertion that the seal — not a lexical or semantic gap —
// produced the outcome. The mutation test removes the seal and shows the card flips to FAIL,
// proving the fixture is non-tautological.

import { describe, expect, it } from "vitest";

import { standardPodModelUsePolicy } from "@oscharko-dev/keiko-contracts";

import { sealedPodFixture } from "./fixtures.js";
import { renderRetrievalEvalQualityGateReport } from "./report.js";
import { runRetrievalEval } from "./runner.js";
import type { RetrievalEvalFixture } from "./types.js";

describe("runRetrievalEval — sealed-pod governance fixture (#2011)", () => {
  it("scores a sealed-pod denial as a passing governance outcome, not a quality miss", async () => {
    const scorecard = await runRetrievalEval(sealedPodFixture);
    // noEvidenceAccuracy=1 REQUIRES the runner to have returned reason "policy-denied":
    // scoreNoEvidenceAccuracy compares the actual reason against the fixture's expected
    // reason, so any other no-evidence reason (or returned evidence) fails this dimension.
    expect(scorecard.dimensions.noEvidenceAccuracy).toBe(1);
    // Relevance dimensions stay vacuously 1.0 — the denial is NOT counted as a recall or
    // isolation failure. This is the "separate policy outcome from relevance movement" AC.
    expect(scorecard.dimensions.recall).toBe(1);
    expect(scorecard.dimensions.sourceIsolation).toBe(1);
    expect(scorecard.passed).toBe(true);
  });

  it("depends on the seal: an unsealed (standard-policy) variant retrieves the chunk and fails", async () => {
    // Mutation witness. Flip ONLY the pod's model-use policy to standard: external
    // embeddings become allowed, so the topic-salted dense lane returns the chunk and
    // `noEvidence` flips to false. The fixture's `expectedNoEvidence` assertion then fails,
    // dropping noEvidenceAccuracy to 0 and the card to FAIL — proving the passing case above
    // is caused by the seal and nothing else.
    const unsealed: RetrievalEvalFixture = {
      ...sealedPodFixture,
      id: "sealed-pod-unsealed-mutation",
      capsules: sealedPodFixture.capsules.map((capsule) => ({
        ...capsule,
        modelUsePolicy: standardPodModelUsePolicy(),
      })),
    };
    const scorecard = await runRetrievalEval(unsealed);
    expect(scorecard.dimensions.noEvidenceAccuracy).toBe(0);
    expect(scorecard.passed).toBe(false);
  });

  it("keeps sealed-pod scorecard evidence body-free", async () => {
    const scorecard = await runRetrievalEval(sealedPodFixture);
    const report = renderRetrievalEvalQualityGateReport([scorecard]);
    expect(report).toContain("sealed-pod");
    expect(report).toContain("policy-denied:1");
    expect(report).not.toContain("Restricted compliance dossier");
    expect(report).not.toContain("embargoed filings");
  });

  // Regression for #2011 audit finding: the shipped fixture's query is deliberately
  // lexically DISJOINT from the chunk body (see the fixture comment), so it can only ever
  // prove the DENSE lane is gated. It cannot detect a policy gap in the lexical/BM25 lane.
  // This variant swaps in a query that lexically matches the sealed chunk body verbatim —
  // before the fix this returned `referenceCount: 1` (the sealed content leaking through
  // the ungated lexical lane) instead of the required `policy-denied` no-evidence outcome.
  it("also denies a lexically-matching query — the seal is not dense-lane-only", async () => {
    const sealedChunk = sealedPodFixture.capsules[0]?.sources[0]?.documents[0]?.chunks[0];
    if (sealedChunk === undefined) throw new Error("fixture is missing its sealed chunk");
    const baseQuery = sealedPodFixture.queries[0];
    if (baseQuery === undefined) throw new Error("fixture is missing its query");
    const lexicallyMatching: RetrievalEvalFixture = {
      ...sealedPodFixture,
      id: "sealed-pod-lexical-match",
      queries: [{ ...baseQuery, text: sealedChunk.text }],
    };
    const scorecard = await runRetrievalEval(lexicallyMatching);
    expect(scorecard.outcomes.referenceCount).toBe(0);
    expect(scorecard.dimensions.noEvidenceAccuracy).toBe(1);
    expect(scorecard.passed).toBe(true);
  });
});
