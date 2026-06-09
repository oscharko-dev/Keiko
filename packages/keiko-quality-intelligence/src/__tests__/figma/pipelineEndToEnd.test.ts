// End-to-end synthetic integration test for the Figma pipeline (Epic #750, Issue #757).
//
// Pure domain — no IO, no model, no Date, no Figma, no network. Synthetic fixtures ONLY: this file
// never embeds, references, or links any real or customer board content (per the epic's Customer
// Data Governance invariant). The board below is invented and structurally generic.
//
// Where the per-stage unit tests (cleanToScreenIr / navGraph / a11yBaseline / screenIrTestBaseline /
// designToCode) each prove ONE stage in isolation, this test proves the FULL pipeline COMPOSITION on
// a single synthetic board, driving a raw scoped Figma node tree through every deterministic stage:
//
//   raw FigmaSourceNode tree
//     → cleanScopedNodesToScreenIr            (#752: prune → IR + design tokens + inter-screen links)
//     → deriveNavGraph / deriveNavTestItemsByScreen   (#811: navigation/flow graph + nav tests)
//     → deriveA11yTestItemsByScreen            (#812: model-free a11y baseline from IR colours/boxes)
//     → deriveScreenTestBaseline(..., extraItems)      (#754: structural baseline + #811/#812 seam)
//     → emitCode(htmlCssAdapter)               (#755: deterministic code + tokens.css)
//
// The synthetic board is deliberately INSTANCE/FRAME-heavy AND carries proper in-screen data (TEXT
// nodes with `characters` + solid text fills, an interactive node, an image fill, bounding boxes, and
// a wired inter-screen prototype link). The live verification (docs/quality-intelligence/757-figma-
// pipeline-verification.md) found that on instance-heavy customer boards the meaningful TEXT lives
// BELOW the depth-4 scoped fetch, so the IR was text-sparse and the a11y/nav DERIVATIONS were
// under-fed (a11yTests=0, navEdges=0). This test FEEDS the derivations a properly-shaped IR and
// asserts they FIRE — isolating that live gap to the fetch depth vs the 5000-node oversize guard,
// NOT to the derivation logic, which is correct-by-construction.
//
// Assertions: reduction reported; screens detected; design tokens extracted AND referenced in
// tokens.css; nav edges + nav tests produced from the link; a11y items produced (contrast +
// alt-text + accessible-name); codegen emits well-formed files; and a re-run is byte-identical
// (deterministic, model-free — no model is invoked anywhere in the pipeline).

import { describe, expect, it } from "vitest";

import {
  cleanScopedNodesToScreenIr,
  deriveNavGraph,
  deriveNavTestItemsByScreen,
  deriveA11yTestItemsByScreen,
  deriveScreenTestBaseline,
  emitCode,
  htmlCssAdapter,
  type ScreenTestBaseline,
  type StructuralTestItem,
} from "../../domain/figma/index.js";
import type { CodeArtifact } from "../../domain/figma/index.js";
import type { FigmaSourceNode } from "../../domain/figma/sourceNode.js";

// ─── Synthetic raw-Figma fixture builders (never any real board content) ─────────

const bbox = (x: number, y: number, w: number, h: number): Record<string, unknown> => ({
  x,
  y,
  width: w,
  height: h,
});

const solidFill = (r: number, g: number, b: number, a = 1): Record<string, unknown> => ({
  type: "SOLID",
  color: { r, g, b, a },
});

const imageFill = (imageRef: string): Record<string, unknown> => ({ type: "IMAGE", imageRef });

const text = (
  id: string,
  characters: string,
  extra: Record<string, unknown> = {},
): FigmaSourceNode => ({
  id,
  name: characters,
  type: "TEXT",
  characters,
  absoluteBoundingBox: bbox(0, 0, 200, 24),
  style: { fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeightPx: 24 },
  ...extra,
});

// A component INSTANCE: the heavy node type on real enterprise boards. INSTANCEs survive pruning
// (only COMPONENT/COMPONENT_SET masters are dropped), so nesting in-screen data under them mirrors a
// real instance-heavy board while still carrying the data the IR needs.
const instance = (
  id: string,
  name: string,
  children: readonly FigmaSourceNode[],
  extra: Record<string, unknown> = {},
): FigmaSourceNode => ({
  id,
  name,
  type: "INSTANCE",
  componentId: "comp:1",
  absoluteBoundingBox: bbox(0, 0, 320, 200),
  fills: [solidFill(1, 1, 1)],
  children,
  ...extra,
});

