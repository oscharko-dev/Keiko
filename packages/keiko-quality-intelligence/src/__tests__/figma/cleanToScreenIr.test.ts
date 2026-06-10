// Unit tests for cleanScopedNodesToScreenIr (Epic #750, Issue #752).
// Pure transform — no IO. Synthetic Figma-node fixtures only; never any real board content.

import { describe, expect, it } from "vitest";

import { cleanScopedNodesToScreenIr } from "../../domain/figma/cleanToScreenIr.js";
import type { FigmaSourceNode } from "../../domain/figma/sourceNode.js";
import type { IrNode, ScreenIr } from "../../domain/figma/irTypes.js";

// ─── Fixture builders ──────────────────────────────────────────────────────────

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

const imageFill = (imageRef: string): Record<string, unknown> => ({
  type: "IMAGE",
  imageRef,
});

const text = (
  id: string,
  characters: string,
  style?: Record<string, unknown>,
): FigmaSourceNode => ({
  id,
  name: characters,
  type: "TEXT",
  characters,
  absoluteBoundingBox: bbox(0, 0, 100, 20),
  ...(style !== undefined ? { style } : {}),
});

const frame = (
  id: string,
  name: string,
  children: readonly FigmaSourceNode[],
  extra: Record<string, unknown> = {},
): FigmaSourceNode => ({
  id,
  name,
  type: "FRAME",
  absoluteBoundingBox: bbox(0, 0, 375, 812),
  children,
  ...extra,
});

const screenFrame = (
  id: string,
  name: string,
  children: readonly FigmaSourceNode[],
  extra: Record<string, unknown> = {},
): FigmaSourceNode => frame(id, name, children, extra);

const canvas = (
  id: string,
  children: readonly FigmaSourceNode[],
  extra: Record<string, unknown> = {},
): FigmaSourceNode => ({
  id,
  name: "Page 1",
  type: "CANVAS",
  children,
  ...extra,
});

const findIrNode = (node: IrNode, id: string): IrNode | undefined => {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findIrNode(child, id);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

const allIds = (node: IrNode): string[] => [node.id, ...node.children.flatMap(allIds)];

const screenById = (screens: readonly ScreenIr[], id: string): ScreenIr => {
  const hit = screens.find((s) => s.id === id);
  if (hit === undefined) throw new Error(`screen ${id} not found`);
  return hit;
};

// ─── Pruning ────────────────────────────────────────────────────────────────────

describe("cleanScopedNodesToScreenIr — pruning", () => {
  it("drops a visible:false subtree and all its descendants", () => {
    const screen = screenFrame("1:1", "Home", [
      text("1:2", "Visible"),
      frame("1:3", "Hidden group", [text("1:4", "Nested hidden")], { visible: false }),
    ]);
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [screen]));

    const ir = screenById(result.screens, "1:1");
    const ids = allIds(ir.root);
    expect(ids).toContain("1:2");
    expect(ids).not.toContain("1:3");
    expect(ids).not.toContain("1:4");
  });

  it("drops COMPONENT and COMPONENT_SET masters but keeps INSTANCE nodes", () => {
    const master: FigmaSourceNode = {
      id: "9:1",
      name: "Button/Master",
      type: "COMPONENT",
      absoluteBoundingBox: bbox(0, 0, 80, 40),
    };
    const masterSet: FigmaSourceNode = {
      id: "9:2",
      name: "Button/Set",
      type: "COMPONENT_SET",
      absoluteBoundingBox: bbox(0, 0, 80, 40),
    };
    const instance: FigmaSourceNode = {
      id: "1:5",
      name: "Primary",
      type: "INSTANCE",
      componentId: "9:1",
      absoluteBoundingBox: bbox(0, 0, 80, 40),
      fills: [solidFill(0.1, 0.2, 0.3)],
    };
    const screen = screenFrame("1:1", "Home", [master, masterSet, instance]);
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [screen]));

    const ids = allIds(screenById(result.screens, "1:1").root);
    expect(ids).not.toContain("9:1");
    expect(ids).not.toContain("9:2");
    expect(ids).toContain("1:5");
  });

  it("drops empty scaffold nodes that carry no render payload and no kept descendants", () => {
    const scaffold: FigmaSourceNode = { id: "1:9", name: "marker", type: "FRAME", children: [] };
    const screen = screenFrame("1:1", "Home", [text("1:2", "Keep"), scaffold]);
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [screen]));

    const ids = allIds(screenById(result.screens, "1:1").root);
    expect(ids).toContain("1:2");
    expect(ids).not.toContain("1:9");
  });
});

