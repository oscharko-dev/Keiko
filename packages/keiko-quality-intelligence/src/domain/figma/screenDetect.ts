// Structural screen detection over the pruned Figma subtree (Epic #750, Issue #752).
//
// A "screen" is a top-level layout container: a FRAME or INSTANCE that sits directly under the
// scoped root or under a CANVAS/SECTION container directly beneath it. We descend ONLY through the
// container types (CANVAS, SECTION) that group screens, never into a screen's own body — so nested
// frames inside a screen stay part of that screen, not separate screens. If the root itself is a
// FRAME/INSTANCE (a directly-scoped single screen), it is the one screen. Detection is name-agnostic.

import { nodeType, type FigmaSourceNode } from "./sourceNode.js";
import type { PrunedNode } from "./prune.js";

const SCREEN_TYPES: ReadonlySet<string> = new Set(["FRAME", "INSTANCE"]);
const CONTAINER_TYPES: ReadonlySet<string> = new Set(["CANVAS", "SECTION"]);

const isScreen = (node: FigmaSourceNode): boolean => SCREEN_TYPES.has(nodeType(node));

const isContainer = (node: FigmaSourceNode): boolean => CONTAINER_TYPES.has(nodeType(node));

/**
 * Collect the screen roots from a pruned tree. Descends through container nodes (CANVAS/SECTION)
 * collecting their screen children; does not recurse into screens. A directly-scoped screen root is
 * returned as the sole screen.
 */
export const detectScreens = (root: PrunedNode): readonly PrunedNode[] => {
  if (isScreen(root.source)) return [root];
  if (!isContainer(root.source)) return [];

  const screens: PrunedNode[] = [];
  for (const child of root.children) {
    if (isScreen(child.source)) {
      screens.push(child);
      continue;
    }
    if (isContainer(child.source)) {
      for (const nested of detectScreens(child)) screens.push(nested);
    }
  }
  return screens;
};