const screenFrame = (
  id: string,
  name: string,
  children: readonly FigmaSourceNode[],
  extra: Record<string, unknown> = {},
): FigmaSourceNode => ({
  id,
  name,
  type: "FRAME",
  absoluteBoundingBox: bbox(0, 0, 375, 812),
  fills: [solidFill(1, 1, 1)],
  children,
  ...extra,
});

const canvas = (
  children: readonly FigmaSourceNode[],
  extra: Record<string, unknown> = {},
): FigmaSourceNode => ({
  id: "0:1",
  name: "Page 1",
  type: "CANVAS",
  children,
  ...extra,
});

// A generic two-screen board, deliberately INSTANCE/FRAME-heavy with proper in-screen data:
//
//   Login screen (1:1)
//     ├─ card INSTANCE (1:10)            ← white background, holds the deep in-screen text
//     │    ├─ "Sign in to continue" TEXT (1:11, black fill on white) → contrast a11y item FIRES
//     │    └─ email field INSTANCE (1:12, opaque-id name, no text) → accessible-name a11y item FIRES
//     ├─ submit INSTANCE (1:20, opaque-id name, ON_CLICK → Home root) → link hint + inter-screen link
//     └─ hero RECTANGLE (1:30, image fill) → alt-text a11y item FIRES
//
//   Home screen (2:1)
//     └─ welcome INSTANCE (2:10) wrapping "Welcome back" TEXT (2:11)
//
// The submit's interaction wires the only prototype link; deriveNavGraph turns it into ONE edge and
// deriveNavTestItemsByScreen into a navigation test on the Login screen.
const syntheticBoard = (): FigmaSourceNode =>
  canvas([
    screenFrame("1:1", "Login", [
      instance("1:10", "Card", [
        // Black text on the card's white instance background → resolvable, deterministic contrast.
        text("1:11", "Sign in to continue", { fills: [solidFill(0, 0, 0)] }),
        // A plain non-interactive sub-frame holding more in-screen structure (instance-heavy depth).
        instance("1:12", "Field row", [text("1:13", "Email")]),
      ]),
      // The single navigating node: an OPAQUE id-style name, no visible text, wired to the Home
      // screen root (2:1). It produces BOTH the only inter-screen prototype link → nav edge (#811)
      // AND, being interactive with no accessible name, the accessible-name a11y item (#812).
      instance("1:20", "1:20", [], {
        absoluteBoundingBox: bbox(0, 700, 320, 48),
        fills: [solidFill(0.1, 0.3, 0.8)],
        interactions: [
          {
            trigger: { type: "ON_CLICK" },
            actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: "2:1" }],
          },
        ],
      }),
      // Image-fill node → alt-text a11y item.
      {
        id: "1:30",
        name: "Hero illustration",
        type: "RECTANGLE",
        absoluteBoundingBox: bbox(0, 100, 375, 200),
        fills: [imageFill("hero-ref")],
      },
    ]),
    screenFrame("2:1", "Home", [instance("2:10", "Welcome card", [text("2:11", "Welcome back")])]),
  ]);

// ─── Pipeline driver: raw nodes → IR → derivations → baseline → code ─────────────

interface PipelineOutput {
  readonly reductionRatio: number;
  readonly screenIds: readonly string[];
  readonly navEdgeCount: number;
  readonly navItems: readonly StructuralTestItem[];
  readonly a11yItems: readonly StructuralTestItem[];
  readonly baselines: readonly ScreenTestBaseline[];
  readonly artifact: CodeArtifact;
}