// ─── Screen detection ─────────────────────────────────────────────────────────

describe("cleanScopedNodesToScreenIr — screen detection", () => {
  it("detects multiple top-level frames as separate screens", () => {
    const a = screenFrame("1:1", "Login", [text("1:2", "Sign in")]);
    const b = screenFrame("2:1", "Dashboard", [text("2:2", "Overview")]);
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [a, b]));

    expect(result.screens.map((s) => s.id)).toEqual(["1:1", "2:1"]);
  });

  it("treats a root frame with no frame children as a single screen", () => {
    const root = screenFrame("1:1", "Solo", [text("1:2", "Body")]);
    const result = cleanScopedNodesToScreenIr(root);

    expect(result.screens.map((s) => s.id)).toEqual(["1:1"]);
  });

  it("yields an empty node body for a screen with no children", () => {
    const empty = screenFrame("1:1", "Empty", []);
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [empty]));

    expect(result.screens).toHaveLength(1);
    expect(screenById(result.screens, "1:1").root.children).toEqual([]);
  });

  it("descends through a SECTION to find screen frames", () => {
    const section: FigmaSourceNode = {
      id: "s:1",
      name: "Release",
      type: "SECTION",
      children: [screenFrame("1:1", "A", [text("1:2", "x")])],
    };
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [section]));

    expect(result.screens.map((s) => s.id)).toEqual(["1:1"]);
  });
});

// ─── Design tokens ───────────────────────────────────────────────────────────

describe("cleanScopedNodesToScreenIr — design tokens", () => {
  it("extracts and dedupes a solid fill colour shared by two nodes", () => {
    const a: FigmaSourceNode = {
      id: "1:2",
      name: "Box A",
      type: "RECTANGLE",
      absoluteBoundingBox: bbox(0, 0, 10, 10),
      fills: [solidFill(0.1, 0.2, 0.3)],
    };
    const b: FigmaSourceNode = {
      id: "1:3",
      name: "Box B",
      type: "RECTANGLE",
      absoluteBoundingBox: bbox(0, 0, 10, 10),
      fills: [solidFill(0.1, 0.2, 0.3)],
    };
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [screenFrame("1:1", "S", [a, b])]));

    expect(result.tokens.colors).toHaveLength(1);
    expect(result.tokens.colors[0]?.value).toBe("#1a334d");
  });

  it("extracts an alpha colour as #RRGGBBAA", () => {
    const a: FigmaSourceNode = {
      id: "1:2",
      name: "Box",
      type: "RECTANGLE",
      absoluteBoundingBox: bbox(0, 0, 10, 10),
      fills: [solidFill(1, 1, 1, 0.5)],
    };
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [screenFrame("1:1", "S", [a])]));

    expect(result.tokens.colors[0]?.value).toBe("#ffffff80");
  });

  it("extracts typography tokens from TEXT style", () => {
    const t = text("1:2", "Hi", {
      fontFamily: "Inter",
      fontSize: 16,
      fontWeight: 600,
      lineHeightPx: 24,
    });
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [screenFrame("1:1", "S", [t])]));

    expect(result.tokens.typography).toEqual([
      {
        id: "typography:Inter|16|600|24",
        kind: "typography",
        fontFamily: "Inter",
        fontSize: 16,
        fontWeight: 600,
        lineHeight: 24,
      },
    ]);
  });

  it("extracts spacing tokens from itemSpacing and padding, deduped", () => {
    const screen = screenFrame("1:1", "S", [text("1:2", "x")], {
      layoutMode: "VERTICAL",
      itemSpacing: 8,
      paddingTop: 8,
      paddingLeft: 16,
    });
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [screen]));

    expect(result.tokens.spacing.map((s) => s.value)).toEqual([8, 16]);
  });

  it("extracts radius tokens from cornerRadius", () => {
    const screen = screenFrame("1:1", "S", [text("1:2", "x")], { cornerRadius: 12 });
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [screen]));

    expect(result.tokens.radius.map((r) => r.value)).toEqual([12]);
  });

  it("ignores hidden nodes when extracting tokens", () => {
    const hidden: FigmaSourceNode = {
      id: "1:3",
      name: "Hidden",
      type: "RECTANGLE",
      visible: false,
      fills: [solidFill(0.9, 0.9, 0.9)],
    };
    const result = cleanScopedNodesToScreenIr(
      canvas("0:1", [screenFrame("1:1", "S", [text("1:2", "x"), hidden])]),
    );

    expect(result.tokens.colors).toEqual([]);
  });
});

