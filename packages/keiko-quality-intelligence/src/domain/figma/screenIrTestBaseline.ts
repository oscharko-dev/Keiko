// Deterministic structural test baseline from a Screen-IR (Epic #750, Issue #754).
//
// Pure domain: a Screen-IR (#752) is reduced by structural rules to a reproducible, citation-ready
// list of test items — every input field → presence + validation tests; every control (button/link)
// → action + expected-result tests; every screen → a render/navigation test; every state/variant
// → a state test. No IO, no model, no network: the same IR yields a byte-identical baseline so the
// QI source ships a usable baseline with NO model available.
//
// Generic by construction: the rules read only the IR's structural shape (interactionHint, node
// type, text, and a generic `state`/`variant` naming convention shared across design tools). No
// rule, threshold, name, or template is tuned to a specific board.
//
// Additive seam: `deriveScreenTestBaseline` accepts optional `extraItems`, so sibling derivations
// (navigation/flow #811, a11y #812) can contribute extra per-screen test items WITHOUT changing the
// baseline shape. Vision-derived semantics are layered separately (see visionAugmentation.ts) and
// never replace these structural items.

import type { IrNode, ScreenIr } from "./irTypes.js";

export type StructuralTestCategory =
  | "field-presence"
  | "field-validation"
  | "control-action"
  | "screen-render"
  | "state"
  // Navigation/flow categories (Issue #811). Additive members contributed through the `extraItems`
  // seam by the deterministic navigation-graph derivation (navGraph.ts); never produced here.
  | "navigation"
  | "flow"
  | "coverage-notice";

/** One deterministic, per-screen-attributable test item derived from the Screen-IR. */
export interface StructuralTestItem {
  readonly id: string;
  readonly title: string;
  readonly category: StructuralTestCategory;
  /** Screen provenance so a generated test is attributable to its origin screen. */
  readonly screenId: string;
  readonly screenName: string;
  /** The IR node the item was derived from, when applicable (screen-level items omit it). */
  readonly sourceNodeId?: string;
}

/** The structural baseline for a single screen: ordered, deterministic test items. */
export interface ScreenTestBaseline {
  readonly screenId: string;
  readonly screenName: string;
  readonly items: readonly StructuralTestItem[];
}

