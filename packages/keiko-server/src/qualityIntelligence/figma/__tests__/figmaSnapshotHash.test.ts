// Unit tests for the Figma Snapshot integrity hashing (Epic #750, Issue #753, drift #735).
//
// The hash is the drift identity: an unchanged design must hash byte-identically regardless of when
// it was built. Issue #812 adds additive a11y colour fields (`textColor` / `backgroundColor`) to the
// Screen-IR; these MUST be hash-neutral so a re-snapshot of the same design after the colour-aware
// normalizer ships does not present as drift. These tests pin both that neutrality AND that a genuine
// structural change (a different node id) still changes the hash.

import { describe, expect, it } from "vitest";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";
import { hashScreen, hashSnapshot } from "../figmaSnapshotHash.js";

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

describe("hashScreen — layout/sizing/cornerRadius/typography fields are hash-neutral", () => {
  // Mirrors the a11y-colour neutrality test above: the new codegen-metadata fields must NOT change
  // the drift identity when added to an otherwise identical design. A snapshot built before these
  // fields shipped and one built after must compare as NOT-drifted.

  it("yields the same hash whether or not layout/sizing/cornerRadius/typography are present", () => {
    const without = screen(
      leaf("root", {
        interactionHint: "container",
        type: "FRAME",
        children: [leaf("t", { text: "Hi" })],
      }),
    );
    const withLayout: IrNode = {
      ...leaf("root", {
        interactionHint: "container",
        type: "FRAME",
        children: [
          {
            ...leaf("t", { text: "Hi" }),
            typography: { fontFamily: "Inter", fontSize: 16, fontWeight: 400 },
          },
        ],
      }),
      layout: { mode: "row", itemSpacing: 8, padding: [16, 16, 16, 16] },
      sizing: { horizontal: "fill" },
      cornerRadius: 8,
    };

    expect(hashScreen("s1", screen(withLayout), SHA)).toBe(hashScreen(without.id, without, SHA));
  });

  it("still changes the hash for a genuine structural change even when layout fields are present", () => {
    const a: IrNode = {
      ...leaf("root", { interactionHint: "container", children: [leaf("t1")] }),
      layout: { mode: "row" },
    };
    const b: IrNode = {
      ...leaf("root", { interactionHint: "container", children: [leaf("t2")] }),
      layout: { mode: "row" },
    };

    expect(hashScreen("s1", screen(a), SHA)).not.toBe(hashScreen("s1", screen(b), SHA));
  });
});

describe("hashSnapshot — order-independent in screenId (sort step #753)", () => {
  it("hashes identically regardless of the per-screen input order", () => {
    const perScreen = [
      { screenId: "z:9", integrityHash: "1".repeat(64) },
      { screenId: "a:1", integrityHash: "2".repeat(64) },
    ];
    const reversed = [...perScreen].reverse();
    // The snapshot identity sorts per-screen entries by screenId before hashing, so document order
    // must not affect the hash. RED if the .sort() is dropped from hashSnapshot.
    expect(hashSnapshot(1, "v-pinned-1", perScreen)).toBe(hashSnapshot(1, "v-pinned-1", reversed));
  });
});

describe("hashScreen — positive controls: structural fields ARE included in the hash (#735 drift identity)", () => {
  // These tests guard against an over-broad HASH_NEUTRAL_KEYS set accidentally stripping structural
  // fields (name, text) that ARE part of the drift identity. If those keys were added to
  // HASH_NEUTRAL_KEYS, two designs that differ only in name/text would hash identically, breaking
  // the drift detection guarantee from #735.

  it("produces different hashes for trees differing only in node.name (same id)", () => {
    // Only the root's name differs; id, type, children are identical.
    const a = screen(
      leaf("root", {
        interactionHint: "container",
        type: "FRAME",
        name: "Button",
        children: [leaf("t", { text: "Label" })],
      }),
    );
    const b = screen(
      leaf("root", {
        interactionHint: "container",
        type: "FRAME",
        name: "CTA",
        children: [leaf("t", { text: "Label" })],
      }),
    );

    // If name were in HASH_NEUTRAL_KEYS, both would hash identically — drift invisible.
    expect(hashScreen(a.id, a, SHA)).not.toBe(hashScreen(b.id, b, SHA));
  });

  it("produces different hashes for trees differing only in node.text (same id and name)", () => {
    // Only the leaf text differs; all structural ids/names are identical.
    const a = screen(
      leaf("root", {
        interactionHint: "container",
        type: "FRAME",
        children: [leaf("t", { name: "t", text: "Hello" })],
      }),
    );
    const b = screen(
      leaf("root", {
        interactionHint: "container",
        type: "FRAME",
        children: [leaf("t", { name: "t", text: "World" })],
      }),
    );

    // If text were in HASH_NEUTRAL_KEYS, a copy-change would be invisible to drift detection.
    expect(hashScreen(a.id, a, SHA)).not.toBe(hashScreen(b.id, b, SHA));
  });
});
