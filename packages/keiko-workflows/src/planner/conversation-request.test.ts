import { describe, expect, it } from "vitest";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { createExplorationPlan } from "./plan.js";
import { extractAnchors } from "./anchors.js";
import { classifyRetrievalIntent } from "./intent.js";

const SCOPE: SelectedScope = {
  schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
  conversationId: undefined,
  connectedAtMs: 1,
  kind: "workspace-root",
  workspaceRoot: "/workspace",
  scopeId: "conversation-request-proof",
  relativePaths: [],
  explicitConnection: true,
};

function plan(text: string): ReturnType<typeof createExplorationPlan> {
  return createExplorationPlan({
    scope: SCOPE,
    query: { kind: "natural-language", text, caseSensitive: false, maxResults: 50, emittedAtMs: 1 },
  });
}

describe("positive supplied-context acknowledgement requests", () => {
  it.each([
    "My preferences are concise explanations and reversible next steps. Please acknowledge these preferences.",
    "These are my working notes. Confirm receipt of this message.",
    "Meine Präferenzen sind kurze Antworten. Bitte bestätige diese Präferenzen.",
    "My preference is to compare alternatives. Briefly acknowledge this preference in no more than twenty words. Do not repeat the note.",
  ])("does not treat self-contained user context as a source search: %s", (text) => {
    const result = plan(text);
    expect(result.state).toBe("clarification-needed");
    expect(result.clarification?.reason).toBe("too-generic");
    expect(result.rings).toEqual([]);
    expect(result.query.text).toBe(text);
  });

  it.each([
    "My preferences are concise explanations. Please acknowledge these preferences. Then explain src/target.ts.",
    "Acknowledge the Next.js configuration in this repository.",
    "Confirm which working preferences this source supports.",
    "My preferences are concise explanations. What temperature trips the Vesper dosing interlock?",
    'Find "next steps" in the manuals.',
    "Explain src/target.ts and compare the alternatives.",
    "Explain the maximum operating limit in the customer manual.",
    "AssertionError: expected 1 to be 2\n    at Object.get (src/target.ts:1:1)",
  ])("preserves genuine source, mixed, literal and diagnostic work: %s", (text) => {
    const result = plan(text);
    expect(result.state).toBe("ready");
    expect(result.rings.some((ring) => ring.kind === "lexical")).toBe(true);
  });
});

describe("Next framework spelling and grammatical context", () => {
  it.each(["Propose reversible next steps.", "Please explain the next sentence."])(
    "does not manufacture a framework from ordinary prose: %s",
    (text) => {
      expect(
        extractAnchors({ text, maxAnchors: 8 }).anchors.map((anchor) => anchor.term),
      ).not.toContain("nextjs");
      expect(classifyRetrievalIntent(text, SCOPE).normalizedTerms).not.toContain("nextjs");
    },
  );
  it.each([
    "Which Next.js version does this project use?",
    "Which Next version does this project use?",
    "Does this project use Next?",
    "Explain the Next framework configuration.",
  ])("preserves real framework requests: %s", (text) => {
    expect(extractAnchors({ text, maxAnchors: 8 }).anchors.map((anchor) => anchor.term)).toContain(
      "nextjs",
    );
    expect(classifyRetrievalIntent(text, SCOPE).intent).toBe("project-metadata");
  });
});
