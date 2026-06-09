// Minimal, untyped-tolerant input model for the raw scoped Figma node subtree (Epic #750, Issue #752).
//
// The cleaner consumes the raw Figma `document` node tree returned by the server-side connector
// (#751). That JSON is provider-shaped and only partially typed, so this module models the few
// fields the IR needs and exposes narrowing readers over `unknown` — never `any`. Direction is
// clean: this package depends on nothing from keiko-server; the readers tolerate absent/malformed
// fields so a single bad node never aborts the transform.

/**
 * The subset of a raw Figma node the cleaner reads. Open-ended (`[key: string]: unknown`) because
 * the provider payload carries many fields we ignore; readers narrow before use.
 */
export interface FigmaSourceNode {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly visible?: unknown;
  readonly children?: unknown;
  readonly [key: string]: unknown;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asNode = (value: unknown): FigmaSourceNode | undefined =>
  isRecord(value) ? value : undefined;

export const readString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const readArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

/** Figma omits `visible` when a node is shown; only an explicit `false` hides it. */
export const isHidden = (node: FigmaSourceNode): boolean => node.visible === false;

export const nodeId = (node: FigmaSourceNode): string => readString(node.id) ?? "";

export const nodeName = (node: FigmaSourceNode): string => readString(node.name) ?? "";

export const nodeType = (node: FigmaSourceNode): string => readString(node.type) ?? "";

export const childNodes = (node: FigmaSourceNode): readonly FigmaSourceNode[] => {
  const out: FigmaSourceNode[] = [];
  for (const child of readArray(node.children)) {
    const record = asNode(child);
    if (record !== undefined) out.push(record);
  }
  return out;
};
