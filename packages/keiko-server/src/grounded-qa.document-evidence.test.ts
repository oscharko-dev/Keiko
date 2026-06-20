// Prompt framing + citation distinctness for bounded document evidence (Issue #1285): a
// document-extract excerpt must be labelled as document evidence in the model prompt and carry a
// `documentFormat` discriminator on the browser citation, while ordinary code/text evidence is
// unchanged.

import { describe, expect, it } from "vitest";

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type ConnectedContextPack,
  type ContextExcerpt,
  type EvidenceAtomProvenanceKind,
} from "@oscharko-dev/keiko-contracts/connected-context";

import { buildCitations, evidenceLines } from "./grounded-qa.js";
import type { Redactor } from "./deps.js";

const identityRedactor = ((value: string) => value) as Redactor;

function excerpt(
  scopePath: string,
  kind: EvidenceAtomProvenanceKind,
  tool: string,
  content: string,
): ContextExcerpt {
  return {
    atom: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId: `atom-${scopePath}`,
      scopePath,
      lineRange: { startLine: 1, endLine: 3 },
      score: 0.9,
      provenance: { kind, tool, queryFingerprint: "fp-1" },
      redactionState: "redacted",
      emittedAtMs: 1,
      ledgerRef: undefined,
    },
    content,
    contentBytes: Buffer.byteLength(content, "utf8"),
  };
}

function packWithDocument(): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: "pack-doc",
    scope: {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "scope-1",
      workspaceRoot: "/ws",
      kind: "files",
      relativePaths: ["docs/report.docx", "src/foo.ts"],
      conversationId: undefined,
      connectedAtMs: 1,
      explicitConnection: true,
    },
    query: {
      kind: "natural-language",
      text: "what is in the report",
      caseSensitive: false,
      maxResults: 10,
      emittedAtMs: 1,
    },
    budget: DEFAULT_EXPLORATION_BUDGET,
    usage: {
      searchCalls: 0,
      filesRead: 2,
      excerptBytes: 40,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 0,
      rerankCalls: 0,
    },
    files: [
      {
        scopePath: "docs/report.docx",
        role: "read-only",
        selectionReason: "ranked by document-extract",
        excerpts: [
          excerpt(
            "docs/report.docx",
            "document-extract",
            "repo.documentExtract",
            "Policy: backups run nightly.",
          ),
        ],
      },
      {
        scopePath: "src/foo.ts",
        role: "read-only",
        selectionReason: "ranked by alpha",
        excerpts: [excerpt("src/foo.ts", "lexical-search", "repo.searchText", "const x = 1;")],
      },
    ],
    omitted: [],
    uncertainty: [],
    emittedAtMs: 1,
    ledgerRef: undefined,
  };
}

describe("document evidence prompt framing", () => {
  it("labels document excerpts distinctly from code excerpts in the prompt", () => {
    const lines = evidenceLines(packWithDocument(), identityRedactor).join("\n");
    expect(lines).toContain("Document evidence (DOCX, extracted text) docs/report.docx:1-3");
    expect(lines).toContain("Policy: backups run nightly.");
    // The code excerpt keeps the plain "Evidence" framing (no regression).
    expect(lines).toContain("- Evidence src/foo.ts:1-3");
    expect(lines).not.toContain("Document evidence (DOCX, extracted text) src/foo.ts");
  });
});

describe("document evidence citations", () => {
  it("tags document citations with a documentFormat discriminator", () => {
    const citations = buildCitations(packWithDocument(), identityRedactor);
    const docCitation = citations.find((c) => c.scopePath === "docs/report.docx");
    const codeCitation = citations.find((c) => c.scopePath === "src/foo.ts");
    expect(docCitation?.documentFormat).toBe("docx");
    expect(codeCitation?.documentFormat).toBeUndefined();
  });
});