// ─── Inter-screen links ─────────────────────────────────────────────────────────

describe("cleanScopedNodesToScreenIr — inter-screen links", () => {
  it("extracts a link from interactions[].actions[] with a destination", () => {
    const button: FigmaSourceNode = {
      id: "1:2",
      name: "Go",
      type: "INSTANCE",
      absoluteBoundingBox: bbox(0, 0, 80, 40),
      fills: [solidFill(0, 0, 0)],
      interactions: [
        {
          trigger: { type: "ON_CLICK" },
          actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: "2:1" }],
        },
      ],
    };
    const result = cleanScopedNodesToScreenIr(
      canvas("0:1", [
        screenFrame("1:1", "A", [button]),
        screenFrame("2:1", "B", [text("2:2", "y")]),
      ]),
    );

    expect(result.links).toEqual([
      { sourceNodeId: "1:2", trigger: "ON_CLICK", targetNodeId: "2:1" },
    ]);
  });

  it("tolerates the legacy reactions field", () => {
    const button: FigmaSourceNode = {
      id: "1:2",
      name: "Go",
      type: "INSTANCE",
      absoluteBoundingBox: bbox(0, 0, 80, 40),
      fills: [solidFill(0, 0, 0)],
      reactions: [
        { trigger: { type: "ON_PRESS" }, action: { type: "NODE", destinationId: "2:1" } },
      ],
    };
    const result = cleanScopedNodesToScreenIr(
      canvas("0:1", [
        screenFrame("1:1", "A", [button]),
        screenFrame("2:1", "B", [text("2:2", "y")]),
      ]),
    );

    expect(result.links).toEqual([
      { sourceNodeId: "1:2", trigger: "ON_PRESS", targetNodeId: "2:1" },
    ]);
  });

  it("extracts a FLOW_START link from canvas flowStartingPoints", () => {
    const result = cleanScopedNodesToScreenIr(
      canvas("0:1", [screenFrame("1:1", "A", [text("1:2", "x")])], {
        flowStartingPoints: [{ nodeId: "1:1", name: "Flow 1" }],
      }),
    );

    expect(result.links).toContainEqual({
      sourceNodeId: "0:1",
      trigger: "FLOW_START",
      targetNodeId: "1:1",
    });
  });

  it("extracts a FLOW_START link from prototypeStartNodeID", () => {
    const result = cleanScopedNodesToScreenIr(
      canvas("0:1", [screenFrame("1:1", "A", [text("1:2", "x")])], { prototypeStartNodeID: "1:1" }),
    );

    expect(result.links).toContainEqual({
      sourceNodeId: "0:1",
      trigger: "FLOW_START",
      targetNodeId: "1:1",
    });
  });

  it("emits no links when interactions are absent", () => {
    const result = cleanScopedNodesToScreenIr(
      canvas("0:1", [screenFrame("1:1", "A", [text("1:2", "x")])]),
    );
    expect(result.links).toEqual([]);
  });
});

// ─── Interaction hints ───────────────────────────────────────────────────────

