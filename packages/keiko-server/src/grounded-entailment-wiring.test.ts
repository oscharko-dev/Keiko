// Coverage for the shared entailment wiring helper used by the multi-source and hybrid grounded
// paths (#2563): it appends redacted, wire-projected entailment markers to an assembled answer, and
// is a no-op (byte-identical) when the stage produced nothing.

import { describe, expect, it } from "vitest";
import type { ConnectedContextPack, UncertaintyMarker } from "@oscharko-dev/keiko-contracts";
import type { Redactor } from "./deps.js";
import {
  appendGroundedAnswerEntailment,
  appendGroundedAnswerNumericEntailment,
} from "./grounded-qa.js";
import type { EntailmentStage } from "./grounded-entailment-stage.js";

function stageReturning(markers: readonly UncertaintyMarker[]): EntailmentStage {
  return {
    evaluate: (): Promise<readonly UncertaintyMarker[]> => Promise.resolve(markers),
    evaluateNumeric: (): Promise<readonly UncertaintyMarker[]> => Promise.resolve(markers),
  };
}

const identityRedactor: Redactor = (value: unknown): unknown => value;
const NO_PACKS: readonly ConnectedContextPack[] = [];

describe("appendGroundedAnswerEntailment", () => {
  it("returns the answer unchanged (same reference) when the stage produces no markers", async () => {
    const answer = { uncertainty: [{ kind: "no-evidence" as const, claim: "x" }] };
    const result = await appendGroundedAnswerEntailment(
      answer,
      stageReturning([]),
      "answer text",
      NO_PACKS,
      identityRedactor,
    );
    expect(result).toBe(answer);
  });

  it("appends redacted, wire-projected markers to the answer uncertainty", async () => {
    const answer = { uncertainty: [] as { kind: string; claim: string }[] };
    const marker: UncertaintyMarker = {
      kind: "unsupported-claim",
      claim: "cited src/x.ts is unsupported",
      impactedAtomIds: [],
      emittedAtMs: 0,
    };
    const redactor: Redactor = (value: unknown): unknown => `[R]${String(value)}`;
    const result = await appendGroundedAnswerEntailment(
      answer,
      stageReturning([marker]),
      "answer text",
      NO_PACKS,
      redactor,
    );
    expect(result.uncertainty).toEqual([
      { kind: "unsupported-claim", claim: "[R]cited src/x.ts is unsupported" },
    ]);
  });

  it("projects numeric citation entailment markers through the same wire boundary", async () => {
    const answer = { uncertainty: [] as { kind: string; claim: string }[] };
    const marker: UncertaintyMarker = {
      kind: "unsupported-claim",
      claim: "cited [1] is unsupported",
      impactedAtomIds: [],
      emittedAtMs: 0,
    };
    const result = await appendGroundedAnswerNumericEntailment(
      answer,
      stageReturning([marker]),
      "answer text [1]",
      [{ marker: 1, excerptText: "rendered excerpt" }],
      identityRedactor,
    );
    expect(result.uncertainty).toEqual([{ kind: "unsupported-claim", claim: marker.claim }]);
  });
});
