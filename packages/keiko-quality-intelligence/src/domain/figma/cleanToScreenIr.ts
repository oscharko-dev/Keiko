// Figma node tree → lean per-screen IR orchestrator (Epic #750, Issue #752).
//
// Pure, deterministic, no IO/network/model. Takes the raw scoped Figma `document` node tree
// (the connector output of #751) and produces the Screen-IR result: per-screen kept-node trees,
// deduped design tokens, raw inter-screen links, and a reduction report. Every emitted collection
// is sorted by a stable structural key, and the result carries no timestamp, so the same input
// yields a byte-identical IR. A malformed input (non-object) degrades to an empty result.

import { asNode } from "./sourceNode.js";
import { countSourceNodes, pruneNode } from "./prune.js";
import { detectScreens } from "./screenDetect.js";
import { countIrNodes, normalizeScreenRoot } from "./normalize.js";
import { extractDesignTokens } from "./tokens.js";
import { extractInterScreenLinks } from "./links.js";
import type { ReductionReport, ScreenIr, ScreenIrResult } from "./irTypes.js";

const RATIO_PRECISION = 6;

const EMPTY_TOKENS = { colors: [], typography: [], spacing: [], radius: [] } as const;

const roundRatio = (removed: number, input: number): number => {
  if (input <= 0) return 0;
  const factor = 10 ** RATIO_PRECISION;
  return Math.round((removed / input) * factor) / factor;
};

const buildReduction = (inputNodeCount: number, keptNodeCount: number): ReductionReport => {
  const removedNodeCount = Math.max(0, inputNodeCount - keptNodeCount);
  return {
    inputNodeCount,
    keptNodeCount,
    removedNodeCount,
    removedRatio: roundRatio(removedNodeCount, inputNodeCount),
  };
};

const emptyResult = (inputNodeCount: number): ScreenIrResult => ({
  screens: [],
  tokens: EMPTY_TOKENS,
  links: [],
  reduction: buildReduction(inputNodeCount, 0),
});

export const cleanScopedNodesToScreenIr = (rawRoot: unknown): ScreenIrResult => {
  const root = asNode(rawRoot);
  if (root === undefined) return emptyResult(0);

  const inputNodeCount = countSourceNodes(root);

  const pruned = pruneNode(root);
  if (pruned === undefined) return emptyResult(inputNodeCount);

  const screenRoots = detectScreens(pruned);
  const screens: ScreenIr[] = screenRoots
    .map((screenRoot) => {
      const ir = normalizeScreenRoot(screenRoot);
      return { id: ir.id, name: ir.name, root: ir };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const keptNodeCount = screens.reduce((sum, screen) => sum + countIrNodes(screen.root), 0);

  return {
    screens,
    tokens: extractDesignTokens(screenRoots),
    links: extractInterScreenLinks(root, screenRoots),
    reduction: buildReduction(inputNodeCount, keptNodeCount),
  };
};
