const REDACTED = "[REDACTED]";

interface LiteralSpan {
  start: number;
  end: number;
}

interface LiteralNode {
  readonly transitions: Map<string, number>;
  failure: number;
  longestMatch: number;
}

export interface LiteralRedactionResult {
  readonly value: string;
  readonly count: number;
}

function normalizedLiterals(literals: readonly string[]): readonly string[] {
  return [...new Set(literals.filter((literal) => literal.length > 0))].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
}

function createNode(): LiteralNode {
  return { transitions: new Map(), failure: 0, longestMatch: 0 };
}

function nodeAt(nodes: readonly LiteralNode[], index: number): LiteralNode {
  const node = nodes[index];
  if (node === undefined) throw new Error("literal automaton invariant violated");
  return node;
}

function addLiteral(nodes: LiteralNode[], literal: string): void {
  let state = 0;
  for (const character of literal.split("")) {
    const node = nodeAt(nodes, state);
    let next = node.transitions.get(character);
    if (next === undefined) {
      next = nodes.length;
      node.transitions.set(character, next);
      nodes.push(createNode());
    }
    state = next;
  }
  const terminal = nodeAt(nodes, state);
  terminal.longestMatch = Math.max(terminal.longestMatch, literal.length);
}

function failureState(nodes: readonly LiteralNode[], state: number, character: string): number {
  let fallback = nodeAt(nodes, state).failure;
  while (fallback !== 0 && !nodeAt(nodes, fallback).transitions.has(character)) {
    fallback = nodeAt(nodes, fallback).failure;
  }
  return nodeAt(nodes, fallback).transitions.get(character) ?? 0;
}

function linkFailures(nodes: LiteralNode[]): void {
  const queue = [...nodeAt(nodes, 0).transitions.values()];
  let head = 0;
  while (head < queue.length) {
    const state = queue[head] ?? 0;
    head += 1;
    for (const [character, child] of nodeAt(nodes, state).transitions) {
      const childNode = nodeAt(nodes, child);
      childNode.failure = failureState(nodes, state, character);
      childNode.longestMatch = Math.max(
        childNode.longestMatch,
        nodeAt(nodes, childNode.failure).longestMatch,
      );
      queue.push(child);
    }
  }
}

function literalAutomaton(literals: readonly string[]): readonly LiteralNode[] {
  const nodes = [createNode()];
  for (const literal of literals) addLiteral(nodes, literal);
  linkFailures(nodes);
  return nodes;
}

function nextState(nodes: readonly LiteralNode[], state: number, character: string): number {
  let current = state;
  while (current !== 0 && !nodeAt(nodes, current).transitions.has(character)) {
    current = nodeAt(nodes, current).failure;
  }
  return nodeAt(nodes, current).transitions.get(character) ?? 0;
}

function mergeSpan(union: LiteralSpan[], start: number, end: number): void {
  const last = union.at(-1);
  if (last === undefined || start >= last.end) {
    union.push({ start, end });
    return;
  }
  last.start = Math.min(last.start, start);
  last.end = Math.max(last.end, end);
  while (union.length > 1) {
    const current = union.at(-1);
    const previous = union.at(-2);
    if (current === undefined || previous === undefined || current.start >= previous.end) return;
    previous.start = Math.min(previous.start, current.start);
    previous.end = Math.max(previous.end, current.end);
    union.pop();
  }
}

function literalUnionSpans(input: string, literals: readonly string[]): readonly LiteralSpan[] {
  const nodes = literalAutomaton(literals);
  const union: LiteralSpan[] = [];
  let state = 0;
  for (let index = 0; index < input.length; index += 1) {
    state = nextState(nodes, state, input[index] ?? "");
    const length = nodeAt(nodes, state).longestMatch;
    if (length > 0) {
      mergeSpan(union, index + 1 - length, index + 1);
    }
  }
  return union;
}

function applyLiteralSpans(input: string, spans: readonly LiteralSpan[]): string {
  if (spans.length === 0) return input;
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(input.slice(cursor, span.start), REDACTED);
    cursor = span.end;
  }
  parts.push(input.slice(cursor));
  return parts.join("");
}

export function redactLiteralUnion(
  input: string,
  literals: readonly string[],
): LiteralRedactionResult {
  const normalized = normalizedLiterals(literals);
  if (input.length === 0 || normalized.length === 0) return { value: input, count: 0 };
  const spans = literalUnionSpans(input, normalized);
  return { value: applyLiteralSpans(input, spans), count: spans.length };
}
