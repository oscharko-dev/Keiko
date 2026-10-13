import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { requiresRelationshipOrHistoryRings } from "./plan.js";

function query(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 10, emittedAtMs: 0 };
}

describe("document target paths remain data in ring intent", () => {
  it.each([
    "manuals/operator/reference/edition/current/vesper-dosing-interlock.html",
    "manuals/history/caller/instructions.html",
    "manuals/import/export/reference.xml",
  ])("does not turn path segments into requested relationships: %s", (path) => {
    expect(
      requiresRelationshipOrHistoryRings(
        query(
          `Explain the trip temperature in ${path}. Cite the manual and keep the answer under 100 words.`,
        ),
      ),
    ).toBe(false);
  });

  it.each([
    "Which callers use manuals/operator/reference/vesper.html?",
    "When was manuals/history/vesper.html changed?",
    "Trace the callers of src/reference/caller.ts.",
  ])("preserves an actual request outside the path: %s", (text) => {
    expect(requiresRelationshipOrHistoryRings(query(text))).toBe(true);
  });
});
