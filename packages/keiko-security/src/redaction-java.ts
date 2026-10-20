import { createRequire } from "node:module";
import type { CstNode, IToken } from "java-parser";
import {
  projectSourceText,
  type SourceTextEdit,
  type SourceTextProjection,
} from "./redaction-source-map.js";
import type { ProjectionPorts, RedactionSpan } from "./redaction-code.js";

type JavaInput = SourceTextProjection;

interface JavaToken {
  readonly start: number;
  readonly end: number;
  readonly kind: "string" | "character" | "comment" | "text-block" | "number";
  readonly opening: number;
  readonly closing: number;
}

// JLS 3.3 translates eligible Unicode escapes before it recognizes comments and quotes.
function javaInput(source: string): JavaInput {
  const edits: SourceTextEdit[] = [];
  const escape = /\\u+[\da-fA-F]{4}/y;
  let backslashes = 0;
  let previousEscape = false;
  for (let at = 0; at < source.length; at += 1) {
    const eligible: boolean = previousEscape || backslashes % 2 === 0;
    escape.lastIndex = at;
    const match: RegExpExecArray | null =
      source[at] === "\\" && eligible ? escape.exec(source) : null;
    const decoded =
      match === null
        ? source.charAt(at)
        : String.fromCodePoint(Number.parseInt(match[0].slice(-4), 16));
    previousEscape = match !== null;
    backslashes = decoded === "\\" ? backslashes + 1 : 0;
    if (match === null) continue;
    edits.push({ start: at, end: at + match[0].length, replacement: decoded });
    at += match[0].length - 1;
  }
  return projectSourceText(source, edits);
}

function numericPlaceholder(value: string): string {
  if (/[lL]$/u.test(value)) return "0L";
  const floating = /^0[xX]/u.test(value) ? /[pP]/u.test(value) : /[.eEfFdD]/u.test(value);
  if (!floating) return "0";
  return /[fF]$/u.test(value) ? "0.0F" : "0.0";
}

function decodedLiteral(text: string): string {
  const simple: Readonly<Record<string, string>> = {
    b: "\b",
    t: "\t",
    n: "\n",
    f: "\f",
    r: "\r",
    s: " ",
    '"': '"',
    "'": "'",
    "\\": "\\",
  };
  return text.replace(/\\([0-3][0-7]{0,2}|[4-7][0-7]?|\r\n|\r|\n|.)/gu, (_match, value: string) => {
    if (/^[0-7]/u.test(value)) return String.fromCodePoint(Number.parseInt(value, 8));
    if (/^[\r\n]/u.test(value)) return "";
    return simple[value] ?? value;
  });
}

function javaMask(source: string, input: JavaInput, token: JavaToken): RedactionSpan {
  let start = input.rawOffset(token.start + token.opening);
  const end = input.rawOffset(token.end - token.closing);
  if (token.kind === "number")
    return {
      start,
      end,
      replacement: numericPlaceholder(input.text.slice(token.start, token.end)),
    };
  // A Java text block must retain its opening line terminator (JLS 3.10.6).
  if (token.kind === "text-block") {
    const line = /^[ \t]*(?:\r\n|\r|\n)/u.exec(input.text.slice(token.start + token.opening));
    start = input.rawOffset(token.start + token.opening + (line?.[0].length ?? 0));
  }
  const lineBreaks =
    source
      .slice(start, end)
      .match(/\r\n|\r|\n/gu)
      ?.join("") ?? "";
  return { start, end, replacement: token.kind === "character" ? "*" : "[REDACTED]" + lineBreaks };
}

const requireJava = createRequire(import.meta.url);
let parser: typeof import("java-parser") | undefined;

function javaApi(): typeof import("java-parser") {
  parser ??= requireJava("java-parser") as typeof import("java-parser");
  return parser;
}

export class JavaSyntaxRefusal extends Error {
  constructor() {
    super("Java code projection is unavailable");
    this.name = "JavaSyntaxRefusal";
  }
}

function javaTree(text: string): CstNode & { comments?: IToken[] } {
  try {
    return javaApi().parse(text);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    // Upstream diagnostics contain source/token bodies. Only this body-free refusal escapes.
    throw new JavaSyntaxRefusal();
  }
}

