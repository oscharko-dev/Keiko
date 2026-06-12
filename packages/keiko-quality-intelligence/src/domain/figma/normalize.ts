// Per-node normalization of the pruned tree into IR nodes (Epic #750, Issue #752).
//
// Projects each kept node to a compact `IrNode`: id/name/type, text content, bounding box, image
// fill refs, kept children, and a best-effort `interactionHint`.
//
// In addition to the structural fields, five additive optional fields are projected when present:
//   layout     — auto-layout direction/gap/padding/alignment (HORIZONTAL/VERTICAL layoutMode)
//   sizing     — per-axis sizing mode (layoutSizingHorizontal/Vertical: FIXED|HUG|FILL)
//   cornerRadius — corner radius in pixels (cornerRadius > 0)
//   typography — per-TEXT fontFamily/fontSize/fontWeight (from the `style` block)
//
// These fields are OMITTED when absent or when the source values are missing/malformed — never
// defaulted. They are hash-neutral (#753/#735): re-normalizing the same structural design after
// these fields ship does not change the drift identity. Negative, NaN, and non-finite values are
// clamped to absent.
//
// The interaction hint is a HINT, never load-bearing — downstream (#754) treats button/input
// classification as advisory and degrades to `container`. Three classes are purely structural:
//   link  — the node carries a navigating prototype interaction/reaction (it navigates).
//   image — the node has an IMAGE-type fill (and is not TEXT).
//   text  — the node is a TEXT node.
// `button`/`input` are the one accepted name heuristic: a tiny, word-boundary, case-insensitive
// match over the conventional design-system role vocabulary. Boards that don't use these words fall
// back to `container` — no board's specific names are encoded.

import {
  asNode,
  nodeId,
  nodeName,
  nodeType,
  readArray,
  readNumber,
  readString,
  type FigmaSourceNode,
} from "./sourceNode.js";
import { firstSolidPaintHex } from "./color.js";
import type {
  AlignItems,
  BoundingBox,
  ImageFillRef,
  InteractionHint,
  IrLayout,
  IrNode,
  IrSizing,
  IrTypography,
  LayoutMode,
  LayoutSizing,
} from "./irTypes.js";
import type { PrunedNode } from "./prune.js";

const BUTTON_ROLE = /\b(?:button|btn|cta)\b/iu;
const INPUT_ROLE = /\b(?:input|field|textfield|textbox)\b/iu;

const readBoundingBox = (node: FigmaSourceNode): BoundingBox | undefined => {
  const box = asNode(node.absoluteBoundingBox);
  if (box === undefined) return undefined;
  const x = readNumber(box.x);
  const y = readNumber(box.y);
  const width = readNumber(box.width);
  const height = readNumber(box.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
};

const readImageFills = (node: FigmaSourceNode): readonly ImageFillRef[] => {
  const out: ImageFillRef[] = [];
  for (const fill of readArray(node.fills)) {
    const record = asNode(fill);
    if (record === undefined || readString(record.type) !== "IMAGE") continue;
    const imageRef = readString(record.imageRef);
    if (imageRef !== undefined) out.push({ imageRef });
  }
  return out;
};

const navigates = (node: FigmaSourceNode): boolean => {
  const interactions = readArray(node.interactions);
  const reactions = readArray(node.reactions);
  return interactions.length > 0 || reactions.length > 0;
};

const classify = (node: FigmaSourceNode, imageFills: readonly ImageFillRef[]): InteractionHint => {
  if (nodeType(node) === "TEXT") return "text";
  if (navigates(node)) return "link";
  if (imageFills.length > 0) return "image";
  const name = nodeName(node);
  if (BUTTON_ROLE.test(name)) return "button";
  if (INPUT_ROLE.test(name)) return "input";
  return "container";
};

// A TEXT node's solid fill is its foreground (text) colour; any other node's solid fill is a
// background. We project at most one of each so the a11y contrast pass (#812) has a deterministic
// text-vs-background pairing without re-deriving paints. Both are absent when there is no solid fill.
const readTextColor = (node: FigmaSourceNode): string | undefined =>
  nodeType(node) === "TEXT" ? firstSolidPaintHex(node, "fills") : undefined;

const readBackgroundColor = (node: FigmaSourceNode): string | undefined =>
  nodeType(node) === "TEXT" ? undefined : firstSolidPaintHex(node, "fills");

// ─── Layout / sizing / cornerRadius / typography projection ──────────────────

const ALIGN_MAP: Readonly<Record<string, AlignItems>> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  SPACE_BETWEEN: "space-between",
};

const readAlign = (value: unknown): AlignItems | undefined => {
  const s = readString(value);
  return s !== undefined ? ALIGN_MAP[s] : undefined;
};

const readLayoutMode = (value: unknown): LayoutMode | undefined => {
  const s = readString(value);
  if (s === "HORIZONTAL") return "row";
  if (s === "VERTICAL") return "column";
  return undefined;
};

