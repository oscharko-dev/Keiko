// Deterministic colour helpers shared across token extraction (#752) and a11y contrast (#812).
//
// One canonical projection of a Figma SOLID paint to a normalized `#RRGGBB[AA]` hex string, plus the
// inverse parse used by the WCAG contrast math. Pure and content-free: the same paint always yields
// the same hex, and the same hex always parses to the same channels. No IO, no model.

import { asNode, readNumber, readString, type FigmaSourceNode } from "./sourceNode.js";

const channel = (value: number): string =>
  Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, "0");

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

/** The first SOLID paint's normalized hex from a node's paint array (`fills`/`strokes`), if any. */
export const firstSolidPaintHex = (node: FigmaSourceNode, key: string): string | undefined => {
  const paints = node[key];
  if (!Array.isArray(paints)) return undefined;
  for (const paint of paints) {
    const record = asNode(paint);
    if (record === undefined || readString(record.type) !== "SOLID") continue;
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
