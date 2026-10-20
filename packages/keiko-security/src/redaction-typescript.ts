import type Ts from "typescript";
import { createRequire } from "node:module";
import type { ProjectionPorts, RedactionSpan } from "./redaction-code.js";

const loadTypeScript = createRequire(import.meta.url);
let compiler: typeof Ts | undefined;

export class TypeScriptSyntaxRefusal extends Error {
  constructor() {
    super("TypeScript code projection is unavailable");
    this.name = "TypeScriptSyntaxRefusal";
  }
}

function typescriptApi(): typeof Ts {
  compiler ??= loadTypeScript("typescript") as typeof Ts;
  return compiler;
}

export function maskedLiteralBody(text: string): string {
  return "[REDACTED]" + (text.match(/\r\n|\r|\n/gu)?.join("") ?? "");
}

function literalSpan(
  source: string,
  start: number,
  end: number,
  opening: number,
  closing: number,
): RedactionSpan {
  const bodyStart = start + opening;
  const bodyEnd = Math.max(bodyStart, end - closing);
  return {
    start: bodyStart,
    end: bodyEnd,
    replacement: maskedLiteralBody(source.slice(bodyStart, bodyEnd)),
  };
}

function sourceLiteral(
  node: Ts.Node,
): node is Ts.StringLiteral | Ts.NoSubstitutionTemplateLiteral | Ts.TemplateLiteralLikeNode {
  const ts = typescriptApi();
  return (
    ts.isStringLiteralLike(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddleOrTemplateTail(node)
  );
}

function literalBoundaries(node: Ts.Node): { readonly opening: number; readonly closing: number } {
  const ts = typescriptApi();
  if ("isUnterminated" in node && node.isUnterminated === true) return { opening: 1, closing: 0 };
  const closing = ts.isTemplateHead(node) || node.kind === ts.SyntaxKind.TemplateMiddle ? 2 : 1;
  return { opening: 1, closing };
}

function propertyText(name: Ts.Node | undefined): string | undefined {
  const ts = typescriptApi();
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name))
    return name.text;
  if (ts.isComputedPropertyName(name)) return propertyText(name.expression);
  return undefined;
}

function assignmentName(node: Ts.BinaryExpression): Ts.Node {
  const ts = typescriptApi();
  if (ts.isPropertyAccessExpression(node.left)) return node.left.name;
  return ts.isElementAccessExpression(node.left) ? node.left.argumentExpression : node.left;
}

function valueName(node: Ts.Node): Ts.Node | undefined {
  const ts = typescriptApi();
  if (ts.isBindingElement(node)) return node.propertyName ?? node.name;
  if (ts.isVariableDeclaration(node) || ts.isParameter(node)) return node.name;
  if (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) return node.name;
  if (ts.isJsxAttribute(node)) return node.name;
  return assignmentValueName(node);
}

function assignmentValueName(node: Ts.Node): Ts.Node | undefined {
  const ts = typescriptApi();
  return ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ? assignmentName(node)
    : undefined;
}

function sensitiveInitializer(node: Ts.Node, ports: ProjectionPorts): Ts.Node | undefined {
  const ts = typescriptApi();
  const names = [valueName(node), ...(ts.isBindingElement(node) ? [node.name] : [])];
  if (!names.some((name) => ports.sensitiveName(propertyText(name) ?? ""))) return undefined;
  if (ts.isBinaryExpression(node)) return node.right;
  if (ts.isBindingElement(node) || ts.isVariableDeclaration(node) || ts.isParameter(node))
    return node.initializer;
  if (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node) || ts.isJsxAttribute(node))
    return node.initializer;
  return undefined;
}

function commentSpans(
  text: string,
  file: Ts.SourceFile,
  ports: ProjectionPorts,
): readonly RedactionSpan[] {
  const ts = typescriptApi();
  const ranges = new Map<number, Ts.CommentRange>();
  const pending: Ts.Node[] = [file];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    const comments = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ];
    for (const range of comments) ranges.set(range.pos, range);
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return [...ranges.values()].flatMap((range) => {
    const comment = text.slice(range.pos, range.end);
    if (comment === ports.redactPlain(comment)) return [];
    const closing =
      range.kind === ts.SyntaxKind.MultiLineCommentTrivia && comment.endsWith("*/") ? 2 : 0;
    return [literalSpan(text, range.pos, range.end, 2, closing)];
  });
}

type DataLiteral =
  Ts.StringLiteralLike | Ts.TemplateLiteralLikeNode | Ts.NumericLiteral | Ts.BigIntLiteral;
