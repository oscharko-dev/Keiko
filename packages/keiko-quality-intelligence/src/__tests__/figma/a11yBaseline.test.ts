// Unit tests for the deterministic accessibility baseline derived from a Screen-IR (Issue #812).
//
// Pure domain — no IO, no model, no network. Synthetic Screen-IR + token fixtures only; never any
// real board content. Mutation-robust: the WCAG contrast math is asserted against canonical pairings
// (exact ratio + AA pass/fail), and every a11y rule (accessible name, focus order, target size,
// image alt-text, uncomputable-contrast notice) and the determinism guarantee has a dedicated case.

import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  deriveA11yTestItemsByScreen,
  meetsContrastAa,
  relativeLuminance,
} from "../../domain/figma/a11yBaseline.js";
import type { BoundingBox, IrNode, ScreenIr } from "../../domain/figma/irTypes.js";

// ─── Fixture builders ──────────────────────────────────────────────────────────

const node = (
  id: string,
  interactionHint: IrNode["interactionHint"],
  over: Partial<IrNode> = {},
): IrNode => ({
  id,
  name: over.name ?? id,
  type: over.type ?? "FRAME",
  interactionHint,
  ...optionalNodeFields(over),
  imageFills: over.imageFills ?? [],
  children: over.children ?? [],
});

const screen = (id: string, name: string, root: IrNode): ScreenIr => ({ id, name, root });

const box = (x: number, y: number, width: number, height: number): BoundingBox => ({
  x,
  y,
  width,
  height,
});

const optionalNodeFields = (over: Partial<IrNode>): Partial<IrNode> => ({
  ...(over.text !== undefined ? { text: over.text } : {}),
  ...(over.boundingBox !== undefined ? { boundingBox: over.boundingBox } : {}),
  ...(over.textColor !== undefined ? { textColor: over.textColor } : {}),
  ...(over.backgroundColor !== undefined ? { backgroundColor: over.backgroundColor } : {}),
  ...(over.typography !== undefined ? { typography: over.typography } : {}),
});

const itemsFor = (
  s: ScreenIr,
): readonly { category: string; title: string; outcome?: string | undefined }[] => {
  const byScreen = deriveA11yTestItemsByScreen([s]);
  return (byScreen.get(s.id) ?? []).map((i) => ({
    category: i.category,
    title: i.title,
    outcome: i.outcome,
  }));
};

// ─── WCAG relative luminance + contrast ratio ────────────────────────────────────

describe("relativeLuminance", () => {
  it("computes 0 for black and 1 for white", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 10);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10);
  });

  // M1 COEFFICIENT SPLIT — pins the WCAG 2.x relative-luminance coefficients independently.
  // When a single channel is at full saturation (255) and the other two are 0, the channel
  // linearizes to exactly 1.0 and relativeLuminance returns precisely that channel's coefficient.
  // Existing tests use only achromatic (black/white/grey) inputs, which are coefficient-invariant
  // (swapping 0.2126↔0.7152 or any permutation leaves those tests green). These three cases pin
  // each coefficient individually; swapping any two makes exactly one of these assertions fail.
  it("returns the red coefficient (0.2126) for a pure red input [M1-pin]", () => {
    expect(relativeLuminance({ r: 255, g: 0, b: 0 })).toBeCloseTo(0.2126, 4);
  });

  it("returns the green coefficient (0.7152) for a pure green input [M1-pin]", () => {
    expect(relativeLuminance({ r: 0, g: 255, b: 0 })).toBeCloseTo(0.7152, 4);
  });

  it("returns the blue coefficient (0.0722) for a pure blue input [M1-pin]", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 255 })).toBeCloseTo(0.0722, 4);
  });
});

