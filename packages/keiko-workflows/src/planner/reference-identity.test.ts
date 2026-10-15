import { describe, expect, it } from "vitest";
import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import { createExplorationPlan } from "./plan.js";
import { classifyRetrievalIntent } from "./intent.js";
import type { SearchReference } from "./references.js";

const scope: SelectedScope = {
  schemaVersion: "1",
  scopeId: "reference-identity",
  workspaceRoot: "/repo",
  kind: "workspace-root",
  relativePaths: [],
  conversationId: undefined,
  connectedAtMs: 1,
  explicitConnection: true,
};
function plan(
  reference: SearchReference,
  previousRetrievalIntent: "diagnostic-search" | "targeted-code-search",
): ReturnType<typeof createExplorationPlan> {
  return createExplorationPlan(
    {
      scope,
      query: {
        kind: "natural-language",
        text: "And now in that file?",
        caseSensitive: false,
        maxResults: 50,
        emittedAtMs: 1,
      },
      references: [reference],
      previousRetrievalIntent,
    },
    { nowMs: () => 1 },
  );
}

describe("bounded reference continuity identity", () => {
  it("does not inherit a metadata or unresolved conversational intent", () => {
    expect(
      classifyRetrievalIntent("And now?", scope, {
        previousIntent: "project-metadata",
        referencePresent: true,
      }).intent,
    ).not.toBe("conversational-follow-up");
    expect(
      classifyRetrievalIntent("And now?", scope, {
        previousIntent: "conversational-follow-up",
        referencePresent: true,
      }).intent,
    ).not.toBe("conversational-follow-up");
  });
  it("does not inherit for an independently named target or a new trace", () => {
    expect(
      classifyRetrievalIntent("Explain DifferentValidator", scope, {
        previousIntent: "diagnostic-search",
        referencePresent: true,
      }).intent,
    ).toBe("targeted-code-search");
    expect(
      classifyRetrievalIntent("And now src/Other.ts?", scope, {
        previousIntent: "diagnostic-search",
        referencePresent: true,
      }).intent,
    ).not.toBe("conversational-follow-up");
    expect(
      classifyRetrievalIntent("And now?\n    at fail (src/Other.ts:2:1)", scope, {
        previousIntent: "targeted-code-search",
        referencePresent: true,
      }).intent,
    ).toBe("diagnostic-search");
  });
  it.each(["What can you see now?", "Was siehst du jetzt?"])(
    "inherits targeted reference continuity for orientation %s only with an admitted referent",
    (text) => {
      expect(
        classifyRetrievalIntent(text, scope, {
          previousIntent: "targeted-code-search",
          referencePresent: true,
        }),
      ).toMatchObject({
        intent: "conversational-follow-up",
        effectiveIntent: "targeted-code-search",
      });
      expect(
        classifyRetrievalIntent(text, scope, {
          previousIntent: "targeted-code-search",
          referencePresent: false,
        }).intent,
      ).toBe("repository-overview");
    },
  );
  it("binds reference location, origin, and inherited effective intent into plan identity", () => {
    const first = plan(
      { path: "src/Feature.ts", line: 301, origin: "assistant" },
      "diagnostic-search",
    );
    expect(first.planId).not.toBe(
      plan({ path: "src/Feature.ts", line: 302, origin: "assistant" }, "diagnostic-search").planId,
    );
    expect(first.planId).not.toBe(
      plan({ path: "src/Feature.ts", line: 301, origin: "query" }, "diagnostic-search").planId,
    );
    expect(first.planId).not.toBe(
      plan({ path: "src/Feature.ts", line: 301, origin: "assistant" }, "targeted-code-search")
        .planId,
    );
  });
});