function children(node: CstNode): readonly (CstNode | IToken)[] {
  return Object.values(node.children).flat();
}

function nodes(node: CstNode, name: string): readonly CstNode[] {
  const items: readonly (CstNode | IToken)[] = node.children[name] ?? [];
  return items.filter((child): child is CstNode => "children" in child);
}

function assignmentName(node: CstNode): string | undefined {
  const pending = [node];
  let last: IToken | undefined;
  const excluded = new Set(["arrayAccessSuffix", "methodInvocationSuffix", "typeArguments"]);
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || excluded.has(current.name)) continue;
    for (const child of children(current)) {
      if ("children" in child) pending.push(child);
      else last = laterIdentifier(child, last);
    }
  }
  return last?.image;
}

function privateInitializer(node: CstNode, ports: ProjectionPorts): CstNode | undefined {
  if (node.name === "elementValuePair") return annotationInitializer(node, ports);
  if (node.name === "variableDeclarator") return declaredInitializer(node, ports);
  if (node.name !== "binaryExpression" || node.children.AssignmentOperator === undefined)
    return undefined;
  const lhs = nodes(node, "unaryExpression")[0];
  return lhs !== undefined && ports.sensitiveName(assignmentName(lhs) ?? "")
    ? nodes(node, "expression")[0]
    : undefined;
}

const NON_VALUE_NODES = new Set([
  "argumentList",
  "lambdaBody",
  "classBody",
  "dimExprs",
  "arrayAccessSuffix",
  "typeArguments",
]);

function valueChild(node: CstNode, child: CstNode): boolean {
  if (NON_VALUE_NODES.has(child.name)) return false;
  if (node.name === "conditionalExpression" && child.name === "binaryExpression")
    return node.children.QuestionMark === undefined;
  return true;
}

function javaDataToken(token: IToken): JavaToken | undefined {
  const name = token.tokenType.name;
  const common = { start: token.startOffset, end: token.endOffset + 1 };
  if (name === "TextBlock") return { ...common, kind: "text-block", opening: 3, closing: 3 };
  if (name === "StringLiteral") return { ...common, kind: "string", opening: 1, closing: 1 };
  if (name === "CharLiteral") return { ...common, kind: "character", opening: 1, closing: 1 };
  if (/^(?:Decimal|Hex|Octal|Binary|Float|HexFloat)Literal$/u.test(name))
    return { ...common, kind: "number", opening: 0, closing: 0 };
  return undefined;
}

// Character.isWhitespace, used by String.stripIndent (JLS 3.10.6), excludes non-breaking spaces.
function javaWhitespace(value: string): boolean {
  const code = value.codePointAt(0) ?? -1;
  return (
    /^[\t-\r \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]$/u.test(value) ||
    (code >= 0x1c && code <= 0x1f)
  );
}

function leadingWhitespace(value: string): number {
  let length = 0;
  while (length < value.length && javaWhitespace(value.charAt(length))) length += 1;
  return length;
}

