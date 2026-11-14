import type { CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { CatalogExpectation } from "./errors.js";

/**
 * What a schema states at one property, as a phrase that completes "<path> must be …": type,
 * allowed values, format, length and numeric bounds. It is read from the tool's own schema and
 * never from the rejected value, so a correction can say what is expected without quoting what was
 * sent. Every list and string is bounded; a keyword it does not understand adds nothing.
 */
const RULE_CHARS_MAX = 160;
const NAMES_MAX = 8;
const VALUE_CHARS_MAX = 48;
const PATTERN_CHARS_MAX = 48;
/** At most this many properties are explained for one rejection, so the account stays one sentence. */
export const EXPECTATIONS_MAX = 8;

const SINGULAR: Readonly<Record<string, string>> = {
  string: "a string",
  integer: "an integer",
  number: "a number",
  boolean: "a boolean",
  object: "an object",
  array: "an array",
  null: "null",
};
const PLURAL: Readonly<Record<string, string>> = {
  string: "strings",
  integer: "integers",
  number: "numbers",
  boolean: "booleans",
  object: "objects",
  array: "arrays",
  null: "nulls",
};

type Node = Readonly<Record<string, CatalogJsonValue>>;
function isNode(value: CatalogJsonValue | undefined): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function typeNames(node: Node): readonly string[] {
  const type = node.type;
  const names = Array.isArray(type) ? type : [type];
  return names.filter((name): name is string => typeof name === "string" && name in SINGULAR);
}
function requiredNames(node: Node): readonly string[] {
  const required = Array.isArray(node.required) ? (node.required as readonly unknown[]) : [];
  return required.filter(
    (name): name is string => typeof name === "string" && name.length <= VALUE_CHARS_MAX,
  );
}
/** The one type a node names, with what the schema says of its members, or undefined. */
function singleTypePhrase(node: Node, name: string): string | undefined {
  const items = isNode(node.items) ? typeNames(node.items) : [];
  if (name === "array" && items.length === 1)
    return `an array of ${PLURAL[items[0] ?? ""] ?? "values"}`;
  const required = name === "object" ? requiredNames(node) : [];
  return required.length > 0 && required.length <= NAMES_MAX
    ? `an object with the required properties ${required.join(", ")}`
    : undefined;
}
function typePhrase(node: Node): string | undefined {
  const names = typeNames(node);
  if (names.length === 0) return undefined;
  const [only] = names;
  const single =
    names.length === 1 && only !== undefined ? singleTypePhrase(node, only) : undefined;
  return single ?? names.map((name) => SINGULAR[name]).join(" or ");
}
function allowedPhrase(node: Node): string | undefined {
  const declared = node.const !== undefined ? [node.const] : node.enum;
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > NAMES_MAX)
    return undefined;
  const values = declared.filter(
    (entry) =>
      entry === null ||
      typeof entry === "boolean" ||
      typeof entry === "number" ||
      (typeof entry === "string" && entry.length <= VALUE_CHARS_MAX),
  );
  return values.length === declared.length
    ? `one of ${values.map((value) => JSON.stringify(value)).join(", ")}`
    : undefined;
}
type Noun = readonly [singular: string, plural: string];
function counted(count: number, noun: Noun | undefined): string {
  if (noun === undefined) return String(count);
  const word = count === 1 ? noun[0] : noun[1];
  return `${String(count)} ${word}`;
}
function bounds(node: Node, lower: string, upper: string, noun?: Noun): string | undefined {
  const min = node[lower];
  const max = node[upper];
  const low = typeof min === "number" && Number.isFinite(min);
  const high = typeof max === "number" && Number.isFinite(max);
  if (low && high) return `${String(min)} to ${counted(max, noun)}`;
  if (low) return `at least ${counted(min, noun)}`;
  return high ? `at most ${counted(max, noun)}` : undefined;
}
function patternPhrase(node: Node): string | undefined {
  const pattern = node.pattern;
  return typeof pattern === "string" && pattern.length <= PATTERN_CHARS_MAX
    ? `matching ${pattern}`
    : undefined;
}

const ALTERNATIVES_MAX = 4;
/** A property that accepts one of a few shapes ("a string or null"): each branch's own rule. */
function alternativesRule(node: Node): string | undefined {
  const declared = Array.isArray(node.anyOf) ? node.anyOf : node.oneOf;
  if (!Array.isArray(declared)) return undefined;
  const branches = declared as readonly CatalogJsonValue[];
  if (branches.length < 2 || branches.length > ALTERNATIVES_MAX) return undefined;
  const rules = branches.map((branch) => expectationRule(branch));
  return rules.every((rule) => rule !== undefined) ? rules.join(" or ") : undefined;
}

export function expectationRule(node: CatalogJsonValue | undefined): string | undefined {
  if (!isNode(node)) return undefined;
  const alternatives = alternativesRule(node);
  if (alternatives !== undefined) return clipped(alternatives);
  const allowed = allowedPhrase(node);
  const type = allowed === undefined ? typePhrase(node) : undefined;
  const format = typeof node.format === "string" ? `in ${node.format} format` : undefined;
  const parts = [
    allowed ?? type,
    format,
    bounds(node, "minLength", "maxLength", ["character", "characters"]),
    bounds(node, "minimum", "maximum"),
    bounds(node, "minItems", "maxItems", ["item", "items"]),
    patternPhrase(node),
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) return undefined;
  return clipped(parts.join(", "));
}
function clipped(rule: string): string {
  return rule.length <= RULE_CHARS_MAX ? rule : `${rule.slice(0, RULE_CHARS_MAX - 1)}…`;
}

/** Distinct paths, first rule wins, sorted by path and bounded; an unexplained path adds nothing. */
export function collectExpectations(
  entries: Iterable<{ readonly path: string; readonly node: CatalogJsonValue | undefined }>,
): readonly CatalogExpectation[] {
  const byPath = new Map<string, string>();
  for (const { path, node } of entries) {
    const rule = expectationRule(node);
    if (rule !== undefined && !byPath.has(path)) byPath.set(path, rule);
  }
  return [...byPath]
    .sort(([left], [right]) => (left < right ? -1 : Number(left > right)))
    .slice(0, EXPECTATIONS_MAX)
    .map(([path, rule]) => ({ path, rule }));
}
