// Deterministic design-token extraction (Epic #750, Issue #752).
//
// Walks the kept (pruned) node trees and projects four token families out of structural fields:
//   color       — solid `fills`/`strokes` → normalized #RRGGBB / #RRGGBBAA (alpha only when < 1).
//   typography  — TEXT `style` → family|size|weight|lineHeight.
//   spacing     — auto-layout `itemSpacing` + paddingTop/Right/Bottom/Left → distinct numbers.
//   radius      — `cornerRadius` → distinct numbers.
//
// Token identity is the canonical value (content-free): same value → one token, regardless of how
// many nodes carry it or in what order. Every family is sorted by its canonical key before emit, so
// output never depends on traversal or map-insertion order.

import {
  asNode,
  nodeType,
  readArray,
  readNumber,
  readString,
  type FigmaSourceNode,
} from "./sourceNode.js";
import type {
  ColorToken,
  DesignTokens,
  RadiusToken,
  SpacingToken,
  TypographyToken,
} from "./irTypes.js";
import type { PrunedNode } from "./prune.js";

const channel = (value: number): string =>
  Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, "0");

const colorToHex = (paint: Record<string, unknown>): string | undefined => {
  const color = asNode(paint.color);
  if (color === undefined) return undefined;
  const r = readNumber(color.r);
  const g = readNumber(color.g);
  const b = readNumber(color.b);
  if (r === undefined || g === undefined || b === undefined) return undefined;
  const a = readNumber(color.a) ?? 1;
  const base = `#${channel(r)}${channel(g)}${channel(b)}`;
  return a < 1 ? `${base}${channel(a)}` : base;
};

const collectPaintColors = (node: FigmaSourceNode, key: string, out: Set<string>): void => {
  for (const paint of readArray(node[key])) {
    const record = asNode(paint);
    if (record === undefined || readString(record.type) !== "SOLID") continue;
    const hex = colorToHex(record);
    if (hex !== undefined) out.add(hex);
  }
};

const collectTypography = (node: FigmaSourceNode, out: Map<string, TypographyToken>): void => {
  if (nodeType(node) !== "TEXT") return;
  const style = asNode(node.style);
  if (style === undefined) return;
  const fontFamily = readString(style.fontFamily) ?? "";
  const fontSize = readNumber(style.fontSize) ?? 0;
  const fontWeight = readNumber(style.fontWeight) ?? 0;
  const lineHeight = readNumber(style.lineHeightPx) ?? 0;
  const id = `typography:${fontFamily}|${String(fontSize)}|${String(fontWeight)}|${String(lineHeight)}`;
  out.set(id, { id, kind: "typography", fontFamily, fontSize, fontWeight, lineHeight });
};

const SPACING_KEYS = ["itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];

const collectSpacing = (node: FigmaSourceNode, out: Set<number>): void => {
  for (const key of SPACING_KEYS) {
    const value = readNumber(node[key]);
    if (value !== undefined && value > 0) out.add(value);
  }
};

const collectRadius = (node: FigmaSourceNode, out: Set<number>): void => {
  const value = readNumber(node.cornerRadius);
  if (value !== undefined && value > 0) out.add(value);
};

interface TokenAccumulator {
  readonly colors: Set<string>;
  readonly typography: Map<string, TypographyToken>;
  readonly spacing: Set<number>;
  readonly radius: Set<number>;
}

const visit = (pruned: PrunedNode, acc: TokenAccumulator): void => {
  const node = pruned.source;
  collectPaintColors(node, "fills", acc.colors);
  collectPaintColors(node, "strokes", acc.colors);
  collectTypography(node, acc.typography);
  collectSpacing(node, acc.spacing);
  collectRadius(node, acc.radius);
  for (const child of pruned.children) visit(child, acc);
};

const toColorTokens = (values: ReadonlySet<string>): readonly ColorToken[] =>
  [...values].sort().map((value) => ({ id: `color:${value}`, kind: "color", value }));

const toSpacingTokens = (values: ReadonlySet<number>): readonly SpacingToken[] =>
  [...values]
    .sort((a, b) => a - b)
    .map((value) => ({ id: `spacing:${String(value)}`, kind: "spacing", value }));

const toRadiusTokens = (values: ReadonlySet<number>): readonly RadiusToken[] =>
  [...values]
    .sort((a, b) => a - b)
    .map((value) => ({ id: `radius:${String(value)}`, kind: "radius", value }));

/** Extract deduped, stable-ordered design tokens from the pruned screen roots. */
export const extractDesignTokens = (screens: readonly PrunedNode[]): DesignTokens => {
  const acc: TokenAccumulator = {
    colors: new Set<string>(),
    typography: new Map<string, TypographyToken>(),
    spacing: new Set<number>(),
    radius: new Set<number>(),
  };
  for (const screen of screens) visit(screen, acc);

  return {
    colors: toColorTokens(acc.colors),
    typography: [...acc.typography.values()].sort((a, b) => a.id.localeCompare(b.id)),
    spacing: toSpacingTokens(acc.spacing),
    radius: toRadiusTokens(acc.radius),
  };
};