const runPipeline = (root: FigmaSourceNode): PipelineOutput => {
  const ir = cleanScopedNodesToScreenIr(root);

  const graph = deriveNavGraph(ir);
  const navByScreen = deriveNavTestItemsByScreen(graph);
  const a11yByScreen = deriveA11yTestItemsByScreen(ir.screens);

  const baselines = ir.screens.map((screen) =>
    deriveScreenTestBaseline(screen, [
      ...(navByScreen.get(screen.id) ?? []),
      ...(a11yByScreen.get(screen.id) ?? []),
    ]),
  );

  const hints = graph.nodes.map((node) => ({
    screenId: node.screenId,
    transitions: graph.edges
      .filter((edge) => edge.fromScreenId === node.screenId)
      .map((edge) => ({ trigger: edge.trigger, toScreenId: edge.toScreenId })),
  }));

  const artifact = emitCode({ screens: ir.screens, tokens: ir.tokens, hints }, htmlCssAdapter);

  return {
    reductionRatio: ir.reduction.removedRatio,
    screenIds: ir.screens.map((screen) => screen.id),
    navEdgeCount: graph.edges.length,
    navItems: [...navByScreen.values()].flatMap((items) => [...items]),
    a11yItems: [...a11yByScreen.values()].flatMap((items) => [...items]),
    baselines,
    artifact,
  };
};

const fileByPath = (artifact: CodeArtifact, path: string): string => {
  const file = artifact.files.find((f) => f.path === path);
  if (file === undefined)
    throw new Error(`expected file ${path}; got ${artifact.files.map((f) => f.path).join(", ")}`);
  return file.contents;
};

// ─── End-to-end composition ──────────────────────────────────────────────────────

