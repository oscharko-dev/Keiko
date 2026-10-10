import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type ConnectedContextPack,
  type EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { assembleContextPack, type AssembleInput } from "@oscharko-dev/keiko-workflows";
import { ContextOverflowError } from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor } from "./deps.js";
import { fittedGroundedGatewayPrompt } from "./grounded-qa.js";

const PATH = "src/pipeline.ts";
const QUESTION = "Trace the request through source admission and prompt fitting.";
const WEAK = "An incidental scope helper stores unrelated context.";
const STRONG = "The request admission validates the selected source before prompt fitting.";

function located(line: number, score: number): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: `located-${String(line)}`,
    scopePath: PATH,
    lineRange: { startLine: line, endLine: line },
    score,
    provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "query" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function listing(): EvidenceAtom {
  return {
    ...located(1, 1),
    stableId: "path-only-listing",
    lineRange: undefined,
    provenance: { kind: "file-listing", tool: "repo.findFiles", queryFingerprint: "query" },
  };
}

function inputFor(atoms: readonly EvidenceAtom[]): AssembleInput {
  return {
    scope: {
      schemaVersion: "1",
      scopeId: "source-window-priority",
      workspaceRoot: "/workspace",
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 0,
    },
    query: {
      kind: "natural-language",
      text: QUESTION,
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: 0,
    },
    budget: DEFAULT_EXPLORATION_BUDGET,
    atoms,
    ranked: [{ scopePath: PATH, score: 1, signals: [], omitted: undefined }],
    omittedFromRanking: [],
    excerpts: new Map([
      [
        PATH,
        [
          { startLine: 10, endLine: 10, content: WEAK },
          { startLine: 301, endLine: 301, content: STRONG },
        ],
      ],
    ]),
  };
}

async function packFor(atoms: readonly EvidenceAtom[]): Promise<ConnectedContextPack> {
  const { pack } = await assembleContextPack(inputFor(atoms), {
    includeSurroundingContext: true,
    nowMs: () => 0,
  });
  expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  return pack;
}

function smallestStrongInputBudget(pack: ConnectedContextPack): number {
  let low = 1;
  let high = pack.budget.modelInputTokensMax;
  const redactor = buildRedactor({});
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    let containsStrong = false;
    try {
      const sent = fittedGroundedGatewayPrompt(QUESTION, pack, redactor, {
        modelInputTokensMax: middle,
      });
      containsStrong = sent.messages.some((message) => message.content.includes(STRONG));
    } catch (error) {
      if (!(error instanceof ContextOverflowError)) throw error;
    }
    if (containsStrong) high = middle;
    else low = middle + 1;
  }
  return low;
}

describe("located source window priority beside path-only discovery", () => {
  it.each([false, true])(
    "does not lend a path-only score to independently located bodies: reverse=%s",
    async (reverse) => {
      const atoms = [listing(), located(10, 0.1), located(301, 0.9)];
      if (reverse) atoms.reverse();
      const pack = await packFor(atoms);
      const bodies = pack.files[0]?.excerpts.filter((excerpt) => excerpt.content.length > 0);
      expect(
        bodies?.map((excerpt) => ({ content: excerpt.content, score: excerpt.atom.score })),
      ).toEqual(
        expect.arrayContaining([
          { content: WEAK, score: 0.1 },
          { content: STRONG, score: 0.9 },
        ]),
      );
      expect(pack.usage.excerptBytes).toBe(Buffer.byteLength(WEAK) + Buffer.byteLength(STRONG));
    },
  );

  it("uses actual located relevance when the canonical prompt fitter must omit a body", async () => {
    const pack = await packFor([listing(), located(10, 0.1), located(301, 0.9)]);
    const strongOnly = await packFor([located(301, 0.9)]);
    const redactor = buildRedactor({});
    const modelInputTokensMax = smallestStrongInputBudget(strongOnly);
    const sent = fittedGroundedGatewayPrompt(QUESTION, pack, redactor, { modelInputTokensMax });
    expect(sent.messages.map((message) => message.content).join("\n")).toContain(STRONG);
    expect(sent.sentEvidencePacks?.[0]?.files[0]?.excerpts[0]?.atom.score).toBe(0.9);
  });

  it("retains all located bodies when the unchanged ordinary grant fits them", async () => {
    const pack = await packFor([listing(), located(10, 0.1), located(301, 0.9)]);
    const sent = fittedGroundedGatewayPrompt(QUESTION, pack, buildRedactor({}));
    const prompt = sent.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain(WEAK);
    expect(prompt).toContain(STRONG);
    expect(sent.sentReferenceCount).toBe(2);
  });

  it("retains readable evidence when path-only discovery is the sole source signal", async () => {
    const pack = await packFor([listing()]);
    const bodies = pack.files[0]?.excerpts.filter((excerpt) => excerpt.content.length > 0);
    expect(bodies).toHaveLength(1);
    expect(bodies?.map((excerpt) => excerpt.content)).toEqual([WEAK]);
  });
});
