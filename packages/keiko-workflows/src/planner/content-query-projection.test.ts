import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { extractAnchors } from "./anchors.js";
import { resolveQueryTargetDecision } from "./plan.js";

function projected(text: string): string {
  const query: RetrievalQuery = {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 50,
    emittedAtMs: 0,
  };
  const anchors = extractAnchors({ text, maxAnchors: 8 }).anchors;
  const decision = resolveQueryTargetDecision(query, anchors);
  return "contentQueryText" in decision && typeof decision.contentQueryText === "string"
    ? decision.contentQueryText
    : text;
}

describe("canonical content query projection for actual lexical execution", () => {
  it.each([
    [
      "Explain scope admission and prompt fitting. Cite implementation files and lines. Keep the answer under 200 words.",
      "Cite implementation files",
      "scope admission and prompt fitting",
    ],
    [
      "Erkläre Quellenzulassung. Zitiere Implementierungszeilen, unter 100 Wörtern.",
      "Zitiere",
      "Quellenzulassung",
    ],
    [
      'Explain "Cite implementation files and lines". Cite implementation files and lines.',
      ". Cite implementation files and lines.",
      '"Cite implementation files and lines"',
    ],
  ])("removes only the unquoted presentation request: %s", (text, directive, content) => {
    expect(projected(text)).not.toContain(directive);
    expect(projected(text)).toContain(content);
    expect(projected(text)).toHaveLength(text.length);
  });

  it.each([
    "Which files implement source admission?",
    "Cite implementation of FooProbe.",
    "Explain src/Manual.TS:301 and the independent pump reset limit.",
    "Explain the operator's policy and don't hide uncertain facts.",
    'Find "Cite implementation files and lines".',
    "Find `Cite implementation files and lines`.",
    "Find 'Cite implementation files and lines'.",
  ])("preserves actual content requests and exact target spelling: %s", (text) => {
    expect(projected(text)).toBe(text);
  });
});
