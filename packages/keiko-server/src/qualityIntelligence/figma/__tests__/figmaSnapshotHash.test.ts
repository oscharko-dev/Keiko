// Unit tests for the Figma Snapshot integrity hashing (Epic #750, Issue #753, drift #735).
//
// The hash is the drift identity: an unchanged design must hash byte-identically regardless of when
// it was built. Issue #812 adds additive a11y colour fields (`textColor` / `backgroundColor`) to the
// Screen-IR; these MUST be hash-neutral so a re-snapshot of the same design after the colour-aware
// normalizer ships does not present as drift. These tests pin both that neutrality AND that a genuine
// structural change (a different node id) still changes the hash.

import { describe, expect, it } from "vitest";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";
import { hashScreen } from "../figmaSnapshotHash.js";

type IrNode = QualityIntelligenceFigma.IrNode;
type ScreenIr = QualityIntelligenceFigma.ScreenIr;

const SHA = "a".repeat(64);

const leaf = (id: string, over: Partial<IrNode> = {}): IrNode => ({
  id,
  name: over.name ?? id,
  type: over.type ?? "TEXT",
  interactionHint: over.interactionHint ?? "text",
  ...(over.text !== undefined ? { text: over.text } : {}),
  ...(over.textColor !== undefined ? { textColor: over.textColor } : {}),
  ...(over.backgroundColor !== undefined ? { backgroundColor: over.backgroundColor } : {}),
  imageFills: over.imageFills ?? [],
  children: over.children ?? [],
});

const screen = (root: IrNode): ScreenIr => ({ id: "s1", name: "Screen", root });

describe("hashScreen — a11y colour fields are hash-neutral (#812)", () => {
  it("yields the same hash whether or not the a11y colour fields are present", () => {
    const without = screen(
      leaf("root", {
        interactionHint: "container",
        type: "FRAME",
        children: [leaf("t", { text: "Hi" })],
      }),
    );
    const withColors = screen(
      leaf("root", {
        interactionHint: "container",
        type: "FRAME",
        backgroundColor: "#ffffff",
        children: [leaf("t", { text: "Hi", textColor: "#000000" })],
      }),
    );

    expect(hashScreen(withColors.id, withColors, SHA)).toBe(hashScreen(without.id, without, SHA));
  });

  it("still changes the hash for a genuine structural change (different node id)", () => {
    const a = screen(leaf("root", { interactionHint: "container", children: [leaf("t1")] }));
    const b = screen(leaf("root", { interactionHint: "container", children: [leaf("t2")] }));

    expect(hashScreen(a.id, a, SHA)).not.toBe(hashScreen(b.id, b, SHA));
  });

  it("still changes the hash when the image bytes (sha256) change", () => {
    const ir = screen(leaf("root", { interactionHint: "container", children: [leaf("t")] }));

    expect(hashScreen(ir.id, ir, "a".repeat(64))).not.toBe(hashScreen(ir.id, ir, "b".repeat(64)));
  });
});