interface ObservedLiteral {
  readonly node: DataLiteral;
  readonly sensitive: boolean;
}

function dataLiteral(node: Ts.Node): node is DataLiteral {
  const ts = typescriptApi();
  return sourceLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node);
}

function literalKey(node: DataLiteral): string {
  const ts = typescriptApi();
  if (ts.isNumericLiteral(node)) return `number:${node.text}`;
  if (ts.isBigIntLiteral(node)) return `bigint:${node.text}`;
  return `string:${node.text}`;
}

function publicComposedPrefix(node: DataLiteral, ports: ProjectionPorts): boolean {
  const ts = typescriptApi();
  if (!ports.publicPrefix(node.text)) return false;
  let owner: Ts.Node = node.parent;
  while (
    ts.isParenthesizedExpression(owner) ||
    ts.isAsExpression(owner) ||
    ts.isTypeAssertionExpression(owner)
  )
    owner = owner.parent;
  if (ts.isBinaryExpression(owner)) return owner.operatorToken.kind === ts.SyntaxKind.PlusToken;
  return ts.isTemplateExpression(owner) || ts.isTemplateSpan(owner);
}

function dataLiteralSpan(text: string, file: Ts.SourceFile, node: DataLiteral): RedactionSpan {
  const ts = typescriptApi();
  if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node))
    return {
      start: node.getStart(file),
      end: node.end,
      replacement: ts.isBigIntLiteral(node) ? "0n" : "0",
    };
  const bounds = literalBoundaries(node);
  return literalSpan(text, node.getStart(file), node.end, bounds.opening, bounds.closing);
}

function observeLiteral(
  node: Ts.Node,
  sensitive: boolean,
  ports: ProjectionPorts,
  literals: ObservedLiteral[],
  privateValues: Set<string>,
): void {
  if (!dataLiteral(node) || node.text.length === 0) return;
  const privateValue = sensitive && !publicComposedPrefix(node, ports);
  literals.push({ node, sensitive: privateValue });
  if (privateValue) privateValues.add(literalKey(node));
}

export function projectTypeScriptData(
  text: string,
  ports: ProjectionPorts,
  json = false,
): readonly RedactionSpan[] {
  const ts = typescriptApi();
  const file = json
    ? ts.createSourceFile("source.json", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSON)
    : typescriptSource(text, ports);
  const literals: ObservedLiteral[] = [];
  const spans: RedactionSpan[] = [];
  const privateValues = new Set<string>();
  const pending: { node: Ts.Node; sensitive: boolean }[] = [{ node: file, sensitive: false }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const { node, sensitive } = current;
    observeLiteral(node, sensitive, ports, literals, privateValues);
    if (ts.isJsxText(node)) {
      const replacement = ports.redactPlain(node.text);
      if (replacement !== node.text) spans.push(literalSpan(text, node.pos, node.end, 0, 0));
    }
    const owned = sensitiveInitializer(node, ports);
    ts.forEachChild(node, (child) => {
      pending.push({
        node: child,
        sensitive: (sensitive && valueChild(node, child)) || owned === child,
      });
    });
  }
  return [
    ...observedLiteralSpans(text, file, literals, privateValues, ports),
    ...spans,
    ...commentSpans(text, file, ports),
  ];
}

function valueChild(node: Ts.Node, child: Ts.Node): boolean {
  const ts = typescriptApi();
  if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isFunctionLike(node))
    return false;
  if (ts.isTypeNode(child)) return false;
  if ("name" in node && node.name === child) return false;
  return !ts.isConditionalExpression(node) || node.condition !== child;
}

function syntaxSource(
  text: string,
  kind: Ts.ScriptKind,
): { file: Ts.SourceFile; valid: boolean; firstError: number } {
  const ts = typescriptApi();
  const name = kind === ts.ScriptKind.TSX ? "source.tsx" : "source.ts";
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
  const host: Ts.CompilerHost = {
    getSourceFile: (path): Ts.SourceFile | undefined => (path === name ? file : undefined),
    getDefaultLibFileName: (): string => "",
    writeFile: (): void => undefined,
    getCurrentDirectory: (): string => "",
    getDirectories: (): string[] => [],
    fileExists: (path): boolean => path === name,
    readFile: (path): string | undefined => (path === name ? text : undefined),
    getCanonicalFileName: (path): string => path,
    useCaseSensitiveFileNames: (): boolean => true,
    getNewLine: (): string => "\n",
  };
  const program = ts.createProgram(
    [name],
    { noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve },
    host,
  );
  const diagnostics = program.getSyntacticDiagnostics(file);
  return {
    file,
    valid: diagnostics.length === 0,
    firstError: Math.min(text.length, ...diagnostics.map((d) => d.start)),
  };
}

