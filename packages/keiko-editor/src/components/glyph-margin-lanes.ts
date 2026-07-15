/**
 * Epic-integration fix (Epic #2096, ADR-0136 Target Outcome 5): Monaco 0.55.1 renders the glyph
 * margin as up to three independent physical lanes (`GlyphMarginLane.Left`/`Center`/`Right`) so that
 * multiple decoration sources can coexist on one line without sharing a DOM node. A decoration that
 * sets `glyphMarginClassName` but omits `glyphMargin.position` defaults to `Center`
 * (`ModelDecorationGlyphMarginOptions` in monaco-editor's `textModel.ts`), so any two decoration kinds
 * that both omit it collide on the exact same lane: their class names concatenate onto one element,
 * and each side's CSS (the M5 git-gutter's `display:flex !important` + border-left change indicator,
 * the M5 blame `::before` badge, the M8 debug breakpoint's circular-dot sizing) fights over that
 * single node's box model instead of rendering side by side.
 *
 * This module is the single place that assigns a lane per decoration kind. Every bridge that sets
 * `glyphMarginClassName` reads its lane from here instead of inlining a magic 1/2/3 at its own call
 * site, so a future gutter-decoration bridge cannot silently collide with an existing one.
 */
export type GlyphMarginLane = 1 | 2 | 3;

const GLYPH_MARGIN_LANE = Object.freeze({
  left: 1,
  center: 2,
  right: 3,
} as const satisfies Record<"left" | "center" | "right", GlyphMarginLane>);

// M8 governed-debugging breakpoints: the primary, most frequently clicked gutter affordance get the
// leftmost lane, closest to the line numbers.
export const DEBUG_GLYPH_MARGIN_LANE: GlyphMarginLane = GLYPH_MARGIN_LANE.left;

// M5 git-gutter change indicators keep the center lane (Monaco's implicit default), since they were
// the first occupant of the glyph margin before M8 added breakpoints to it.
export const GIT_GUTTER_GLYPH_MARGIN_LANE: GlyphMarginLane = GLYPH_MARGIN_LANE.center;

// M5 blame annotations get the rightmost lane so an active blame view never shares a DOM node with
// either a breakpoint or a pending git change on the same line.
export const BLAME_GLYPH_MARGIN_LANE: GlyphMarginLane = GLYPH_MARGIN_LANE.right;