describe("contrastRatio", () => {
  it("is exactly 21:1 for black on white (canonical maximum)", () => {
    const ratio = contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
    expect(ratio).toBeCloseTo(21, 5);
  });

  it("is 1:1 for identical colours (no contrast)", () => {
    expect(contrastRatio({ r: 18, g: 52, b: 86 }, { r: 18, g: 52, b: 86 })).toBeCloseTo(1, 10);
  });

  it("is symmetric regardless of foreground/background order", () => {
    const fg = { r: 0x77, g: 0x77, b: 0x77 };
    const bg = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(fg, bg)).toBeCloseTo(contrastRatio(bg, fg), 10);
  });

  it("matches the WCAG value for #777 on #fff (≈ 4.48, just below AA-normal)", () => {
    const ratio = contrastRatio({ r: 0x77, g: 0x77, b: 0x77 }, { r: 255, g: 255, b: 255 });
    expect(ratio).toBeCloseTo(4.48, 2);
  });
});

describe("meetsContrastAa", () => {
  it("passes black/white at the normal threshold (21 ≥ 4.5)", () => {
    expect(meetsContrastAa(21, false)).toBe(true);
  });

  it("fails #777/#fff at the normal 4.5 threshold (4.48 < 4.5)", () => {
    const ratio = contrastRatio({ r: 0x77, g: 0x77, b: 0x77 }, { r: 255, g: 255, b: 255 });
    expect(meetsContrastAa(ratio, false)).toBe(false);
  });

  it("passes #777/#fff at the large 3.0 threshold (4.48 ≥ 3.0)", () => {
    const ratio = contrastRatio({ r: 0x77, g: 0x77, b: 0x77 }, { r: 255, g: 255, b: 255 });
    expect(meetsContrastAa(ratio, true)).toBe(true);
  });
});

// ─── Contrast items from token pairings ──────────────────────────────────────────