function typescriptSource(text: string, ports: ProjectionPorts): Ts.SourceFile {
  const ts = typescriptApi();
  const jsx = syntaxSource(text, ts.ScriptKind.TSX);
  if (jsx.valid) return jsx.file;
  const plain = syntaxSource(text, ts.ScriptKind.TS);
  const result = plain.valid || plain.firstError >= jsx.firstError ? plain : jsx;
  if (!result.valid && result.firstError < text.length && unsafeMalformedSource(text, ports))
    throw new TypeScriptSyntaxRefusal();
  return result.file;
}

function unsafeMalformedSource(text: string, ports: ProjectionPorts): boolean {
  return (
    /\\|"{3}|'{3}|[@$]"/u.test(text) ||
    (ports.mayContainSensitiveName(text) && /["'`\d]/u.test(text)) ||
    ports.redactPlain(text) !== text
  );
}

function literalName(node: Ts.Node): boolean {
  return "name" in node.parent && node.parent.name === node;
}

/** Native JSON validation prevents JavaScript labels or expressions from becoming JSON evidence. */
export function isJsonDocument(text: string): boolean {
  if (!/^\s*[{[]/u.test(text)) return false;
  return typescriptApi().parseConfigFileTextToJson("source.json", text).error === undefined;
}

/** Missing EOF syntax may be appended to an admitted prefix; an earlier lexical error may
 * already have detached a private value's tail from its owner and must remain unavailable. */
export function isJsonSourcePrefix(text: string): boolean {
  const error = typescriptApi().parseConfigFileTextToJson("source.json", text).error;
  return error === undefined || error.start === text.length;
}

/** Full syntax and a declaration certify bare source; labels/env assignments remain plain text. */
export function isTypeScriptSource(text: string): boolean {
  const ts = typescriptApi();
  const jsx = syntaxSource(text, ts.ScriptKind.TSX);
  const result = jsx.valid ? jsx : syntaxSource(text, ts.ScriptKind.TS);
  return result.valid && hasDeclaration(result.file);
}

function hasDeclaration(file: Ts.SourceFile): boolean {
  const ts = typescriptApi();
  const pending: Ts.Node[] = [file];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (sourceDeclaration(node)) return true;
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Tolerant AST ownership identifies code without certifying malformed source as valid. */
export function hasSourceDeclaration(text: string): boolean {
  return hasDeclaration(
    typescriptApi().createSourceFile("source.ts", text, typescriptApi().ScriptTarget.Latest, true),
  );
}

function sourceDeclaration(node: Ts.Node): boolean {
  const ts = typescriptApi();
  return (
    ts.isVariableStatement(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isImportDeclaration(node)
  );
}

export function typeScriptPrefixLength(text: string): number {
  const ts = typescriptApi();
  const jsx = syntaxSource(text, ts.ScriptKind.TSX);
  const result = jsx.valid ? jsx : syntaxSource(text, ts.ScriptKind.TS);
  if (result.valid) return isTypeScriptSource(text) ? text.length : 0;
  let end = 0;
  let declaration = false;
  for (const statement of result.file.statements) {
    if (statement.end > result.firstError || !sourceStatement(statement)) break;
    declaration ||= sourceDeclaration(statement);
    end = statement.end;
  }
  return declaration ? end : 0;
}

function sourceStatement(statement: Ts.Statement): boolean {
  const ts = typescriptApi();
  if (sourceDeclaration(statement) || ts.isExportDeclaration(statement)) return true;
  if (!ts.isExpressionStatement(statement)) return false;
  const expression = statement.expression;
  return (
    ts.isCallExpression(expression) ||
    ts.isBinaryExpression(expression) ||
    ts.isAwaitExpression(expression)
  );
}

function observedLiteralSpans(
  text: string,
  file: Ts.SourceFile,
  literals: readonly ObservedLiteral[],
  privateValues: ReadonlySet<string>,
  ports: ProjectionPorts,
): readonly RedactionSpan[] {
  const spans: RedactionSpan[] = [];
  for (const literal of literals) {
    if (
      literal.sensitive ||
      (!literalName(literal.node) && privateValues.has(literalKey(literal.node))) ||
      ports.redactPlain(literal.node.text) !== literal.node.text
    )
      spans.push(dataLiteralSpan(text, file, literal.node));
  }
  return spans;
}