const readLayoutSizing = (value: unknown): LayoutSizing | undefined => {
  const s = readString(value);
  if (s === "FIXED") return "fixed";
  if (s === "HUG") return "hug";
  if (s === "FILL") return "fill";
  return undefined;
};

// A padding value is valid only when it is a finite, non-negative number.
const readPaddingValue = (value: unknown): number | undefined => {
  const n = readNumber(value);
  return n !== undefined && n >= 0 ? n : undefined;
};

// Returns [top, right, bottom, left] when at least one side is non-zero; undefined otherwise.
const readLayoutPadding = (
  node: FigmaSourceNode,
): readonly [number, number, number, number] | undefined => {
  const top = readPaddingValue(node.paddingTop) ?? 0;
  const right = readPaddingValue(node.paddingRight) ?? 0;
  const bottom = readPaddingValue(node.paddingBottom) ?? 0;
  const left = readPaddingValue(node.paddingLeft) ?? 0;
  return top > 0 || right > 0 || bottom > 0 || left > 0 ? [top, right, bottom, left] : undefined;
};

const readLayout = (node: FigmaSourceNode): IrLayout | undefined => {
  const mode = readLayoutMode(node.layoutMode);
  if (mode === undefined) return undefined;

  const itemSpacing = readNumber(node.itemSpacing);
  const padding = readLayoutPadding(node);
  const primaryAlign = readAlign(node.primaryAxisAlignItems);
  const counterAlign = readAlign(node.counterAxisAlignItems);

  return {
    mode,
    ...(itemSpacing !== undefined && itemSpacing > 0 ? { itemSpacing } : {}),
    ...(padding !== undefined ? { padding } : {}),
    ...(primaryAlign !== undefined ? { primaryAlign } : {}),
    ...(counterAlign !== undefined ? { counterAlign } : {}),
  };
};

const readSizing = (node: FigmaSourceNode): IrSizing | undefined => {
  const horizontal = readLayoutSizing(node.layoutSizingHorizontal);
  const vertical = readLayoutSizing(node.layoutSizingVertical);
  if (horizontal === undefined && vertical === undefined) return undefined;
  return {
    ...(horizontal !== undefined ? { horizontal } : {}),
    ...(vertical !== undefined ? { vertical } : {}),
  };
};

const readCornerRadius = (node: FigmaSourceNode): number | undefined => {
  const value = readNumber(node.cornerRadius);
  return value !== undefined && value > 0 ? value : undefined;
};

const readTypography = (node: FigmaSourceNode): IrTypography | undefined => {
  if (nodeType(node) !== "TEXT") return undefined;
  const style = asNode(node.style);
  if (style === undefined) return undefined;
  const fontFamily = readString(style.fontFamily);
  const fontSize = readNumber(style.fontSize);
  const fontWeight = readNumber(style.fontWeight);
  if (fontFamily === undefined || fontSize === undefined || fontWeight === undefined)
    return undefined;
  return { fontFamily, fontSize, fontWeight };
};

// Subtrees deeper than this are truncated to prevent RangeError on malformed chain-like inputs.
// Same shared constant as prune.ts — see there for the rationale. Must stay in sync with every
// other recursive walk in this pipeline (tokens, links, a11y, screenIrTestBaseline).
const MAX_TREE_DEPTH = 512;

function buildNodeAt(pruned: PrunedNode, depth: number): IrNode {
  const node = pruned.source;
  const imageFills = readImageFills(node);
  const text = readString(node.characters);
  const boundingBox = readBoundingBox(node);
  const textColor = readTextColor(node);
  const backgroundColor = readBackgroundColor(node);
  const children =
    depth >= MAX_TREE_DEPTH ? [] : pruned.children.map((c) => buildNodeAt(c, depth + 1));
  const layout = readLayout(node);
  const sizing = readSizing(node);
  const cornerRadius = readCornerRadius(node);
  const typography = readTypography(node);
  return {
    id: nodeId(node),
    name: nodeName(node),
    type: nodeType(node),
    interactionHint: classify(node, imageFills),
    ...(text !== undefined ? { text } : {}),
    ...(boundingBox !== undefined ? { boundingBox } : {}),
    ...(textColor !== undefined ? { textColor } : {}),
    ...(backgroundColor !== undefined ? { backgroundColor } : {}),
    ...(layout !== undefined ? { layout } : {}),
    ...(sizing !== undefined ? { sizing } : {}),
    ...(cornerRadius !== undefined ? { cornerRadius } : {}),
    ...(typography !== undefined ? { typography } : {}),
    imageFills,
    children,
  };
}

/** Normalize a pruned screen root into its IR node tree. Child order follows source order. */
export const normalizeScreenRoot = (pruned: PrunedNode): IrNode => buildNodeAt(pruned, 0);

function countIrNodesAt(node: IrNode, depth: number): number {
  if (depth > MAX_TREE_DEPTH) return 1;
  return 1 + node.children.reduce((sum, child) => sum + countIrNodesAt(child, depth + 1), 0);
}

/** Count the IR nodes in a normalized tree, used for the reduction ratio. */
export const countIrNodes = (node: IrNode): number => countIrNodesAt(node, 0);
