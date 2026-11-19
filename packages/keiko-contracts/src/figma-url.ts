export interface FigmaTarget {
  readonly fileKey: string;
  readonly nodeId: string;
}

export type FigmaSnapshotLink =
  | { readonly kind: "valid"; readonly target: FigmaTarget }
  | { readonly kind: "missing-node-id" | "invalid" };

const FIGMA_ORIGIN = /^https:\/\/(?:www\.)?figma\.com(?::443)?\//u;
const FIGMA_PATHS: ReadonlySet<string> = new Set(["design", "file"]);
const FILE_KEY = /^[A-Za-z0-9]{1,128}$/u;
const NODE_ID = /^(?:\d+[:-]\d+|I\d+[:-]\d+(?:;\d+[:-]\d+)+)$/u;

export function normalizeFigmaNodeId(nodeId: string): string | undefined {
  if (nodeId.length > 256 || !NODE_ID.test(nodeId)) return undefined;
  return nodeId.replaceAll("-", ":");
}

function parseFigmaFileKey(pathname: string): string | undefined {
  const [, kind = "", mainFileKey = "", nameOrBranch, branchKey] = pathname.split("/");
  if (!FIGMA_PATHS.has(kind) || !FILE_KEY.test(mainFileKey)) return undefined;
  // In a branch URL the branch key is the identifier accepted by the Figma REST API.
  const fileKey = nameOrBranch === "branch" && branchKey !== undefined ? branchKey : mainFileKey;
  return FILE_KEY.test(fileKey) ? fileKey : undefined;
}

/** A single Figma node, with the same identity in UI history queries and Figma API requests. */
export function parseFigmaSnapshotLink(raw: string): FigmaSnapshotLink {
  const value = raw.trim();
  // Admit a known-valid scheme and authority before the browser normalizes the path and query.
  if (value.length > 4096 || !FIGMA_ORIGIN.test(value.toLowerCase())) {
    return { kind: "invalid" };
  }
  const url = new URL(value);

  const fileKey = parseFigmaFileKey(url.pathname);
  if (fileKey === undefined) return { kind: "invalid" };

  const [nodeId, ...additionalNodeIds] = url.searchParams.getAll("node-id");
  if (additionalNodeIds.length > 0) return { kind: "invalid" };
  if (nodeId === undefined || nodeId.length === 0) return { kind: "missing-node-id" };
  const normalized = normalizeFigmaNodeId(nodeId);
  if (normalized === undefined) return { kind: "invalid" };

  return { kind: "valid", target: { fileKey, nodeId: normalized } };
}