describe("cleanScopedNodesToScreenIr — interaction hints", () => {
  const hintFor = (node: FigmaSourceNode): string => {
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [screenFrame("1:1", "S", [node])]));
    const ir = findIrNode(screenById(result.screens, "1:1").root, String(node.id));
    return ir?.interactionHint ?? "missing";
  };

  it("classifies a TEXT node as text", () => {
    expect(hintFor(text("1:2", "Label"))).toBe("text");
  });

  it("classifies an image-fill node as image", () => {
    expect(
      hintFor({
        id: "1:2",
        name: "Hero",
        type: "RECTANGLE",
        absoluteBoundingBox: bbox(0, 0, 10, 10),
        fills: [imageFill("img1")],
      }),
    ).toBe("image");
  });

  it("classifies a navigating node as link", () => {
    expect(
      hintFor({
        id: "1:2",
        name: "Plain frame",
        type: "FRAME",
        absoluteBoundingBox: bbox(0, 0, 10, 10),
        fills: [solidFill(0, 0, 0)],
        interactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ destinationId: "2:1" }] }],
      }),
    ).toBe("link");
  });

  it("classifies by the generic button role word in the name", () => {
    expect(
      hintFor({
        id: "1:2",
        name: "Submit Button",
        type: "FRAME",
        absoluteBoundingBox: bbox(0, 0, 10, 10),
        fills: [solidFill(0, 0, 0)],
      }),
    ).toBe("button");
  });

  it("classifies by the generic input role word in the name", () => {
    expect(
      hintFor({
        id: "1:2",
        name: "Email Field",
        type: "FRAME",
        absoluteBoundingBox: bbox(0, 0, 10, 10),
        fills: [solidFill(0, 0, 0)],
      }),
    ).toBe("input");
  });

  it("does not match a role word that is only a substring of another word", () => {
    expect(
      hintFor({
        id: "1:2",
        name: "Buttonhole illustration",
        type: "FRAME",
        absoluteBoundingBox: bbox(0, 0, 10, 10),
        fills: [solidFill(0, 0, 0)],
      }),
    ).toBe("container");
  });

  it("falls back to container for a plain frame with no role words", () => {
    expect(
      hintFor({
        id: "1:2",
        name: "Wrapper",
        type: "FRAME",
        absoluteBoundingBox: bbox(0, 0, 10, 10),
        fills: [solidFill(0, 0, 0)],
      }),
    ).toBe("container");
  });
});

// ─── Reduction ratio ─────────────────────────────────────────────────────────

describe("cleanScopedNodesToScreenIr — reduction ratio", () => {
  it("reports input, kept, removed counts and ratio", () => {
    const screen = screenFrame("1:1", "S", [
      text("1:2", "Keep"),
      frame("1:3", "Hidden", [text("1:4", "x")], { visible: false }),
    ]);
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [screen]));

    // input: canvas + screen + text + hidden-frame + nested-text = 5
    expect(result.reduction.inputNodeCount).toBe(5);
    // kept: screen + text = 2 (canvas is the scope container, not a kept IR node)
    expect(result.reduction.keptNodeCount).toBe(2);
    expect(result.reduction.removedNodeCount).toBe(3);
    expect(result.reduction.removedRatio).toBeCloseTo(0.6, 5);
  });

  it("reports full removal for an empty canvas (the scope container is dropped)", () => {
    const result = cleanScopedNodesToScreenIr(canvas("0:1", []));
    expect(result.reduction.inputNodeCount).toBe(1);
    expect(result.reduction.keptNodeCount).toBe(0);
    expect(result.reduction.removedNodeCount).toBe(1);
    expect(result.reduction.removedRatio).toBe(1);
    expect(result.screens).toEqual([]);
  });

  it("degrades a malformed (non-object) root to an empty result with a zero ratio, no throw", () => {
    const result = cleanScopedNodesToScreenIr(null);
    expect(result.reduction.inputNodeCount).toBe(0);
    expect(result.reduction.keptNodeCount).toBe(0);
    expect(result.reduction.removedRatio).toBe(0);
    expect(result.screens).toEqual([]);
    expect(result.tokens).toEqual({ colors: [], typography: [], spacing: [], radius: [] });
    expect(result.links).toEqual([]);
  });
});

// ─── Normalization payload ───────────────────────────────────────────────────

