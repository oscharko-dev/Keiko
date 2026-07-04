import { describe, expect, it } from "vitest";
import type { ContextAssemblyDiagnostics } from "@oscharko-dev/keiko-contracts";
import { promptLaneSelectionVariants, type PromptLaneSelection } from "./chat-prompt-budget.js";

const DIAGNOSTICS = {} as unknown as ContextAssemblyDiagnostics;

function memory(id: string): PromptLaneSelection["memoryEntries"][number] {
  return { id, text: `memory ${id}` } as unknown as PromptLaneSelection["memoryEntries"][number];
}

function document(id: string): PromptLaneSelection["documentContext"][number] {
  return {
    id,
    displayName: `${id}.md`,
    text: `document ${id}`,
  } as unknown as PromptLaneSelection["documentContext"][number];
}

describe("promptLaneSelectionVariants (GEN-AI-CONTEXT-001, RB-4)", () => {
  it("drops resurfaced memory/compaction BEFORE user-attached documents", () => {
    const selection: PromptLaneSelection = {
      memoryEntries: [memory("m1"), memory("m2")],
      compactionContextText: "resurfaced compaction",
      documentContext: [document("d1"), document("d2")],
      diagnostics: DIAGNOSTICS,
    };
    const variants = promptLaneSelectionVariants(selection);

    // The FIRST variant that drops a document must only appear after ALL memory + compaction have
    // been dropped — i.e. no variant reduces documents while still carrying memory or compaction.
    const firstDocumentDropIndex = variants.findIndex(
      (v) => v.documentContext.length < selection.documentContext.length,
    );
    expect(firstDocumentDropIndex).toBeGreaterThan(0);
    for (let i = 0; i < firstDocumentDropIndex; i += 1) {
      // Before any document is dropped, every variant keeps ALL documents.
      expect(variants[i]?.documentContext.length).toBe(selection.documentContext.length);
    }
    // Every variant that has dropped a document carries NO memory and NO compaction.
    for (const variant of variants.filter(
      (v) => v.documentContext.length < selection.documentContext.length,
    )) {
      expect(variant.memoryEntries.length).toBe(0);
      expect(variant.compactionContextText).toBeUndefined();
    }
  });

  it("still offers a minimal variant with nothing left, so a prompt can always be built", () => {
    const selection: PromptLaneSelection = {
      memoryEntries: [memory("m1")],
      compactionContextText: "c",
      documentContext: [document("d1")],
      diagnostics: DIAGNOSTICS,
    };
    const variants = promptLaneSelectionVariants(selection);
    expect(
      variants.some(
        (v) =>
          v.memoryEntries.length === 0 &&
          v.compactionContextText === undefined &&
          v.documentContext.length === 0,
      ),
    ).toBe(true);
  });

  it("keeps at least one attached document when dropping all memory makes room", () => {
    const selection: PromptLaneSelection = {
      memoryEntries: [memory("m1"), memory("m2"), memory("m3")],
      documentContext: [document("d1")],
      diagnostics: DIAGNOSTICS,
    };
    const variants = promptLaneSelectionVariants(selection);
    // A variant with zero memory but the document retained must exist and precede any doc-drop.
    const memoryFreeWithDoc = variants.findIndex(
      (v) => v.memoryEntries.length === 0 && v.documentContext.length === 1,
    );
    const firstDocDrop = variants.findIndex((v) => v.documentContext.length === 0);
    expect(memoryFreeWithDoc).toBeGreaterThanOrEqual(0);
    expect(memoryFreeWithDoc).toBeLessThan(firstDocDrop);
  });
});