describe("Figma pipeline end-to-end (synthetic board, #757)", () => {
  it("reports a noise-reduction ratio for the scoped board", () => {
    const out = runPipeline(syntheticBoard());
    // The canvas scope container is dropped, so some reduction is always reported.
    expect(out.reductionRatio).toBeGreaterThan(0);
    expect(out.reductionRatio).toBeLessThanOrEqual(1);
  });

  it("detects the two screens (stable id order)", () => {
    const out = runPipeline(syntheticBoard());
    expect(out.screenIds).toEqual(["1:1", "2:1"]);
  });

  it("extracts design tokens and references them in the emitted tokens.css", () => {
    const out = runPipeline(syntheticBoard());
    const ir = cleanScopedNodesToScreenIr(syntheticBoard());

    // Tokens are extracted deterministically from the IR (#752).
    expect(ir.tokens.colors.length).toBeGreaterThan(0);
    expect(ir.tokens.typography.length).toBeGreaterThan(0);

    // …and consumed by code-gen (#755): the generated tokens.css references the extracted values,
    // proving design tokens flow end to end rather than being re-derived or hard-coded.
    const css = fileByPath(out.artifact, "tokens.css");
    expect(css).toContain(":root {");
    for (const color of ir.tokens.colors) expect(css).toContain(color.value);
    expect(css).toContain("Inter");
    expect(css).toMatch(/--color-[a-z0-9-]+:\s*#[0-9a-f]{6}/u);
  });

  it("derives a navigation edge and navigation test item from the wired prototype link (#811)", () => {
    const out = runPipeline(syntheticBoard());
    // The single ON_CLICK link (submit 1:20 → Home root 2:1) resolves to exactly one screen edge.
    expect(out.navEdgeCount).toBe(1);
    const navigation = out.navItems.filter((item) => item.category === "navigation");
    expect(navigation).toHaveLength(1);
    expect(navigation[0]?.screenId).toBe("1:1");
    expect(navigation[0]?.title).toContain("ON_CLICK");
  });

  it("derives a11y items — contrast, alt-text, and accessible-name — model-free (#812)", () => {
    const out = runPipeline(syntheticBoard());
    const titles = out.a11yItems.map((item) => item.title);

    // Contrast: black "Sign in to continue" on the card's white background resolves to an exact AA
    // verdict computed from the extracted colours.
    const contrast = out.a11yItems.find((item) => item.title.includes("colour contrast"));
    expect(contrast).toBeDefined();
    expect(contrast?.category).toBe("a11y");

    // Alt-text: the image-fill hero node yields an alt-text expectation.
    expect(titles.some((t) => t.includes("alt text"))).toBe(true);

    // Accessible-name: the opaque-id-named interactive nodes (no visible text) yield an
    // accessible-name expectation. This is the item that was 0 on the live instance-heavy boards
    // because the in-screen interactive nodes sat below the scoped-fetch depth.
    expect(titles.some((t) => t.includes("accessible name"))).toBe(true);
  });

  it("composes nav + a11y items into the per-screen structural baseline (#754 extraItems seam)", () => {
    const out = runPipeline(syntheticBoard());
    const login = out.baselines.find((b) => b.screenId === "1:1");
    expect(login).toBeDefined();
    const categories = new Set(login?.items.map((item) => item.category));
    // The deterministic structural baseline always emits a screen-render item…
    expect(categories.has("screen-render")).toBe(true);
    // …and the additive seam folds in BOTH the #811 navigation and #812 a11y items.
    expect(categories.has("navigation")).toBe(true);
    expect(categories.has("a11y")).toBe(true);
  });

  it("emits well-formed per-screen HTML, a token stylesheet, and an index — with nav scaffolding", () => {
    const out = runPipeline(syntheticBoard());

    const loginHtml = fileByPath(out.artifact, "screens/1:1.html");
    expect(loginHtml.trim().startsWith("<!doctype html>")).toBe(true);
    expect(loginHtml).toMatch(/<html[^>]*>[\s\S]*<\/html>/u);
    expect(loginHtml).toContain("</body>");
    // The login screen's in-screen text survives end to end into the emitted code.
    expect(loginHtml).toContain("Sign in to continue");
    // The wired link becomes framework-agnostic nav scaffolding to the Home screen (no router words).
    expect(loginHtml).toMatch(/<nav[^>]*>/u);
    expect(loginHtml).toContain('href="2:1.html"');
    expect(loginHtml.toLowerCase()).not.toContain("router");

    const index = fileByPath(out.artifact, "index.html");
    expect(index).toContain('href="screens/1:1.html"');
    expect(index).toContain('href="screens/2:1.html"');

    expect(out.artifact.adapterName).toBe(htmlCssAdapter.name);
  });

  it("is byte-identical on a re-run (deterministic, model-free — no model invoked)", () => {
    const first = runPipeline(syntheticBoard());
    const second = runPipeline(syntheticBoard());
    // Guard against a vacuously-equal empty pipeline: the run must have produced real work.
    expect(first.artifact.files.length).toBeGreaterThan(0);
    expect(first.navItems.length).toBeGreaterThan(0);
    expect(first.a11yItems.length).toBeGreaterThan(0);
    // Whole-artifact byte equality proves the structural pipeline carries no timestamp, no random
    // ordering, and no model: the same stored snapshot re-emits identically (epic determinism DoD).
    expect(JSON.stringify(first.artifact)).toBe(JSON.stringify(second.artifact));
    expect(JSON.stringify(first.baselines)).toBe(JSON.stringify(second.baselines));
    expect(first.navItems).toEqual(second.navItems);
    expect(first.a11yItems).toEqual(second.a11yItems);
  });

  it("runs the SAME code path on a structurally different synthetic board (GENERIC, no tuning)", () => {
    // A second board with different screen count, names, depth, and a different link shape. No rule,
    // threshold, name, or template is tuned to either board — the pipeline must just work.
    const other = canvas([
      screenFrame("9:1", "Catalog", [
        instance("9:10", "Row", [text("9:11", "Browse products", { fills: [solidFill(0, 0, 0)] })]),
        instance("9:20", "9:20", [], {
          absoluteBoundingBox: bbox(0, 600, 300, 40),
          fills: [solidFill(0.2, 0.2, 0.2)],
          interactions: [
            {
              trigger: { type: "ON_CLICK" },
              actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: "8:1" }],
            },
          ],
        }),
      ]),
      screenFrame("8:1", "Detail", [instance("8:10", "Header", [text("8:11", "Product detail")])]),
      screenFrame("7:1", "Cart", [instance("7:10", "Summary", [text("7:11", "Your cart")])]),
    ]);

    const out = runPipeline(other);
    expect(out.screenIds).toEqual(["7:1", "8:1", "9:1"]);
    expect(out.navEdgeCount).toBe(1);
    expect(out.navItems.some((item) => item.category === "navigation")).toBe(true);
    expect(out.a11yItems.some((item) => item.title.includes("colour contrast"))).toBe(true);
    // Code is emitted for every detected screen plus the shared token + index files.
    const screenFiles = out.artifact.files.filter((f) => f.path.startsWith("screens/"));
    expect(screenFiles).toHaveLength(3);
  });
});