describe("deriveA11yTestItemsByScreen — contrast", () => {
  it("emits a passing contrast item for black text on a white background", () => {
    const ir = screen(
      "s1",
      "Card",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [node("t", "text", { text: "Hello", textColor: "#000000" })],
      }),
    );

    const contrast = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("contrast"));
    expect(contrast).toHaveLength(1);
    expect(contrast[0]?.category).toBe("a11y");
    expect(contrast[0]?.title.toLowerCase()).toContain("meets");
  });

  it("emits a failing contrast item for #777 text on #fff (4.48 < 4.5 default normal)", () => {
    const ir = screen(
      "s2",
      "Card",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [node("t", "text", { text: "Faint", textColor: "#777777" })],
      }),
    );

    const fail = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("contrast"));
    expect(fail).toHaveLength(1);
    expect(fail[0]?.title.toLowerCase()).toContain("below");
    expect(fail[0]?.outcome).toBe("fail");
  });

  it("composites semi-transparent text before checking contrast", () => {
    const ir = screen(
      "s-alpha-text",
      "AlphaText",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [node("t", "text", { text: "Ghost", textColor: "#00000080" })],
      }),
    );

    const contrast = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("contrast"));
    expect(contrast).toHaveLength(1);
    expect(contrast[0]?.title).toContain("below WCAG AA");
  });

  it("composites semi-transparent backgrounds over ancestor backgrounds", () => {
    const ir = screen(
      "s-alpha-bg",
      "AlphaBg",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [
          node("panel", "container", {
            backgroundColor: "#00000080",
            children: [node("t", "text", { text: "White", textColor: "#ffffff" })],
          }),
        ],
      }),
    );

    const contrast = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("contrast"));
    expect(contrast).toHaveLength(1);
    expect(contrast[0]?.title).toContain("below WCAG AA");
  });

  // M2 ALPHA COMPOSITE DIRECTION — pins that compositing is `fg*alpha + bg*(1-alpha)`, not the
  // swapped form. Alpha=0.5 is symmetric so existing tests cannot distinguish direction. We use
  // black text at α=0x33/255≈0.2 (asymmetric) on a white background:
  //   correct: compositeChannel = round(0*0.2 + 255*0.8) = 204  → light grey → ratio ≈ 1.61:1 → FAIL
  //   swapped: compositeChannel = round(0*0.8 + 255*0.2) =  51  → dark grey  → ratio ≈ 12.63:1 → PASS
  // The title must contain "(1.61:1" and outcome must be "fail". Under the swapped formula the
  // composite would be dark instead of light → high contrast → "meets" → test fails. Mutation killed.
  it("composites alpha in the correct fg*α + bg*(1-α) direction — asymmetric α=0x33 [M2-pin]", () => {
    // textColor '#00000033': black at alpha 0x33/255 ≈ 0.200. Background: opaque white.
    // Correct composite: round(0*0.200 + 255*0.800) = 204 per channel → contrast ≈ 1.61:1 → below AA.
    const ir = screen(
      "s-alpha-dir",
      "AlphaDir",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [node("t", "text", { text: "Ghost2", textColor: "#00000033" })],
      }),
    );

    const contrast = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("contrast"));
    expect(contrast).toHaveLength(1);
    expect(contrast[0]?.title).toContain("below WCAG AA");
    // Pin the exact computed ratio so a swapped composite formula (giving 12.63:1) fails this assertion.
    expect(contrast[0]?.title).toContain("(1.61:1");
    expect(contrast[0]?.outcome).toBe("fail");
  });

  it("uses the WCAG AA large-text threshold when typography proves large text", () => {
    const ir = screen(
      "s-large",
      "Large",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [
          node("t", "text", {
            text: "Large",
            textColor: "#777777",
            typography: { fontFamily: "Inter", fontSize: 24, fontWeight: 400 },
          }),
        ],
      }),
    );

    const contrast = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("contrast"));
    expect(contrast).toHaveLength(1);
    expect(contrast[0]?.title).toContain("meets WCAG AA large text");
    expect(contrast[0]?.outcome).toBe("pass");
  });

  // M3 isLargeText BOLD BRANCH — pins the bold-large path (fontSize≥18.6667 && fontWeight≥700).
  // #1097 only tests the regular large-text path (fontSize≥24, fontWeight=400). Using #777 on #fff
  // (ratio≈4.48): below 4.5 normal-AA threshold, above 3.0 large-text AA threshold. This means the
  // pass/fail outcome distinguishes whether the bold-large branch activated. Three sub-cases:
  //   (a) 20px bold  → bold-large branch active  → "meets WCAG AA large text" / pass
  //   (b) 20px normal → bold-large branch INACTIVE → weight gate pins fontWeight≥700 → fail
  //   (c) 18px bold  → below LARGE_BOLD_TEXT_MIN_PX (18.6667) → px gate pins boundary → fail
  // Under M3 (widened weight gate 700→100), case (b) would wrongly activate → should be green test
  // that turns red. Under a lowered px constant, case (c) would also wrongly activate.
  it("activates bold-large-text threshold for fontSize 20 fontWeight 700 [M3-pin]", () => {
    const ir = screen(
      "s-bold-large",
      "BoldLarge",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [
          node("t", "text", {
            text: "Bold",
            textColor: "#777777",
            typography: { fontFamily: "Inter", fontSize: 20, fontWeight: 700 },
          }),
        ],
      }),
    );

    const contrast = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("contrast"));
    expect(contrast).toHaveLength(1);
    // Bold at 20px qualifies as large text → uses 3.0 threshold → 4.48 passes.
    expect(contrast[0]?.title).toContain("meets WCAG AA large text");
    expect(contrast[0]?.outcome).toBe("pass");
  });

  it("does NOT activate large-text threshold for fontSize 20 fontWeight 400 — pins weight gate [M3-pin]", () => {
    const ir = screen(
      "s-normal-20",
      "Normal20",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [
          node("t", "text", {
            text: "Normal",
            textColor: "#777777",
            typography: { fontFamily: "Inter", fontSize: 20, fontWeight: 400 },
          }),
        ],
      }),
    );

    const contrast = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("contrast"));
    expect(contrast).toHaveLength(1);
    // Regular weight at 20px does NOT qualify as large (20 < 24) → uses 4.5 threshold → 4.48 fails.
    // Under M3 (weight gate widened to 100), this would wrongly pass as large text.
    expect(contrast[0]?.title).toContain("below WCAG AA");
    expect(contrast[0]?.outcome).toBe("fail");
  });

  it("does NOT activate bold-large threshold for fontSize 18 fontWeight 700 — pins px gate [M3-pin]", () => {
    const ir = screen(
      "s-bold-18",
      "Bold18",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [
          node("t", "text", {
            text: "Bold18",
            textColor: "#777777",
            typography: { fontFamily: "Inter", fontSize: 18, fontWeight: 700 },
          }),
        ],
      }),
    );

    const contrast = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("contrast"));
    expect(contrast).toHaveLength(1);
    // 18px bold: 18 < 18.6667 (LARGE_BOLD_TEXT_MIN_PX) → NOT large text → 4.5 threshold → 4.48 fails.
    // Under a lowered px constant this would wrongly qualify as large text.
    expect(contrast[0]?.title).toContain("below WCAG AA");
    expect(contrast[0]?.outcome).toBe("fail");
  });

  it("resolves the background from the nearest ancestor that carries one", () => {
    const ir = screen(
      "s3",
      "Nested",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [
          node("mid", "container", {
            children: [node("t", "text", { text: "Deep", textColor: "#000000" })],
          }),
        ],
      }),
    );

    const contrast = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("contrast"));
    expect(contrast).toHaveLength(1);
    expect(contrast[0]?.title.toLowerCase()).toContain("meets");
  });

  it("emits a coverage notice (not a crash) when contrast cannot be computed", () => {
    const ir = screen(
      "s4",
      "NoBg",
      // Text colour present, but no ancestor background colour anywhere → uncomputable.
      node("root", "container", {
        children: [node("t", "text", { text: "Orphan", textColor: "#123456" })],
      }),
    );

    const items = itemsFor(ir);
    const notice = items.filter((i) => i.category === "coverage-notice");
    expect(notice).toHaveLength(1);
    expect(notice[0]?.title.toLowerCase()).toContain("contrast");
    expect(items.some((i) => i.title.toLowerCase().includes("meets"))).toBe(false);
  });

  it("emits a coverage notice when a text node has no resolvable text colour", () => {
    const ir = screen(
      "s-missing-fg",
      "MissingFg",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [node("t", "text", { text: "No fill" })],
      }),
    );

    const notice = itemsFor(ir).filter((i) => i.category === "coverage-notice");
    expect(notice).toHaveLength(1);
    expect(notice[0]?.title.toLowerCase()).toContain("contrast");
  });

  it("emits a coverage notice when the nearest background colour is malformed", () => {
    const ir = screen(
      "s-bad-bg",
      "BadBg",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [
          node("panel", "container", {
            backgroundColor: "not-a-color",
            children: [node("t", "text", { text: "Label", textColor: "#000000" })],
          }),
        ],
      }),
    );

    const notice = itemsFor(ir).filter((i) => i.category === "coverage-notice");
    expect(notice).toHaveLength(1);
    expect(notice[0]?.title.toLowerCase()).toContain("contrast");
  });

  it("emits a coverage notice when the text colour hex is malformed", () => {
    const ir = screen(
      "s5",
      "BadHex",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [node("t", "text", { text: "X", textColor: "not-a-color" })],
      }),
    );

    const notice = itemsFor(ir).filter((i) => i.category === "coverage-notice");
    expect(notice).toHaveLength(1);
  });
});

