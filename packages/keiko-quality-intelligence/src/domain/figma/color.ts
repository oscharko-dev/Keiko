// Deterministic colour helpers shared across token extraction (#752) and a11y contrast (#812).
//
// One canonical projection of a Figma SOLID paint to a normalized `#RRGGBB[AA]` hex string, plus the
// inverse parse used by the WCAG contrast math. Pure and content-free: the same paint always yields
// the same hex, and the same hex always parses to the same channels. No IO, no model.
//
// Empirical note (#838, verified content-free against real enterprise boards): a real Figma TEXT
// node carries its colour as an INLINE SOLID paint in its own `fills` array for the overwhelming
// majority of nodes (82–99% across the sampled boards). The earlier hypothesis that colour lives in
// a `fillStyleId` / `styles.fill` style reference did NOT hold — fill-style-referenced text still
// inlines the resolved SOLID paint, so `fills` is the single source of truth and no style-table
// resolution is needed. The residual nodes carry an EMPTY `fills:[]` (a typography-only `styles.text`
// reference, no own paint); those are genuinely unresolvable and correctly degrade to an a11y
// coverage notice rather than a fabricated colour. The historical "0 textColor on real boards"
// symptom was caused by the depth-fetch gap (#837), not by where the colour lives: the text-bearing
// nodes simply never survived into the IR. The one real robustness gap here is paint VISIBILITY —
// an explicitly hidden or fully-transparent paint must never become the reported colour.

import { asNode, readNumber, readString, type FigmaSourceNode } from "./sourceNode.js";

const channel = (value: number): string =>
  Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, "0");

/**
 * Whether a Figma paint contributes a visible colour. Figma omits `visible` when a paint is shown, so
 * only an explicit `visible:false` hides it (mirrors {@link isHidden} for nodes). A paint-level
 * `opacity:0` or a SOLID `color.a:0` is fully transparent and likewise contributes no visible colour.
 * Used so neither the reported text/background colour (#812) nor an extracted colour token (#752) is
 * ever taken from a paint that does not render.
 */
export const isVisiblePaint = (paint: Record<string, unknown>): boolean => {
  if (paint.visible === false) return false;
  const opacity = readNumber(paint.opacity);
  if (opacity === 0) return false;
  const color = asNode(paint.color);
  if (color !== undefined && readNumber(color.a) === 0) return false;
  return true;
};

/** Project a Figma paint's `color` ({r,g,b,a} in 0..1) to normalized `#RRGGBB[AA]` (alpha < 1 only). */
export const paintColorToHex = (paint: Record<string, unknown>): string | undefined => {
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

/**
 * The first VISIBLE SOLID paint's normalized hex from a node's paint array (`fills`/`strokes`), if
 * any. Hidden (`visible:false`) and fully-transparent paints are skipped so the reported colour is
 * one that actually renders; an empty/absent paint array yields `undefined` (resolved downstream as a
 * coverage notice, never a fabricated colour).
 */
export const firstSolidPaintHex = (node: FigmaSourceNode, key: string): string | undefined => {
  const paints = node[key];
  if (!Array.isArray(paints)) return undefined;
  for (const paint of paints) {
    const record = asNode(paint);
    if (record === undefined || readString(record.type) !== "SOLID") continue;
    if (!isVisiblePaint(record)) continue;
    const hex = paintColorToHex(record);
    if (hex !== undefined) return hex;
  }
  return undefined;
};

/** Parsed sRGB channels in the 0..255 range. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

// Parse the leading `#RRGGBB` of a normalized hex (the optional alpha suffix is ignored for contrast:
// WCAG contrast is defined on opaque colours and the IR composites onto a solid background). Returns
// undefined for a malformed value so the caller emits a coverage notice rather than crashing.
export const parseHexRgb = (hex: string): Rgb | undefined => {
  if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/u.test(hex)) return undefined;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
};
