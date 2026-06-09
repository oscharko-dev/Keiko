// Deterministic accessibility (a11y) baseline from a Screen-IR (Epic #750, Issue #812).
//
// Pure domain: a Screen-IR (#752) — per-screen kept-node trees plus the additive `textColor` /
// `backgroundColor` / `boundingBox` fields — is reduced, with NO model and NO IO, to per-screen a11y
// test items reusing #754's `StructuralTestItem` shape so they compose into the figma-snapshot QI run
// additively through `deriveScreenTestBaseline`'s `extraItems` seam (ALONGSIDE #811's nav items):
//   • accessible-name presence — an interactive node (button/input/link) with neither visible text
//     nor a descriptive name → a "needs an accessible name" item;
//   • colour-contrast — every TEXT node with a resolvable text colour and a nearest-ancestor
//     background colour → an exact WCAG relative-luminance contrast item (meets / below AA), with
//     the stricter AA-normal 4.5 threshold used when "large text" cannot be determined from the IR;
//     an uncomputable pairing (missing/malformed colour) → a coverage-notice item, never a crash;
//   • focus / reading order — ≥ 2 interactive nodes with bounding boxes → one reading-order item
//     (top-to-bottom, then left-to-right);
//   • minimum target size — an interactive node whose bounding box is smaller than 24×24 (WCAG 2.2
//     AA 2.5.8) → a target-size item;
//   • image-fill alt-text — a node carrying image fills → an alt-text expectation item.
//
// Generic by construction: every rule reads only structural shape (interactionHint, text, colour,
// box) — no screen name, layout, mask style, or copy is special-cased. Deterministic: items are
// emitted in a stable depth-first / stable-sorted order and carry no timestamp, so the same IR yields
// a byte-identical result. The baseline is model-free and stands alone; vision augmentation (#810) is
// layered separately and never replaces these items.

import { parseHexRgb, type Rgb } from "./color.js";
import type { BoundingBox, IrNode, ScreenIr } from "./irTypes.js";
import type { StructuralTestItem } from "./screenIrTestBaseline.js";

const MIN_TARGET_SIZE = 24;
const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;

const INTERACTIVE = new Set<IrNode["interactionHint"]>(["button", "input", "link"]);

// ─── WCAG relative luminance + contrast ratio (exact, model-free) ─────────────────

// sRGB → linear-light channel (WCAG 2.x): c/12.92 below the knee, else ((c+0.055)/1.055)^2.4.
const linearizeChannel = (channel255: number): number => {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of an sRGB colour: 0 for black, 1 for white. */
export const relativeLuminance = (rgb: Rgb): number =>
  0.2126 * linearizeChannel(rgb.r) +
  0.7152 * linearizeChannel(rgb.g) +
  0.0722 * linearizeChannel(rgb.b);

/** WCAG contrast ratio (L_lighter + 0.05) / (L_darker + 0.05); symmetric, 1..21. */
export const contrastRatio = (a: Rgb, b: Rgb): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
};

/** Whether a ratio meets the WCAG AA threshold (3.0 for large text, else the stricter 4.5). */
export const meetsContrastAa = (ratio: number, isLargeText: boolean): boolean =>
  ratio >= (isLargeText ? AA_LARGE : AA_NORMAL);

// ─── Item construction ────────────────────────────────────────────────────────────

interface ScreenContext {
  readonly screenId: string;
  readonly screenName: string;
}