// ─── Accessible-name presence ────────────────────────────────────────────────────

describe("deriveA11yTestItemsByScreen — accessible names", () => {
  it("flags an interactive node with neither text nor a descriptive name", () => {
    const ir = screen(
      "s6",
      "Toolbar",
      node("root", "container", {
        children: [node("123:45", "button", { name: "123:45" })],
      }),
    );

    const names = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("accessible name"));
    expect(names).toHaveLength(1);
    expect(names[0]?.category).toBe("a11y");
    expect(names[0]?.title).toContain("needs an accessible name");
    expect(names[0]?.outcome).toBe("fail");
  });

  it("does not flag an interactive node that carries visible text", () => {
    const ir = screen(
      "s7",
      "Toolbar",
      node("root", "container", {
        children: [node("b", "button", { name: "b", text: "Save" })],
      }),
    );

    const names = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("accessible name"));
    expect(names).toHaveLength(0);
  });

  it("does not flag a non-interactive container with no name", () => {
    const ir = screen("s8", "Empty", node("99:1", "container", { name: "99:1" }));

    const names = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("accessible name"));
    expect(names).toHaveLength(0);
  });
});

// ─── Focus / reading order ───────────────────────────────────────────────────────

describe("deriveA11yTestItemsByScreen — focus order", () => {
  it("derives a reading-order item from bounding boxes (top-to-bottom, then left-to-right)", () => {
    const ir = screen(
      "s9",
      "Form",
      node("root", "container", {
        children: [
          node("bottom", "button", { text: "B", boundingBox: box(0, 100, 40, 40) }),
          node("top", "input", { text: "T", boundingBox: box(0, 0, 40, 40) }),
        ],
      }),
    );

    const order = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("focus order"));
    expect(order).toHaveLength(1);
    // The top element must be named before the bottom one in the asserted order.
    expect(order[0]?.title.indexOf("T")).toBeLessThan(order[0]?.title.indexOf("B") ?? -1);
    expect(order[0]?.outcome).toBe("expectation");
  });

  it("uses left-to-right order as the same-row tie-breaker", () => {
    const ir = screen(
      "s9b",
      "Toolbar",
      node("root", "container", {
        children: [
          node("right", "button", { text: "Right", boundingBox: box(100, 0, 40, 40) }),
          node("left", "button", { text: "Left", boundingBox: box(0, 0, 40, 40) }),
        ],
      }),
    );

    const order = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("focus order"));
    expect(order).toHaveLength(1);
    expect(order[0]?.title.indexOf("Left")).toBeLessThan(order[0]?.title.indexOf("Right") ?? -1);
  });

  it("does not derive a focus-order item with fewer than two boxed interactive nodes", () => {
    const ir = screen(
      "s10",
      "Single",
      node("root", "container", {
        children: [node("only", "button", { text: "Only", boundingBox: box(0, 0, 40, 40) })],
      }),
    );

    const order = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("focus order"));
    expect(order).toHaveLength(0);
  });

  it("emits a coverage notice for interactive controls without layout bounds", () => {
    const ir = screen(
      "s10b",
      "MixedBounds",
      node("root", "container", {
        children: [
          node("a", "button", { text: "A", boundingBox: box(0, 0, 40, 40) }),
          node("b", "button", { text: "B" }),
          node("c", "button", { text: "C", boundingBox: box(100, 0, 40, 40) }),
        ],
      }),
    );

    const items = itemsFor(ir);
    expect(
      items.filter((i) => i.category === "a11y" && i.title.toLowerCase().includes("focus order")),
    ).toHaveLength(1);
    const notice = items.filter((i) => i.category === "coverage-notice");
    expect(notice).toHaveLength(1);
    expect(notice[0]?.title).toContain("layout bounds");
  });
});

