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

/**
 * Prune a node, returning the kept node (with kept children) or `undefined` when the node itself is
 * dropped. A node is dropped when hidden, a component master, or an empty scaffold.
 */
export const pruneNode = (node: FigmaSourceNode): PrunedNode | undefined => {
  if (isHidden(node) || isDroppedByType(node)) return undefined;

  const children: PrunedNode[] = [];
  for (const child of childNodes(node)) {
    const kept = pruneNode(child);
    if (kept !== undefined) children.push(kept);
  }

  if (children.length === 0 && !hasOwnPayload(node)) return undefined;
  return { source: node, children };
};

/** Total node count of a raw subtree (root included), used for the reduction ratio. */
export const countSourceNodes = (node: FigmaSourceNode): number => {
  let total = 1;
  for (const child of childNodes(node)) total += countSourceNodes(child);
  return total;
};
