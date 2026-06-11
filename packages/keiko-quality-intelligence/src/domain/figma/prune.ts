// Deterministic pruning of the raw Figma node subtree (Epic #750, Issue #752).
//
// Three structural drop rules, justified without any board-specific tuning:
//   1. `visible === false`  — the node is explicitly hidden in Figma; the whole subtree is dropped.
//   2. type COMPONENT / COMPONENT_SET — design-system definition masters, render-irrelevant. (They
//      may be absent in an instance-heavy scoped fetch; dropped only when present.) INSTANCE is the
//      placed, rendered UI and is always kept.
//   3. empty scaffold — a node with NO render payload (no text, no fills/strokes, no bbox) AND no
//      kept descendants is a structural marker/wrapper carrying nothing; it is dropped. Anything
//      with payload or surviving children is kept, so the rule never deletes real UI.
//
// Pruning is name-agnostic. No copy, screen name, or component vocabulary participates.

import {
  asNode,
  childNodes,
  isHidden,
  nodeType,
  readArray,
  readString,
  type FigmaSourceNode,
} from "./sourceNode.js";

const MASTER_TYPES: ReadonlySet<string> = new Set(["COMPONENT", "COMPONENT_SET"]);

// Subtrees deeper than this are truncated (not walked). Prevents RangeError on malformed inputs with
// chain-like node trees thousands of levels deep. Documented contract: malformed input degrades, never
// crashes (cleanToScreenIr.ts header).
// Shared contract: every recursive tree walk in this pipeline (prune → normalize → tokens → links →
// a11y → screenIrTestBaseline) uses the same value so that none overflow before the others. 512 is
// far above any legitimate Figma board depth (< 50 in practice) while staying safe inside vitest
// worker threads, which have a smaller default JS stack than bare Node.
const MAX_TREE_DEPTH = 512;

/** A node that survived pruning, paired with its pruned children. */
export interface PrunedNode {
  readonly source: FigmaSourceNode;
  readonly children: readonly PrunedNode[];
}

const hasOwnPayload = (node: FigmaSourceNode): boolean => {
  if (readString(node.characters) !== undefined) return true;
  if (readArray(node.fills).length > 0) return true;
  if (readArray(node.strokes).length > 0) return true;
  if (asNode(node.absoluteBoundingBox) !== undefined) return true;
  return false;
};

const isDroppedByType = (node: FigmaSourceNode): boolean => MASTER_TYPES.has(nodeType(node));

function pruneNodeAt(node: FigmaSourceNode, depth: number): PrunedNode | undefined {
  if (depth > MAX_TREE_DEPTH) return undefined;
  if (isHidden(node) || isDroppedByType(node)) return undefined;

  const children: PrunedNode[] = [];
  for (const child of childNodes(node)) {
    const kept = pruneNodeAt(child, depth + 1);
    if (kept !== undefined) children.push(kept);
  }

  if (children.length === 0 && !hasOwnPayload(node)) return undefined;
  return { source: node, children };
}

/**
 * Prune a node, returning the kept node (with kept children) or `undefined` when the node itself is
 * dropped. A node is dropped when hidden, a component master, or an empty scaffold. Subtrees deeper
 * than MAX_TREE_DEPTH are truncated so malformed chain-like inputs degrade rather than overflow.
 */
export const pruneNode = (node: FigmaSourceNode): PrunedNode | undefined => pruneNodeAt(node, 0);

function countSourceNodesAt(node: FigmaSourceNode, depth: number): number {
  if (depth > MAX_TREE_DEPTH) return 1; // count the truncated subtree root only
  let total = 1;
  for (const child of childNodes(node)) total += countSourceNodesAt(child, depth + 1);
  return total;
}

/** Total node count of a raw subtree (root included), used for the reduction ratio. */
export const countSourceNodes = (node: FigmaSourceNode): number => countSourceNodesAt(node, 0);