const INTERACTION_HINTS = new Set<string>([
  "button",
  "input",
  "link",
  "text",
  "image",
  "container",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseImageFills(value: unknown): IrNode["imageFills"] {
  if (!Array.isArray(value)) return [];
  const refs: { readonly imageRef: string }[] = [];
  for (const entry of value) {
    if (isObject(entry) && isString(entry.imageRef)) refs.push({ imageRef: entry.imageRef });
  }
  return refs;
}

// Parse a node's children list, dropping any malformed child rather than failing the whole node.
function parseIrChildren(value: unknown): IrNode[] {
  if (!Array.isArray(value)) return [];
  const children: IrNode[] = [];
  for (const child of value) {
    const parsed = parseIrNode(child);
    if (parsed !== undefined) children.push(parsed);
  }
  return children;
}

// Total, defensive IR-node parser: an opaque serialised node (from the snapshot's `irJson`) is
// accepted only when its required structural fields are present and well-typed; anything malformed
// yields `undefined` so a corrupt screen degrades to "no items" rather than crashing the run.
function parseIrNode(value: unknown): IrNode | undefined {
  if (!isObject(value)) return undefined;
  const { id, name, type, interactionHint } = value;
  if (!isString(id) || !isString(name) || !isString(type)) return undefined;
  if (!isString(interactionHint) || !INTERACTION_HINTS.has(interactionHint)) return undefined;
  return {
    id,
    name,
    type,
    interactionHint: interactionHint as IrNode["interactionHint"],
    ...(isString(value.text) ? { text: value.text } : {}),
    imageFills: parseImageFills(value.imageFills),
    children: parseIrChildren(value.children),
  };
}

/**
 * Total, defensive Screen-IR parser for the snapshot's opaque `irJson`. Returns `undefined` for a
 * missing or malformed value (no `root`, malformed node tree) so the caller can skip an unparseable
 * screen without crashing. A valid IR is returned verbatim through the typed shape.
 */
export function parseScreenIr(value: unknown): ScreenIr | undefined {
  if (!isObject(value) || !isString(value.id) || !isString(value.name)) return undefined;
  const root = parseIrNode(value.root);
  if (root === undefined) return undefined;
  return { id: value.id, name: value.name, root };
}

// A generic state/variant naming convention shared across design tools: a node whose name carries an
// explicit `state=` / `variant=` property segment, or a slash-delimited property. NOT tuned to any
// board's vocabulary — it matches the structural property syntax, never specific state names.
const STATE_PROPERTY = /(?:^|[,\s])(?:state|variant)\s*=\s*([^,]+)/iu;

function stateLabel(name: string): string | undefined {
  const match = STATE_PROPERTY.exec(name);
  const captured = match?.[1]?.trim();
  return captured !== undefined && captured.length > 0 ? captured : undefined;
}

function shortHash(input: string): string {
  // Deterministic non-cryptographic id suffix (FNV-1a) — stable across runs, no IO, no import.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function itemId(screenId: string, category: string, nodeId: string, ordinal: number): string {
  return `fst-${shortHash(`${screenId}|${category}|${nodeId}|${String(ordinal)}`)}`;
}

interface DerivationContext {
  readonly screenId: string;
  readonly screenName: string;
}

function fieldItems(node: IrNode, ctx: DerivationContext): StructuralTestItem[] {
  const label = node.text !== undefined && node.text.length > 0 ? node.text : node.name;
  const base = { screenId: ctx.screenId, screenName: ctx.screenName, sourceNodeId: node.id };
  return [
    {
      ...base,
      id: itemId(ctx.screenId, "field-presence", node.id, 0),
      category: "field-presence",
      title: `Field "${label}" is present and editable on screen "${ctx.screenName}"`,
    },
    {
      ...base,
      id: itemId(ctx.screenId, "field-validation", node.id, 0),
      category: "field-validation",
      title: `Field "${label}" rejects empty / malformed input on screen "${ctx.screenName}"`,
    },
  ];
}

function controlItems(node: IrNode, ctx: DerivationContext): StructuralTestItem[] {
  const label = node.text !== undefined && node.text.length > 0 ? node.text : node.name;
  const verb = node.interactionHint === "link" ? "Following" : "Activating";
  return [
    {
      screenId: ctx.screenId,
      screenName: ctx.screenName,
      sourceNodeId: node.id,
      id: itemId(ctx.screenId, "control-action", node.id, 0),
      category: "control-action",
      title: `${verb} "${label}" produces its expected result on screen "${ctx.screenName}"`,
    },
  ];
}

function stateItem(node: IrNode, ctx: DerivationContext, label: string): StructuralTestItem {
  return {
    screenId: ctx.screenId,
    screenName: ctx.screenName,
    sourceNodeId: node.id,
    id: itemId(ctx.screenId, "state", node.id, 0),
    category: "state",
    title: `Element "${node.name}" renders correctly in state "${label}" on screen "${ctx.screenName}"`,
  };
}

function collectNodeItems(node: IrNode, ctx: DerivationContext, out: StructuralTestItem[]): void {
  if (node.interactionHint === "input") out.push(...fieldItems(node, ctx));
  if (node.interactionHint === "button" || node.interactionHint === "link") {
    out.push(...controlItems(node, ctx));
  }
  const state = stateLabel(node.name);
  if (state !== undefined) out.push(stateItem(node, ctx, state));
  for (const child of node.children) collectNodeItems(child, ctx, out);
}

function screenRenderItem(ctx: DerivationContext): StructuralTestItem {
  return {
    screenId: ctx.screenId,
    screenName: ctx.screenName,
    id: itemId(ctx.screenId, "screen-render", ctx.screenId, 0),
    category: "screen-render",
    title: `Screen "${ctx.screenName}" renders and is reachable`,
  };
}

/**
 * Derive the deterministic structural baseline for one screen. The screen-render item comes first,
 * then field / control / state items in stable depth-first node order. `extraItems` is the additive
 * seam (#811 navigation, #812 a11y): a sibling derivation may contribute already-built test items
 * for this screen without changing the baseline shape. The result is reproducible for a given IR.
 */
export function deriveScreenTestBaseline(
  screen: ScreenIr,
  extraItems: readonly StructuralTestItem[] = [],
): ScreenTestBaseline {
  const ctx: DerivationContext = { screenId: screen.id, screenName: screen.name };
  const items: StructuralTestItem[] = [screenRenderItem(ctx)];
  collectNodeItems(screen.root, ctx, items);
  items.push(...extraItems);
  return { screenId: screen.id, screenName: screen.name, items };
}

/**
 * Render the structural baseline as citation-ready canonical text carrying per-screen provenance.
 * The text is deterministic (no timestamps, stable order) and is what the QI ingestion turns into a
 * content-bearing atom. Vision-derived hints, when present, are appended SEPARATELY by the caller
 * (visionAugmentation.ts) and never replace these lines.
 */
export function renderBaselineText(baseline: ScreenTestBaseline): string {
  const header = `Screen: ${baseline.screenName} [${baseline.screenId}]`;
  const lines = baseline.items.map((item) => `- (${item.category}) ${item.title}`);
  return [
    header,
    "Structural test baseline (deterministic, derived from Screen-IR):",
    ...lines,
  ].join("\n");
}
