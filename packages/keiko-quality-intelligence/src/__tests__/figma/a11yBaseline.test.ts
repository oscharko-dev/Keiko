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
  ...(over.text !== undefined ? { text: over.text } : {}),
  ...(over.boundingBox !== undefined ? { boundingBox: over.boundingBox } : {}),
  ...(over.textColor !== undefined ? { textColor: over.textColor } : {}),
  ...(over.backgroundColor !== undefined ? { backgroundColor: over.backgroundColor } : {}),
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

const itemsFor = (s: ScreenIr): readonly { category: string; title: string }[] => {
  const byScreen = deriveA11yTestItemsByScreen([s]);
  return (byScreen.get(s.id) ?? []).map((i) => ({ category: i.category, title: i.title }));
};

// ─── WCAG relative luminance + contrast ratio ────────────────────────────────────

describe("relativeLuminance", () => {
  it("computes 0 for black and 1 for white", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 10);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 10);
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