function stripIndentLine(value: string, indent: number): string {
  const start = Math.min(indent, leadingWhitespace(value));
  let end = value.length;
  while (end > start && javaWhitespace(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

function textBlockValue(body: string): string {
  const content = body.replace(/^[ \t\f]*(?:\r\n|\r|\n)/u, "").replace(/\r\n|\r/gu, "\n");
  const lines = content.split("\n");
  let indent = Number.POSITIVE_INFINITY;
  for (const [index, line] of lines.entries()) {
    const leading = leadingWhitespace(line);
    if (leading < line.length || index === lines.length - 1) indent = Math.min(indent, leading);
  }
  return decodedLiteral(lines.map((line) => stripIndentLine(line, indent)).join("\n"));
}

function tokenValue(input: string, token: JavaToken): string {
  const body = input.slice(token.start + token.opening, token.end - token.closing);
  return token.kind === "text-block" ? textBlockValue(body) : decodedLiteral(body);
}

interface JavaFrame {
  readonly node: CstNode;
  readonly sensitive: boolean;
  readonly composed: boolean;
}

interface ObservedJavaLiteral {
  readonly data: JavaToken;
  readonly value: string;
  readonly sensitive: boolean;
}

function observeJavaLiteral(
  input: JavaInput,
  token: IToken,
  frame: JavaFrame,
  ports: ProjectionPorts,
): ObservedJavaLiteral | undefined {
  const data = javaDataToken(token);
  if (data === undefined) return undefined;
  const value = tokenValue(input.text, data);
  return {
    data,
    value,
    sensitive: frame.sensitive && !(frame.composed && ports.publicPrefix(value)),
  };
}

function javaLiteralSpans(
  source: string,
  input: JavaInput,
  literals: readonly ObservedJavaLiteral[],
  ports: ProjectionPorts,
): RedactionSpan[] {
  const values = new Set(literals.filter((literal) => literal.sensitive).map(javaLiteralKey));
  return literals
    .filter(
      (literal) =>
        literal.sensitive ||
        values.has(javaLiteralKey(literal)) ||
        ports.redactPlain(literal.value) !== literal.value,
    )
    .map((literal) => javaMask(source, input, literal.data));
}

function javaLiteralKey(literal: ObservedJavaLiteral): string {
  return `${literal.data.kind}:${literal.value}`;
}

/** Java CST owns declarator/assignment boundaries; source is never compiled or executed here. */
export function projectJavaData(source: string, ports: ProjectionPorts): readonly RedactionSpan[] {
  const input = javaInput(source);
  const tree = javaTree(input.text);
  const literals: ObservedJavaLiteral[] = [];
  const pending: JavaFrame[] = [{ node: tree, sensitive: false, composed: false }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) break;
    visitJavaFrame(input, frame, ports, pending, literals);
  }
  const spans = javaLiteralSpans(source, input, literals, ports);
  for (const token of tree.comments ?? []) {
    if (ports.redactPlain(token.image) === token.image) continue;
    spans.push(
      javaMask(source, input, {
        start: token.startOffset,
        end: token.endOffset + 1,
        kind: "comment",
        opening: 2,
        closing: token.image.endsWith("*/") ? 2 : 0,
      }),
    );
  }
  return spans;
}

export function isJavaSource(source: string): boolean {
  try {
    const tree = javaTree(javaInput(source).text);
    const pending = [tree];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) break;
      if (SOURCE_DECLARATIONS.has(node.name)) return true;
      for (const child of children(node)) if ("children" in child) pending.push(child);
    }
    return false;
  } catch (error) {
    if (error instanceof JavaSyntaxRefusal) return false;
    throw error;
  }
}

function laterIdentifier(token: IToken, previous: IToken | undefined): IToken | undefined {
  return token.tokenType.name === "Identifier" && token.startOffset > (previous?.startOffset ?? -1)
    ? token
    : previous;
}

function visitJavaFrame(
  input: JavaInput,
  frame: JavaFrame,
  ports: ProjectionPorts,
  pending: JavaFrame[],
  literals: ObservedJavaLiteral[],
): void {
  const owned = privateInitializer(frame.node, ports);
  const composed =
    frame.composed ||
    frame.node.children.BinaryOperator?.some((op) => "image" in op && op.image === "+") === true;
  for (const child of children(frame.node)) {
    if ("children" in child) {
      pending.push({
        node: child,
        sensitive: owned === child || (frame.sensitive && valueChild(frame.node, child)),
        composed,
      });
    } else {
      const literal = observeJavaLiteral(input, child, { ...frame, composed }, ports);
      if (literal !== undefined) literals.push(literal);
    }
  }
}

const SOURCE_DECLARATIONS: ReadonlySet<string> = new Set([
  "classDeclaration",
  "interfaceDeclaration",
  "methodDeclaration",
  "fieldDeclaration",
  "localVariableDeclaration",
]);

function annotationInitializer(node: CstNode, ports: ProjectionPorts): CstNode | undefined {
  const name = node.children.Identifier?.[0];
  return name !== undefined && "image" in name && ports.sensitiveName(name.image)
    ? nodes(node, "elementValue")[0]
    : undefined;
}

function declaredInitializer(node: CstNode, ports: ProjectionPorts): CstNode | undefined {
  const name = nodes(node, "variableDeclaratorId")[0];
  return name !== undefined && ports.sensitiveName(assignmentName(name) ?? "")
    ? nodes(node, "variableInitializer")[0]
    : undefined;
}
