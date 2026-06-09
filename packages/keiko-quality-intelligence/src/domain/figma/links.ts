// Raw inter-screen link extraction (Epic #750, Issue #752).
//
// Captures the raw prototype transitions; the navigation/flow graph itself is derived downstream
// (#811). Three structural sources, read generically:
//   1. `interactions[].actions[]` — the CURRENT Figma prototype field. Each action with a
//      destination node id yields `{ sourceNodeId, trigger, targetNodeId }`; trigger comes from the
//      interaction's `trigger.type`.
//   2. `reactions[].action` — the LEGACY field, tolerated for older payloads, same projection.
//   3. CANVAS `flowStartingPoints[]` + `prototypeStartNodeID` — flow entry points, emitted as
//      `{ sourceNodeId: <canvasId>, trigger: "FLOW_START", targetNodeId }`.
//
// Links come from the pruned tree (hidden/dropped nodes emit nothing) plus the raw root for flow
// entry points. The output is sorted by a stable structural key so order never depends on traversal.

import { asNode, nodeId, readArray, readString, type FigmaSourceNode } from "./sourceNode.js";
import type { InterScreenLink } from "./irTypes.js";
import type { PrunedNode } from "./prune.js";

const FLOW_START = "FLOW_START";
const UNKNOWN_TRIGGER = "UNKNOWN";

const readDestination = (action: Record<string, unknown>): string | undefined => {
  const direct = readString(action.destinationId);
  if (direct !== undefined) return direct;
  const nav = asNode(action.navigation);
  if (nav !== undefined) return readString(nav.destinationId);
  return undefined;
};

const triggerType = (entry: Record<string, unknown>): string => {
  const trigger = asNode(entry.trigger);
  return (trigger !== undefined ? readString(trigger.type) : undefined) ?? UNKNOWN_TRIGGER;
};

const collectFromActions = (
  sourceNodeId: string,
  trigger: string,
  actions: readonly unknown[],
  out: InterScreenLink[],
): void => {
  for (const action of actions) {
    const record = asNode(action);
    if (record === undefined) continue;
    const targetNodeId = readDestination(record);
    if (targetNodeId !== undefined) out.push({ sourceNodeId, trigger, targetNodeId });
  }
};

const collectInteractions = (node: FigmaSourceNode, out: InterScreenLink[]): void => {
  const sourceNodeId = nodeId(node);
  for (const entry of readArray(node.interactions)) {
    const record = asNode(entry);
    if (record === undefined) continue;
    collectFromActions(sourceNodeId, triggerType(record), readArray(record.actions), out);
  }
  for (const entry of readArray(node.reactions)) {
    const record = asNode(entry);
    if (record === undefined) continue;
    const action = asNode(record.action);
    if (action === undefined) continue;
    collectFromActions(sourceNodeId, triggerType(record), [action], out);
  }
};

const visit = (pruned: PrunedNode, out: InterScreenLink[]): void => {
  collectInteractions(pruned.source, out);
  for (const child of pruned.children) visit(child, out);
};

const collectFlowEntries = (root: FigmaSourceNode, out: InterScreenLink[]): void => {
  const sourceNodeId = nodeId(root);
  for (const point of readArray(root.flowStartingPoints)) {
    const record = asNode(point);
    const target = record !== undefined ? readString(record.nodeId) : undefined;
    if (target !== undefined) out.push({ sourceNodeId, trigger: FLOW_START, targetNodeId: target });
  }
  const start = readString(root.prototypeStartNodeID);
  if (start !== undefined) out.push({ sourceNodeId, trigger: FLOW_START, targetNodeId: start });
};

const linkKey = (link: InterScreenLink): string =>
  `${link.sourceNodeId}\u0000${link.trigger}\u0000${link.targetNodeId}`;

/** Extract stable-ordered, deduped raw inter-screen links from the pruned tree + raw flow entries. */
export const extractInterScreenLinks = (
  rawRoot: FigmaSourceNode,
  screens: readonly PrunedNode[],
): readonly InterScreenLink[] => {
  const collected: InterScreenLink[] = [];
  collectFlowEntries(rawRoot, collected);
  for (const screen of screens) visit(screen, collected);

  const byKey = new Map<string, InterScreenLink>();
  for (const link of collected) byKey.set(linkKey(link), link);
  return [...byKey.values()].sort((a, b) => linkKey(a).localeCompare(linkKey(b)));
};
