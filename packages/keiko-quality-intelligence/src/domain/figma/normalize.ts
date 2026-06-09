// Per-node normalization of the pruned tree into IR nodes (Epic #750, Issue #752).
//
// Projects each kept node to a compact `IrNode`: id/name/type, text content, bounding box, image
// fill refs, kept children, and a best-effort `interactionHint`.
//
// The interaction hint is a HINT, never load-bearing — downstream (#754) treats button/input
// classification as advisory and degrades to `container`. Three classes are purely structural:
//   link  — the node carries a navigating prototype interaction/reaction (it navigates).
//   image — the node has an IMAGE-type fill (and is not TEXT).
//   text  — the node is a TEXT node.
// `button`/`input` are the one accepted name heuristic: a tiny, word-boundary, case-insensitive
// match over the conventional design-system role vocabulary. Boards that don't use these words fall
// back to `container` — no board's specific names are encoded.

import {
  asNode,
  nodeId,
  nodeName,
  nodeType,
  readArray,
  readNumber,
  readString,
  type FigmaSourceNode,
} from "./sourceNode.js";
import { firstSolidPaintHex } from "./color.js";
import type { BoundingBox, ImageFillRef, InteractionHint, IrNode } from "./irTypes.js";
import type { PrunedNode } from "./prune.js";

const BUTTON_ROLE = /\b(?:button|btn|cta)\b/iu;
const INPUT_ROLE = /\b(?:input|field|textfield|textbox)\b/iu;

const readBoundingBox = (node: FigmaSourceNode): BoundingBox | undefined => {
  const box = asNode(node.absoluteBoundingBox);
  if (box === undefined) return undefined;
  const x = readNumber(box.x);
  const y = readNumber(box.y);
  const width = readNumber(box.width);
  const height = readNumber(box.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
};

const readImageFills = (node: FigmaSourceNode): readonly ImageFillRef[] => {
  const out: ImageFillRef[] = [];
  for (const fill of readArray(node.fills)) {
    const record = asNode(fill);
    if (record === undefined || readString(record.type) !== "IMAGE") continue;
    const imageRef = readString(record.imageRef);
    if (imageRef !== undefined) out.push({ imageRef });
  }
  return out;
};

const navigates = (node: FigmaSourceNode): boolean => {
  const interactions = readArray(node.interactions);
  const reactions = readArray(node.reactions);
  return interactions.length > 0 || reactions.length > 0;
};

const classify = (node: FigmaSourceNode, imageFills: readonly ImageFillRef[]): InteractionHint => {
  if (nodeType(node) === "TEXT") return "text";
  if (navigates(node)) return "link";
  if (imageFills.length > 0) return "image";
  const name = nodeName(node);
  if (BUTTON_ROLE.test(name)) return "button";
  if (INPUT_ROLE.test(name)) return "input";
  return "container";
};

// A TEXT node's solid fill is its foreground (text) colour; any other node's solid fill is a
// background. We project at most one of each so the a11y contrast pass (#812) has a deterministic
// text-vs-background pairing without re-deriving paints. Both are absent when there is no solid fill.
const readTextColor = (node: FigmaSourceNode): string | undefined =>
  nodeType(node) === "TEXT" ? firstSolidPaintHex(node, "fills") : undefined;

const readBackgroundColor = (node: FigmaSourceNode): string | undefined =>
  nodeType(node) === "TEXT" ? undefined : firstSolidPaintHex(node, "fills");

const buildNode = (pruned: PrunedNode): IrNode => {
  const node = pruned.source;
  const imageFills = readImageFills(node);
  const text = readString(node.characters);
  const boundingBox = readBoundingBox(node);
  const textColor = readTextColor(node);
  const backgroundColor = readBackgroundColor(node);
  return {
    id: nodeId(node),
    name: nodeName(node),
    type: nodeType(node),
    interactionHint: classify(node, imageFills),
    ...(text !== undefined ? { text } : {}),
    ...(boundingBox !== undefined ? { boundingBox } : {}),
    ...(textColor !== undefined ? { textColor } : {}),
    ...(backgroundColor !== undefined ? { backgroundColor } : {}),
    imageFills,
    children: pruned.children.map(buildNode),
  };
};

/** Normalize a pruned screen root into its IR node tree. Child order follows source order. */
export const normalizeScreenRoot = (pruned: PrunedNode): IrNode => buildNode(pruned);

/** Count the IR nodes in a normalized tree, used for the reduction ratio. */
export const countIrNodes = (node: IrNode): number =>
  1 + node.children.reduce((sum, child) => sum + countIrNodes(child), 0);
