// Figma readiness resolution (Epic #750, Issue #751).
//
// Pure, deterministic. Resolves whether a scoped node subtree is "release-ready" using a
// fixed precedence with graceful fallback:
//
//   1. version  — a pinned version id was supplied (operator pinned a named version).
//   2. section  — a node anywhere in the subtree is named with a configurable release
//                 marker (default case-insensitive token `release`).
//   3. devStatus — one or more nodes carry Dev-Mode `devStatus.type === "READY_FOR_DEV"`.
//
// `devStatus` is OPTIONAL in the Figma REST response and may be absent for an entire
// account/plan. When it is absent (or no node is READY_FOR_DEV) and the higher signals
// did not fire, the result degrades to `{ source: "none", ready: false }`.

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
const TOKEN_SPLIT = /[^a-z0-9]+/u;
const NEGATED_RELEASE_NAME =
  /\b(?:unreleased|not\s+(?:for\s+)?release|no\s+release|non[-\s]+release)\b/iu;

const walk = (node: FigmaNode, visit: (n: FigmaNode) => boolean): boolean => {
  if (visit(node)) return true;
  for (const child of node.children ?? []) {
    if (walk(child, visit)) return true;
  }
  return false;
};

const findReleaseNamedNode = (root: FigmaNode, marker: string): FigmaNode | undefined => {
  const needle = marker.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  let match: FigmaNode | undefined;
  walk(root, (node) => {
    const lowerName = node.name.toLowerCase();
    const tokens = lowerName.split(TOKEN_SPLIT).filter((token) => token.length > 0);
    const markerMatched =
      tokens.includes(needle) || (needle === DEFAULT_RELEASE_MARKER && tokens.includes("released"));
    if (markerMatched && !NEGATED_RELEASE_NAME.test(lowerName)) {
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
