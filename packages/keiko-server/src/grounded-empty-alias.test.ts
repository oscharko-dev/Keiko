import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type ConnectedContextPack,
  type EvidenceAtom,
  type ContextExcerpt,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { assembleContextPack } from "@oscharko-dev/keiko-workflows";
import { createInMemoryUiStore } from "./store/index.js";
import { evidenceLines, fittedGroundedGatewayPrompt, promptExcerptCount } from "./grounded-qa.js";

const PATH = "src/decision.ts";
const CONTENT = "The selected source validates the accepted operation.";
const redactor = (value: unknown): unknown => value;

function atom(stableId: string): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId,
    scopePath: PATH,
    lineRange: { startLine: 1, endLine: 1 },
    score: 1,
    provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "query" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

async function assembled(withAlias: boolean, content = CONTENT): Promise<ConnectedContextPack> {
  const primary = atom("positive");
  const alias: EvidenceAtom = {
    ...atom("reference-alias"),
    score: 0.5,
    edge: {
      kind: "reference",
      source: { scopePath: PATH, lineRange: { startLine: 1, endLine: 1 } },
      target: { scopePath: PATH, lineRange: { startLine: 1, endLine: 1 } },
      confidence: "heuristic",
    },
  };
  const { pack } = await assembleContextPack(
    {
      scope: {
        schemaVersion: "1",
        scopeId: "empty-alias",
        workspaceRoot: "/workspace",
        kind: "workspace-root",
        relativePaths: [],
        conversationId: undefined,
        connectedAtMs: 0,
      },
      query: {
        kind: "natural-language",
        text: "Explain the selected operation.",
        caseSensitive: false,
        maxResults: 50,
        emittedAtMs: 0,
      },
      budget: DEFAULT_EXPLORATION_BUDGET,
      atoms: withAlias ? [primary, alias] : [primary],
      ranked: [{ scopePath: PATH, score: 1, signals: [], omitted: undefined }],
      omittedFromRanking: [],
      excerpts: new Map([[PATH, [{ startLine: 1, endLine: 1, content }]]]),
    },
    { includeSurroundingContext: true, nowMs: () => 0 },
  );
  expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  return pack;
}

describe("grounded prompt presentation of deduplicated metadata aliases", () => {
  it("renders only as many evidence bodies as the production reference counter declares", async () => {
    const pack = await assembled(true);
    expect(pack.files.flatMap((file) => file.excerpts)).toHaveLength(2);
    expect(promptExcerptCount([pack])).toBe(1);
    const headers = evidenceLines(pack, redactor).filter((line) => line.startsWith("- Evidence "));
    expect(headers).toHaveLength(promptExcerptCount([pack]));
  });

  it("does not repeat empty fences for a deduplicated reference observation", async () => {
    const pack = await assembled(true);
    const plain = await assembled(false);
    expect(evidenceLines(pack, redactor)).toEqual(evidenceLines(plain, redactor));
  });

  it("retains the physical source and its exact line annotation without aliases", async () => {
    const pack = await assembled(false);
    expect(evidenceLines(pack, redactor)).toContain(`1 | ${CONTENT}`);
    expect(promptExcerptCount([pack])).toBe(1);
  });

  it("retains a nonempty whitespace-only source line", async () => {
    const pack = await assembled(true, " ");
    expect(promptExcerptCount([pack])).toBe(1);
    expect(evidenceLines(pack, redactor)).toContain("1 |  ");
    expect(evidenceLines(pack, redactor).filter((line) => line === "```")).toHaveLength(2);
  });

  it("does not render an empty metadata-only file as source evidence", async () => {
    const pack = await assembled(true);
    const metadataOnly = {
      ...pack,
      files: pack.files.map((file) => ({
        ...file,
        excerpts: file.excerpts.filter((excerpt) => excerpt.content.length === 0),
      })),
    };
    expect(validateConnectedContextPack(metadataOnly)).toEqual({ ok: true });
    expect(promptExcerptCount([metadataOnly])).toBe(0);
    expect(evidenceLines(metadataOnly, redactor)).toEqual([
      `File: ${PATH}`,
      "- No excerpt content was available for this selected file.",
    ]);
  });

  it("preserves a document's positive body, provenance and label", async () => {
    const pack = await assembled(true);
    const document = {
      ...pack,
      files: pack.files.map((file) => ({
        ...file,
        scopePath: "docs/decision.pdf",
        excerpts: file.excerpts.map((excerpt): ContextExcerpt => ({
          ...excerpt,
          atom: {
            ...excerpt.atom,
            scopePath: "docs/decision.pdf",
            provenance: { ...excerpt.atom.provenance, kind: "document-extract" },
          },
        })),
      })),
    };
    expect(validateConnectedContextPack(document)).toEqual({ ok: true });
    const lines = evidenceLines(document, redactor);
    expect(lines.filter((line) => line.startsWith("- Document evidence"))).toEqual([
      "- Document evidence (PDF, extracted text) docs/decision.pdf:1-1 (score 1.00):",
    ]);
    expect(lines).toContain(`1 | ${CONTENT}`);
    expect(lines).toContain("Retrieval provenance: document-extract; tool: repo.searchText.");
  });

  it("preserves selected skill, original grants and metadata in the final fitted prompt", async () => {
    const pack = await assembled(true);
    const original = JSON.stringify(pack);
    const store = createInMemoryUiStore();
    try {
      const skill = store.markdownSkills.import({
        fileName: "generic.md",
        contentBase64: Buffer.from("# Test profile\nVerify accepted observable behavior.").toString(
          "base64",
        ),
      });
      const sent = fittedGroundedGatewayPrompt("Explain the selected operation.", pack, redactor, {
        protectedSkill: skill,
        modelInputTokensMax: pack.budget.modelInputTokensMax,
      });
      const content = sent.messages.map((message) => message.content).join("\n");
      const sentPack = sent.sentEvidencePacks?.[0];
      if (sentPack === undefined) throw new TypeError("Expected the fitted source pack");
      expect(content.split(skill.body)).toHaveLength(2);
      expect(content).toContain(`1 | ${CONTENT}`);
      expect(sent.sentReferenceCount).toBe(1);
      expect(sentPack.budget).toEqual(pack.budget);
      expect(sentPack.uncertainty).toEqual(pack.uncertainty);
      expect(sentPack.usage).toEqual(pack.usage);
      expect(sentPack.files).toEqual(pack.files);
      expect(countGatewayPromptTokens({ messages: sent.messages })).toBeLessThanOrEqual(
        pack.budget.modelInputTokensMax,
      );
      expect(sentPack.files.flatMap((file) => file.excerpts)).toHaveLength(2);
      expect(JSON.stringify(pack)).toBe(original);
    } finally {
      store.close();
    }
  });
});
