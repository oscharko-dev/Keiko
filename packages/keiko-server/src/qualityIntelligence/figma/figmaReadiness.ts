// Figma readiness resolution (Epic #750, Issue #751).
//
// Pure, deterministic. Resolves whether a scoped node subtree is "release-ready" using a
// fixed precedence with graceful fallback:
//
//   1. version  — a pinned version id was supplied (operator pinned a named version).
//   2. section  — a node anywhere in the subtree is named with a configurable release
//                 marker (default case-insensitive substring `release`).
//   3. devStatus — one or more nodes carry Dev-Mode `devStatus.type === "READY_FOR_DEV"`.
//
// `devStatus` is OPTIONAL in the Figma REST response and may be absent for an entire
// account/plan. When it is absent (or no node is READY_FOR_DEV) and the higher signals
// did not fire, the result degrades to `{ source: "none", ready: false }`. The connector
// still returns the scoped subtree — readiness is advisory provenance, not a gate here.

export interface FigmaDevStatus {
  readonly type: string;
}

export interface FigmaNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly devStatus?: FigmaDevStatus;
  readonly children?: readonly FigmaNode[];
}

export interface ReadinessOptions {
  readonly version?: string | undefined;
  readonly releaseMarker?: string | undefined;
}

export type ReadinessSignal =
  | { readonly source: "version"; readonly ready: true; readonly version: string }
  | { readonly source: "section"; readonly ready: true; readonly matchedNodeName: string }
  | { readonly source: "devStatus"; readonly ready: true; readonly readyNodeCount: number }
  | { readonly source: "none"; readonly ready: false };

const DEFAULT_RELEASE_MARKER = "release";
const READY_FOR_DEV = "READY_FOR_DEV";

const walk = (node: FigmaNode, visit: (n: FigmaNode) => boolean): boolean => {
  if (visit(node)) return true;
  for (const child of node.children ?? []) {
    if (walk(child, visit)) return true;
  }
  return false;
};

const findReleaseNamedNode = (root: FigmaNode, marker: string): FigmaNode | undefined => {
  const needle = marker.toLowerCase();
  let match: FigmaNode | undefined;
  walk(root, (node) => {
    if (node.name.toLowerCase().includes(needle)) {
      match = node;
      return true;
    }
    return false;
  });
  return match;
};

const countReadyForDevNodes = (root: FigmaNode): number => {
  let count = 0;
  walk(root, (node) => {
    if (node.devStatus?.type === READY_FOR_DEV) count += 1;
    return false;
  });
  return count;
};

export const resolveReadiness = (root: FigmaNode, options: ReadinessOptions): ReadinessSignal => {
  if (options.version !== undefined && options.version.length > 0) {
    return { source: "version", ready: true, version: options.version };
  }

  const marker = options.releaseMarker ?? DEFAULT_RELEASE_MARKER;
  const namedNode = findReleaseNamedNode(root, marker);
  if (namedNode !== undefined) {
    return { source: "section", ready: true, matchedNodeName: namedNode.name };
  }

  const readyNodeCount = countReadyForDevNodes(root);
  if (readyNodeCount > 0) {
    return { source: "devStatus", ready: true, readyNodeCount };
  }

  return { source: "none", ready: false };
};