describe("cleanScopedNodesToScreenIr — node normalization", () => {
  it("carries text content, bounding box, and image fills onto IR nodes", () => {
    const img: FigmaSourceNode = {
      id: "1:3",
      name: "Pic",
      type: "RECTANGLE",
      absoluteBoundingBox: bbox(5, 6, 30, 40),
      fills: [imageFill("ref-xyz")],
    };
    const result = cleanScopedNodesToScreenIr(
      canvas("0:1", [screenFrame("1:1", "S", [text("1:2", "Hello"), img])]),
    );

    const root = screenById(result.screens, "1:1").root;
    const t = findIrNode(root, "1:2");
    expect(t?.text).toBe("Hello");
    const pic = findIrNode(root, "1:3");
    expect(pic?.boundingBox).toEqual({ x: 5, y: 6, width: 30, height: 40 });
    expect(pic?.imageFills).toEqual([{ imageRef: "ref-xyz" }]);
  });

  it("omits text/boundingBox when absent and tolerates a malformed child", () => {
    const screen: FigmaSourceNode = {
      id: "1:1",
      name: "S",
      type: "FRAME",
      children: [text("1:2", "x"), 42 as unknown, null as unknown],
    };
    const result = cleanScopedNodesToScreenIr(canvas("0:1", [screen]));

    const root = screenById(result.screens, "1:1").root;
    expect(root.boundingBox).toBeUndefined();
    expect(root.text).toBeUndefined();
    expect(allIds(root)).toEqual(["1:1", "1:2"]);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe("cleanScopedNodesToScreenIr — determinism", () => {
  const board = (): FigmaSourceNode =>
    canvas("0:1", [
      screenFrame("2:1", "B", [
        text("2:2", "two"),
        {
          id: "2:3",
          name: "Save Button",
          type: "INSTANCE",
          absoluteBoundingBox: bbox(0, 0, 10, 10),
          fills: [solidFill(0.2, 0.4, 0.6)],
        },
      ]),
      screenFrame("1:1", "A", [
        text("1:2", "one", {
          fontFamily: "Inter",
          fontSize: 14,
          fontWeight: 400,
          lineHeightPx: 20,
        }),
      ]),
    ]);

  it("produces byte-identical output across two runs", () => {
    const a = JSON.stringify(cleanScopedNodesToScreenIr(board()));
    const b = JSON.stringify(cleanScopedNodesToScreenIr(board()));
    expect(a).toBe(b);
  });

  it("orders screens, tokens, and links by stable structural keys regardless of input order", () => {
    const result = cleanScopedNodesToScreenIr(board());
    // screens sorted by id
    expect(result.screens.map((s) => s.id)).toEqual(["1:1", "2:1"]);
    // colors sorted by value
    expect(result.tokens.colors.map((c) => c.value)).toEqual(["#336699"]);
  });
});

// ─── A11y colour fields on the IR node (Issue #812) ──────────────────────────────

describe("cleanScopedNodesToScreenIr — a11y colour extraction", () => {
  const findById = (node: IrNode | undefined, id: string): IrNode | undefined => {
    if (node === undefined) return undefined;
    if (node.id === id) return node;
    for (const child of node.children) {
      const hit = findById(child, id);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  it("projects a TEXT node's solid fill to textColor (never backgroundColor)", () => {
    const result = cleanScopedNodesToScreenIr(
      canvas("0:1", [
        screenFrame("1:1", "Card", [
          { ...text("1:2", "Hello"), fills: [solidFill(0, 0, 0)] },
        ]),
      ]),
    );
    const t = findById(result.screens[0]?.root, "1:2");

    expect(t?.textColor).toBe("#000000");
    expect(t?.backgroundColor).toBeUndefined();
  });

  it("projects a non-TEXT node's solid fill to backgroundColor (never textColor)", () => {
    const result = cleanScopedNodesToScreenIr(
      canvas("0:1", [
        screenFrame("1:1", "Card", [text("1:2", "x")], { fills: [solidFill(1, 1, 1)] }),
      ]),
    );
    const frameNode = findById(result.screens[0]?.root, "1:1");

    expect(frameNode?.backgroundColor).toBe("#ffffff");
    expect(frameNode?.textColor).toBeUndefined();
  });

  it("leaves both colour fields absent when a node has no solid fill", () => {
    const result = cleanScopedNodesToScreenIr(
      canvas("0:1", [screenFrame("1:1", "Card", [text("1:2", "x")])]),
    );
    const frameNode = findById(result.screens[0]?.root, "1:1");

    expect(frameNode?.textColor).toBeUndefined();
    expect(frameNode?.backgroundColor).toBeUndefined();
  });
});