// ─── Minimum target size (WCAG 2.2 AA 2.5.8 — 24×24) ─────────────────────────────

describe("deriveA11yTestItemsByScreen — target size", () => {
  it("flags an interactive node smaller than 24×24", () => {
    const ir = screen(
      "s11",
      "Tiny",
      node("root", "container", {
        children: [node("x", "button", { text: "x", boundingBox: box(0, 0, 20, 20) })],
      }),
    );

    const target = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("target size"));
    expect(target).toHaveLength(1);
    expect(target[0]?.category).toBe("a11y");
    expect(target[0]?.title).toContain("does not meet");
    expect(target[0]?.outcome).toBe("fail");
  });

  it("does not flag an interactive node at or above 24×24", () => {
    const ir = screen(
      "s12",
      "Big",
      node("root", "container", {
        children: [node("x", "button", { text: "x", boundingBox: box(0, 0, 48, 48) })],
      }),
    );

    const target = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("target size"));
    expect(target).toHaveLength(0);
  });

  it("pins the 24×24 boundary and flags either axis below the minimum", () => {
    const ir = screen(
      "s12b",
      "Boundary",
      node("root", "container", {
        children: [
          node("ok", "button", { text: "OK", boundingBox: box(0, 0, 24, 24) }),
          node("narrow", "button", { text: "Narrow", boundingBox: box(0, 40, 23, 24) }),
          node("short", "button", { text: "Short", boundingBox: box(0, 80, 24, 23) }),
        ],
      }),
    );

    const target = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("target size"));
    expect(target.map((i) => i.title)).toEqual([
      'Control "Narrow" does not meet the 24×24 minimum target size',
      'Control "Short" does not meet the 24×24 minimum target size',
    ]);
  });
});