function a11yItemId(prefix: string, key: string): string {
  // Deterministic non-cryptographic id (FNV-1a) — stable across runs, no IO. Mirrors #754/#811.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

const a11yItem = (
  ctx: ScreenContext,
  nodeId: string,
  kind: string,
  title: string,
): StructuralTestItem => ({
  id: a11yItemId("fa11y", `${ctx.screenId}|${kind}|${nodeId}`),
  category: "a11y",
  screenId: ctx.screenId,
  screenName: ctx.screenName,
  sourceNodeId: nodeId,
  title,
});

const noticeItem = (
  ctx: ScreenContext,
  nodeId: string,
  kind: string,
  title: string,
): StructuralTestItem => ({
  id: a11yItemId("fa11ycov", `${ctx.screenId}|${kind}|${nodeId}`),
  category: "coverage-notice",
  screenId: ctx.screenId,
  screenName: ctx.screenName,
  sourceNodeId: nodeId,
  title,
});

// ─── Per-rule derivation ───────────────────────────────────────────────────────────

const nodeLabel = (node: IrNode): string =>
  node.text !== undefined && node.text.length > 0 ? node.text : node.name;

// A node's name is "descriptive" only when it is not an opaque Figma node id (e.g. "123:45"). This is
// structural, not board-specific: it rejects the id syntax, never any particular screen's vocabulary.
const hasDescriptiveName = (node: IrNode): boolean =>
  node.name.trim().length > 0 && !/^[0-9]+:[0-9]+$/u.test(node.name.trim());

const hasAccessibleName = (node: IrNode): boolean =>
  (node.text !== undefined && node.text.trim().length > 0) || hasDescriptiveName(node);

const contrastItem = (
  ctx: ScreenContext,
  node: IrNode,
  background: string | undefined,
): StructuralTestItem => {
  const fg = node.textColor === undefined ? undefined : parseHexRgb(node.textColor);
  const bg = background === undefined ? undefined : parseHexRgb(background);
  if (fg === undefined || bg === undefined) {
    return noticeItem(
      ctx,
      node.id,
      "contrast",
      `Text "${nodeLabel(node)}" needs a verifiable colour contrast: text/background colour could not be resolved from the design tokens`,
    );
  }
  const ratio = contrastRatio(fg, bg);
  const rounded = Math.round(ratio * 100) / 100;
  const verdict = meetsContrastAa(ratio, false)
    ? `meets WCAG AA (${String(rounded)}:1 ≥ ${String(AA_NORMAL)}:1)`
    : `is below WCAG AA (${String(rounded)}:1 < ${String(AA_NORMAL)}:1)`;
  return a11yItem(ctx, node.id, "contrast", `Text "${nodeLabel(node)}" colour contrast ${verdict}`);
};

const isTooSmall = (box: BoundingBox): boolean =>
  box.width < MIN_TARGET_SIZE || box.height < MIN_TARGET_SIZE;

interface Focusable {
  readonly nodeId: string;
  readonly label: string;
  readonly box: BoundingBox;
}

const byReadingOrder = (a: Focusable, b: Focusable): number =>
  a.box.y !== b.box.y ? a.box.y - b.box.y : a.box.x - b.box.x;

// ─── Tree walk ──────────────────────────────────────────────────────────────────

interface WalkAccumulator {
  readonly items: StructuralTestItem[];
  readonly focusables: Focusable[];
}

// Each rule returns its item (or undefined when the node is out of scope), keeping `visit` flat so
// its cyclomatic complexity stays within budget. Rules read only structural shape — never copy.
const nameRule = (ctx: ScreenContext, node: IrNode): StructuralTestItem | undefined =>
  INTERACTIVE.has(node.interactionHint) && !hasAccessibleName(node)
    ? a11yItem(ctx, node.id, "name", `Interactive "${node.name}" exposes an accessible name`)
    : undefined;

const contrastRule = (
  ctx: ScreenContext,
  node: IrNode,
  background: string | undefined,
): StructuralTestItem | undefined =>
  node.interactionHint === "text" && node.textColor !== undefined
    ? contrastItem(ctx, node, background)
    : undefined;

const targetSizeRule = (ctx: ScreenContext, node: IrNode): StructuralTestItem | undefined =>
  INTERACTIVE.has(node.interactionHint) &&
  node.boundingBox !== undefined &&
  isTooSmall(node.boundingBox)
    ? a11yItem(
        ctx,
        node.id,
        "target",
        `Control "${nodeLabel(node)}" meets the 24×24 minimum target size`,
      )
    : undefined;

const altTextRule = (ctx: ScreenContext, node: IrNode): StructuralTestItem | undefined =>
  node.imageFills.length > 0
    ? a11yItem(ctx, node.id, "alt", `Image "${node.name}" exposes descriptive alt text`)
    : undefined;

function visit(
  node: IrNode,
  ctx: ScreenContext,
  inheritedBackground: string | undefined,
  acc: WalkAccumulator,
): void {
  const background = node.backgroundColor ?? inheritedBackground;
  for (const item of [
    nameRule(ctx, node),
    contrastRule(ctx, node, background),
    targetSizeRule(ctx, node),
    altTextRule(ctx, node),
  ]) {
    if (item !== undefined) acc.items.push(item);
  }
  if (INTERACTIVE.has(node.interactionHint) && node.boundingBox !== undefined) {
    acc.focusables.push({ nodeId: node.id, label: nodeLabel(node), box: node.boundingBox });
  }
  for (const child of node.children) visit(child, ctx, background, acc);
}

const focusOrderItem = (
  ctx: ScreenContext,
  focusables: readonly Focusable[],
): StructuralTestItem => {
  const ordered = [...focusables].sort(byReadingOrder);
  const sequence = ordered.map((f) => `"${f.label}"`).join(" → ");
  return a11yItem(
    ctx,
    ordered[0]?.nodeId ?? "",
    "focus-order",
    `Focus order follows the visual reading order: ${sequence}`,
  );
};

/**
 * Derive the deterministic a11y test items per screen, keyed by the screen they are attributed to.
 * Reuses #754's StructuralTestItem shape so the items compose additively through
 * `deriveScreenTestBaseline(screen, extraItems)`, ALONGSIDE #811's navigation items. Model-free and
 * reproducible: the same IR yields a byte-identical map.
 */
export function deriveA11yTestItemsByScreen(
  screens: readonly ScreenIr[],
): ReadonlyMap<string, readonly StructuralTestItem[]> {
  const byScreen = new Map<string, readonly StructuralTestItem[]>();
  for (const screen of screens) {
    const ctx: ScreenContext = { screenId: screen.id, screenName: screen.name };
    const acc: WalkAccumulator = { items: [], focusables: [] };
    visit(screen.root, ctx, undefined, acc);
    if (acc.focusables.length >= 2) acc.items.push(focusOrderItem(ctx, acc.focusables));
    byScreen.set(screen.id, acc.items);
  }
  return byScreen;
}
