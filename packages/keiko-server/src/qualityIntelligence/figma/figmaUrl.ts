// Figma URL → scoped target parsing (Epic #750, Issue #751).
//
// Pure, deterministic. Extracts a file-key + node-id from a pasted Figma board/section
// link. A link WITHOUT a node-id is rejected (null) so the connector can never default to
// a whole-file pull. Figma URLs encode node-ids with `-` (e.g. `0-1`); the REST API uses
// `:` (e.g. `0:1`), so the parsed node-id is normalised to the API form.

export interface FigmaTarget {
  readonly fileKey: string;
  readonly nodeId: string;
}

const ACCEPTED_HOSTS: readonly string[] = ["figma.com", "www.figma.com"];
const SCOPED_PATH_KINDS: readonly string[] = ["design", "file"];

const normaliseNodeId = (raw: string): string => raw.replace(/-/g, ":");

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export const parseFigmaTarget = (value: string): FigmaTarget | null => {
  const url = parseUrl(value.trim());
  if (url === null) return null;
  if (!ACCEPTED_HOSTS.includes(url.hostname)) return null;

  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  const [kind, fileKey] = segments;
  if (kind === undefined || !SCOPED_PATH_KINDS.includes(kind)) return null;
  if (fileKey === undefined || fileKey.length === 0) return null;

  const rawNodeId = url.searchParams.get("node-id");
  if (rawNodeId === null || rawNodeId.length === 0) return null;

  return { fileKey, nodeId: normaliseNodeId(rawNodeId) };
};