// ─── Image-fill alt-text expectation ─────────────────────────────────────────────

describe("deriveA11yTestItemsByScreen — image alt-text", () => {
  it("emits an alt-text expectation for a node with image fills", () => {
    const ir = screen(
      "s13",
      "Media",
      node("root", "container", {
        children: [node("img", "image", { imageFills: [{ imageRef: "abc" }] })],
      }),
    );

    const alt = itemsFor(ir).filter((i) => i.title.toLowerCase().includes("alt"));
    expect(alt).toHaveLength(1);
    expect(alt[0]?.category).toBe("a11y");
  });
});

// ─── Determinism + per-screen attribution ────────────────────────────────────────

describe("deriveA11yTestItemsByScreen — determinism + attribution", () => {
  const build = (): ScreenIr =>
    screen(
      "s14",
      "Mixed",
      node("root", "container", {
        backgroundColor: "#ffffff",
        children: [
          node("t", "text", { text: "Hi", textColor: "#000000" }),
          node("b", "button", { name: "b", boundingBox: box(0, 0, 20, 20) }),
          node("img", "image", { imageFills: [{ imageRef: "r" }] }),
        ],
      }),
    );

  it("is deterministic — the same IR yields a byte-identical result", () => {
    const first = deriveA11yTestItemsByScreen([build()]);
    const second = deriveA11yTestItemsByScreen([build()]);
    expect(JSON.stringify([...first])).toBe(JSON.stringify([...second]));
  });

  it("attributes every item to its origin screen", () => {
    const items = deriveA11yTestItemsByScreen([build()]).get("s14") ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.screenId === "s14" && i.screenName === "Mixed")).toBe(true);
    expect(items.every((i) => i.category === "a11y" || i.category === "coverage-notice")).toBe(
      true,
    );
  });

  it("produces no a11y items for an empty screen with no nodes of interest", () => {
    const ir = screen("s15", "Blank", node("root", "container"));
    expect(deriveA11yTestItemsByScreen([ir]).get("s15") ?? []).toHaveLength(0);
  });
});

// Resilience (#837 follow-on): deep-fetched real screens can carry thousands of TEXT nodes; the
// baseline must stay bounded with an honest coverage notice instead of an unbounded item list.
describe("deriveA11yTestItemsByScreen — per-screen item cap", () => {
  const manyTextScreen = (count: number): ScreenIr => {
    const children: IrNode[] = [];
    for (let i = 0; i < count; i += 1) {
      children.push(node(`t${String(i)}`, "text", { text: `t${String(i)}`, textColor: "#000000" }));
    }
    // The root carries a background so every TEXT child yields a contrast item.
    return screen(
      "big",
      "Big",
      node("root", "container", { backgroundColor: "#ffffff", children }),
    );
  };

  it("caps a pathologically dense screen at 800 items + one coverage notice", () => {
    const items = deriveA11yTestItemsByScreen([manyTextScreen(900)]).get("big") ?? [];
    expect(items).toHaveLength(801);
    const notice = items[items.length - 1];
    expect(notice?.category).toBe("coverage-notice");
    expect(notice?.title).toContain("additional checks were omitted");
  });

  it("does not cap a screen under the limit (no spurious notice)", () => {
    const items = deriveA11yTestItemsByScreen([manyTextScreen(10)]).get("big") ?? [];
    expect(items.length).toBeLessThan(800);
    expect(items.some((i) => i.title.includes("additional checks were omitted"))).toBe(false);
  });

  it("remains deterministic at the cap boundary", () => {
    const a = deriveA11yTestItemsByScreen([manyTextScreen(900)]).get("big") ?? [];
    const b = deriveA11yTestItemsByScreen([manyTextScreen(900)]).get("big") ?? [];
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
