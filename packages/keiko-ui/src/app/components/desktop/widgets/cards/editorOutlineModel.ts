import type { EditorDocumentSymbol, EditorPosition, EditorRange } from "@oscharko-dev/keiko-editor";

export interface EditorOutlineNode {
  readonly id: string;
  readonly symbol: EditorDocumentSymbol;
  readonly depth: number;
  readonly parentId?: string | undefined;
  readonly children: readonly EditorOutlineNode[];
}

export interface EditorOutlineSnapshot {
  readonly filePath?: string | undefined;
  readonly symbols: readonly EditorDocumentSymbol[];
  readonly cursor: EditorPosition | null;
  readonly enabled: boolean;
  readonly loading: boolean;
}

export interface EditorOutlineRevealRequest {
  readonly id: string;
  readonly file: string;
  readonly range: EditorRange;
}

interface MutableOutlineNode {
  readonly id: string;
  readonly symbol: EditorDocumentSymbol;
  readonly index: number;
  parentId?: string | undefined;
  readonly children: MutableOutlineNode[];
}

function comparePosition(left: EditorPosition, right: EditorPosition): number {
  if (left.line !== right.line) return left.line - right.line;
  return left.column - right.column;
}

function sameRange(left: EditorRange, right: EditorRange): boolean {
  return (
    comparePosition(left.start, right.start) === 0 && comparePosition(left.end, right.end) === 0
  );
}

function rangeContainsPosition(range: EditorRange, position: EditorPosition): boolean {
  return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

function rangeContainsRange(outer: EditorRange, inner: EditorRange): boolean {
  return (
    !sameRange(outer, inner) &&
    comparePosition(outer.start, inner.start) <= 0 &&
    comparePosition(inner.end, outer.end) <= 0
  );
}

function rangeSize(range: EditorRange): number {
  return (range.end.line - range.start.line) * 100_000 + (range.end.column - range.start.column);
}

function symbolNodeId(symbol: EditorDocumentSymbol, index: number): string {
  return `${String(index)}:${symbol.kind}:${symbol.name}:${String(symbol.range.start.line)}:${String(
    symbol.range.start.column,
  )}`;
}

function compareMutableNodes(left: MutableOutlineNode, right: MutableOutlineNode): number {
  const byStart = comparePosition(left.symbol.range.start, right.symbol.range.start);
  if (byStart !== 0) return byStart;
  const byEnd = comparePosition(left.symbol.range.end, right.symbol.range.end);
  return byEnd !== 0 ? byEnd : left.index - right.index;
}

function findParentIndex(nodes: readonly MutableOutlineNode[], childIndex: number): number {
  const child = nodes[childIndex];
  if (child === undefined) return -1;
  let parentIndex = -1;
  for (let index = 0; index < nodes.length; index += 1) {
    const parent = nodes[index];
    if (parent === undefined || index === childIndex) continue;
    if (!rangeContainsRange(parent.symbol.range, child.symbol.range)) continue;
    const currentParent = parentIndex < 0 ? undefined : nodes[parentIndex];
    if (
      currentParent === undefined ||
      rangeSize(parent.symbol.range) < rangeSize(currentParent.symbol.range)
    ) {
      parentIndex = index;
    }
  }
  return parentIndex;
}

function toOutlineNode(node: MutableOutlineNode, depth: number): EditorOutlineNode {
  return {
    id: node.id,
    symbol: node.symbol,
    depth,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    children: node.children
      .sort(compareMutableNodes)
      .map((child) => toOutlineNode(child, depth + 1)),
  };
}

export function buildEditorOutlineTree(
  symbols: readonly EditorDocumentSymbol[],
): readonly EditorOutlineNode[] {
  const nodes = symbols.map<MutableOutlineNode>((symbol, index) => ({
    id: symbolNodeId(symbol, index),
    symbol,
    index,
    children: [],
  }));
  const roots: MutableOutlineNode[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const parentIndex = findParentIndex(nodes, index);
    const parent = parentIndex < 0 ? undefined : nodes[parentIndex];
    if (parent === undefined) roots.push(node);
    else {
      node.parentId = parent.id;
      parent.children.push(node);
    }
  }
  return roots.sort(compareMutableNodes).map((node) => toOutlineNode(node, 1));
}

function flattenInto(
  node: EditorOutlineNode,
  expandedIds: ReadonlySet<string>,
  out: EditorOutlineNode[],
): void {
  out.push(node);
  if (node.children.length === 0 || !expandedIds.has(node.id)) return;
  for (const child of node.children) flattenInto(child, expandedIds, out);
}

export function flattenEditorOutlineTree(
  nodes: readonly EditorOutlineNode[],
  expandedIds: ReadonlySet<string>,
): readonly EditorOutlineNode[] {
  const out: EditorOutlineNode[] = [];
  for (const node of nodes) flattenInto(node, expandedIds, out);
  return out;
}

function containingPathInNode(
  node: EditorOutlineNode,
  position: EditorPosition,
): readonly EditorOutlineNode[] {
  if (!rangeContainsPosition(node.symbol.range, position)) return [];
  for (const child of node.children) {
    const childPath = containingPathInNode(child, position);
    if (childPath.length > 0) return [node, ...childPath];
  }
  return [node];
}

export function findContainingOutlinePath(
  nodes: readonly EditorOutlineNode[],
  position: EditorPosition | null,
): readonly EditorOutlineNode[] {
  if (position === null) return [];
  for (const node of nodes) {
    const path = containingPathInNode(node, position);
    if (path.length > 0) return path;
  }
  return [];
}

function sameSymbol(left: EditorDocumentSymbol, right: EditorDocumentSymbol): boolean {
  return (
    left.name === right.name &&
    left.kind === right.kind &&
    sameRange(left.range, right.range) &&
    left.detail === right.detail &&
    left.containerName === right.containerName
  );
}

export function sameEditorOutlineSnapshot(
  left: EditorOutlineSnapshot | undefined,
  right: EditorOutlineSnapshot,
): boolean {
  if (left === undefined) return false;
  if (
    left.filePath !== right.filePath ||
    left.enabled !== right.enabled ||
    left.loading !== right.loading ||
    left.cursor?.line !== right.cursor?.line ||
    left.cursor?.column !== right.cursor?.column ||
    left.symbols.length !== right.symbols.length
  ) {
    return false;
  }
  return left.symbols.every((symbol, index) => {
    const other = right.symbols[index];
    return other !== undefined && sameSymbol(symbol, other);
  });
}
