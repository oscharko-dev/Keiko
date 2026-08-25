// KEIKO-0477 parity gate: design-system/lift-icons.jsx (JSX/React spec mirror consumed by
// documentation authors) and design-system/lift-glyphs.js (plain-JS renderer used by every
// design-system page) BOTH contain the Lift icon geometry, and until now no automated check
// held them in agreement. A hand-edit to one path-data literal silently desyncs the icon
// shown on one surface from every other.
//
// This gate loads both files, extracts the ordered sequence of geometry operations per
// icon (helper calls with arguments, literal path strings, or circle attributes), normalizes
// them to a canonical shape (helper aliases `rect` ↔ `rct` map to one name), and asserts
// every shared icon key produces the same sequence. Exit code is non-zero on any divergence
// so CI can gate on it; the pure `checkParity` helper is exported for the co-located test.
//
// Deliberately NOT: byte-comparing the rendered SVG output. Both files share identical
// helper math (arc, ring, box, star4, gearPath) so an equal operation sequence implies an
// equal rendered path. Comparing the operation sequence catches the class of edit that
// motivates the pin — a hand-edited path-data literal or a swapped helper argument.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as babelParse } from "@babel/parser";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const jsxPath = resolve(repoRoot, "design-system", "lift-icons.jsx");
const jsPath = resolve(repoRoot, "design-system", "lift-glyphs.js");

// Some helpers have different aliases in the two files. Normalise them both to one canonical
// name so equal calls compare equal.
const HELPER_ALIAS = new Map([
  ["rect", "rectClosed"],
  ["rct", "rectClosed"],
]);
const canonicalHelper = (name) => HELPER_ALIAS.get(name) ?? name;

// ── JSX side ────────────────────────────────────────────────────────────────
// Parse lift-icons.jsx with @babel/parser (plugin: jsx), locate the LIFT and CTL object
// expressions, and turn each property's value (a JSX fragment or single element) into an
// ordered array of ops.
function collectTargetJsxObjects(ast) {
  const objects = {};
  for (const node of ast.program.body) {
    if (node.type !== "VariableDeclaration") continue;
    for (const declarator of node.declarations) {
      if (declarator.id.type !== "Identifier") continue;
      const varName = declarator.id.name;
      if (varName !== "LIFT" && varName !== "CTL") continue;
      if (declarator.init?.type !== "ObjectExpression") continue;
      objects[varName] = declarator.init;
    }
  }
  return objects;
}

function extractOpsFromJsx(customPath) {
  const source = readFileSync(customPath ?? jsxPath, "utf8");
  const ast = babelParse(source, {
    sourceType: "module",
    plugins: ["jsx"],
    errorRecovery: false,
  });
  const objects = collectTargetJsxObjects(ast);
  const result = new Map();
  for (const varName of Object.keys(objects)) {
    for (const prop of objects[varName].properties) {
      if (prop.type !== "ObjectProperty") continue;
      const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value ?? "");
      const ops = jsxValueToOps(prop.value, source);
      result.set(key, ops);
    }
  }
  return result;
}

function jsxValueToOps(node, source) {
  if (node.type === "JSXElement") return [jsxElementToOp(node, source)];
  if (node.type === "JSXFragment") {
    return node.children
      .filter((child) => child.type === "JSXElement")
      .map((child) => jsxElementToOp(child, source));
  }
  throw new Error(`unexpected JSX value node ${node.type} at ${node.start}`);
}

function jsxElementToOp(elem, source) {
  const tag = elem.openingElement.name.name;
  const attrs = new Map();
  for (const attr of elem.openingElement.attributes) {
    if (attr.type !== "JSXAttribute") continue;
    const attrName = attr.name.name;
    if (attr.value?.type === "StringLiteral") {
      attrs.set(attrName, { kind: "literal", value: attr.value.value });
    } else if (attr.value?.type === "JSXExpressionContainer") {
      const exprSrc = source.slice(attr.value.expression.start, attr.value.expression.end);
      const parsed = parseHelperCall(exprSrc);
      attrs.set(attrName, parsed ?? { kind: "expr", source: exprSrc });
    } else if (attr.value === null || attr.value === undefined) {
      // boolean-shorthand attribute
      attrs.set(attrName, { kind: "boolean", value: true });
    }
  }
  return { tag, attrs };
}

function parseHelperCall(src) {
  const match = /^\s*(\w+)\s*\((.*)\)\s*$/su.exec(src);
  if (!match) return null;
  const helperName = canonicalHelper(match[1]);
  const argsSrc = match[2];
  const args = splitTopLevelArgs(argsSrc).map((a) => a.trim());
  return { kind: "call", helper: helperName, args };
}

const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);
function splitTopLevelArgs(argsSrc) {
  // Split on commas that are not inside brackets, braces, or parens. Handles nested calls
  // and object literals (present in gearPath({...}) style options).
  const out = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < argsSrc.length; i += 1) {
    const ch = argsSrc[i];
    if (OPEN_BRACKETS.has(ch)) depth += 1;
    else if (CLOSE_BRACKETS.has(ch)) depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(argsSrc.slice(last, i));
      last = i + 1;
    }
  }
  if (last < argsSrc.length) out.push(argsSrc.slice(last));
  return out;
}

// ── JS side ─────────────────────────────────────────────────────────────────
// lift-glyphs.js uses `P(x) = '<path d="' + x + '"/>'` and string concatenation with inline
// '<circle .../>' literals. Parse the G object literal source directly (no vm needed): find
// the `var G = { … };` block, then walk each `key: value,` pair. For each value expand the
// chain of `+` operands into an ordered ops list, where each operand is one of:
//   P(helper(args))     → { kind: "call", helper, args }
//   P("literal")        → { kind: "path", value }
//   '<circle .../>'     → { kind: "circle", cx, cy, r, extras }
// KEIKO-0935: lift-glyphs.js may hoist byte-identical glyph geometry into a shared module-
// scope const (e.g. `var DEBUG_BUG_GLYPH = P(...) + P(...);`) that G entries reference by
// name (`debug: DEBUG_BUG_GLYPH`). Collect every such `var UPPER_SNAKE = <expr>;` declaration
// above `var G = {` and expand bare identifier references in G's operand chain to the
// underlying expression source before the operand parser walks it. Restricted to UPPER_SNAKE
// so ordinary lowercase locals cannot accidentally be substituted.
const UPPER_SNAKE_CHAR = /[A-Z0-9_]/u;

function isUpperSnake(text) {
  if (text.length === 0) return false;
  if (text[0] < "A" || text[0] > "Z") return false;
  for (const char of text) {
    if (!UPPER_SNAKE_CHAR.test(char)) return false;
  }
  return true;
}

// Returns { name, valueOnHeaderLine } for a `var UPPER_SNAKE = <expr>` line, else null. Pure
// string parsing — no regex with multiple unbounded quantifiers that Sonar S8786 would flag as
// super-linear. Only accepts an UPPER_SNAKE_CASE identifier immediately after `var`.
function parseSharedConstHeader(line) {
  const stripped = line.trimStart();
  if (!stripped.startsWith("var ")) return null;
  const afterVar = stripped.slice("var ".length).trimStart();
  const eq = afterVar.indexOf("=");
  if (eq < 1) return null;
  const name = afterVar.slice(0, eq).trim();
  if (!isUpperSnake(name)) return null;
  return { name, valueOnHeaderLine: afterVar.slice(eq + 1).trimStart() };
}

function collectSharedConsts(source) {
  // Pure string parsing replaces the earlier regex forms — Sonar S8786 kept flagging every
  // shape with adjacent unbounded quantifiers (`\s*var\s+…\s*=\s*` alone was enough). The
  // per-line header parse is bounded string ops; the body accumulator concatenates physical
  // lines until `;` at end-of-line.
  const consts = new Map();
  const lines = source.split(/\r?\n/u);
  let i = 0;
  while (i < lines.length) {
    const header = parseSharedConstHeader(lines[i]);
    if (header === null) {
      i += 1;
      continue;
    }
    let expr = header.valueOnHeaderLine;
    let cursor = i;
    while (!expr.trimEnd().endsWith(";") && cursor + 1 < lines.length) {
      cursor += 1;
      expr = `${expr}\n${lines[cursor]}`;
    }
    const trimmed = expr.trim();
    if (trimmed.endsWith(";")) {
      const body = trimmed.slice(0, -1).trim();
      if (body.length > 0) consts.set(header.name, body);
    }
    i = cursor + 1;
  }
  return consts;
}

function expandSharedConsts(valueSrc, consts) {
  return valueSrc.replace(/\b([A-Z][A-Z0-9_]*)\b/gu, (whole, name) => {
    const expansion = consts.get(name);
    return expansion === undefined ? whole : expansion;
  });
}

function extractOpsFromJs(customPath) {
  const source = readFileSync(customPath ?? jsPath, "utf8");
  const gStart = source.indexOf("var G = {");
  if (gStart < 0) throw new Error("could not locate `var G = {` in lift-glyphs.js");
  const consts = collectSharedConsts(source.slice(0, gStart));
  const bodyStart = source.indexOf("{", gStart);
  const bodyEnd = matchClosingBrace(source, bodyStart);
  const body = source.slice(bodyStart + 1, bodyEnd);
  const props = splitObjectProperties(body);
  const result = new Map();
  for (const [key, valueSrc] of props) {
    result.set(key, jsValueToOps(expandSharedConsts(valueSrc, consts)));
  }
  return result;
}

function matchClosingBrace(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unmatched brace at ${openIndex}`);
}

// A minimal cursor state machine that skips string literals + line/block comments while walking
// source text. Callers keep their own bracket-depth counter and stop condition. Extracting the
// string/comment discipline into one place keeps splitObjectProperties/firstColonOutsideBrackets
// under the repo's complexity cap without changing behaviour.
function makeSourceCursor(src) {
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  const skipInLine = (ch) => {
    if (ch === "\n") inLineComment = false;
    return 1;
  };
  const skipInBlock = (ch, nx) => {
    if (ch === "*" && nx === "/") {
      inBlockComment = false;
      return 2;
    }
    return 1;
  };
  const skipInString = (ch) => {
    if (ch === "\\") return 2;
    if (ch === inString) inString = null;
    return 1;
  };
  const enterOrPassThrough = (ch, nx) => {
    if (ch === "/" && nx === "/") {
      inLineComment = true;
      return 2;
    }
    if (ch === "/" && nx === "*") {
      inBlockComment = true;
      return 2;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      return 1;
    }
    return 0;
  };
  return {
    skip(i) {
      const ch = src[i];
      const nx = src[i + 1];
      if (inLineComment) return skipInLine(ch);
      if (inBlockComment) return skipInBlock(ch, nx);
      if (inString) return skipInString(ch);
      return enterOrPassThrough(ch, nx);
    },
  };
}

function splitOnTopLevelCommas(body) {
  const parts = [];
  const cursor = makeSourceCursor(body);
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length;) {
    const advance = cursor.skip(i);
    if (advance !== 0) {
      i += advance;
      continue;
    }
    const ch = body[i];
    if (OPEN_BRACKETS.has(ch)) depth += 1;
    else if (CLOSE_BRACKETS.has(ch)) depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  if (start < body.length) parts.push(body.slice(start));
  return parts;
}

function splitObjectProperties(body) {
  const props = [];
  for (const part of splitOnTopLevelCommas(body)) {
    const trimmed = part
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/[^\n]*/gu, "")
      .trim();
    if (!trimmed) continue;
    const colon = firstColonOutsideBrackets(trimmed);
    if (colon < 0) continue;
    props.push([trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim()]);
  }
  return props;
}

function firstColonOutsideBrackets(src) {
  const cursor = makeSourceCursor(src);
  let depth = 0;
  for (let i = 0; i < src.length;) {
    const advance = cursor.skip(i);
    if (advance !== 0) {
      i += advance;
      continue;
    }
    const ch = src[i];
    if (OPEN_BRACKETS.has(ch)) depth += 1;
    else if (CLOSE_BRACKETS.has(ch)) depth -= 1;
    else if (ch === ":" && depth === 0) return i;
    i += 1;
  }
  return -1;
}

function jsValueToOps(valueSrc) {
  const operands = splitTopLevelPlus(valueSrc);
  return operands.map((operand) => jsOperandToOp(operand.trim()));
}

function splitTopLevelPlus(src) {
  const parts = [];
  const cursor = makeSourceCursor(src);
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length;) {
    const advance = cursor.skip(i);
    if (advance !== 0) {
      i += advance;
      continue;
    }
    const ch = src[i];
    if (OPEN_BRACKETS.has(ch)) depth += 1;
    else if (CLOSE_BRACKETS.has(ch)) depth -= 1;
    else if (ch === "+" && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  if (start < src.length) parts.push(src.slice(start));
  return parts;
}

function jsOperandToOp(operand) {
  // P(...) case
  if (/^P\s*\(/u.test(operand)) {
    const inner = extractParen(operand, operand.indexOf("("));
    // Helper call inside P(...)
    const helperCall = parseHelperCall(inner);
    if (helperCall) return helperCall;
    // Literal path inside P(...) — string literal (single or double quoted)
    const stringLit = matchStringLiteral(inner.trim());
    if (stringLit !== null) return { kind: "path", value: stringLit };
    throw new Error(`unrecognised P(...) operand: ${operand.slice(0, 80)}`);
  }
  // Bare `'<circle .../>'` or `'<circle .../><circle .../>' ...` — a raw string of SVG
  // elements. Concatenated primitives (e.g. hierarchy) live here.
  const raw = matchStringLiteral(operand);
  if (raw !== null) {
    return { kind: "raw", value: raw };
  }
  throw new Error(`unrecognised operand: ${operand.slice(0, 80)}`);
}

function extractParen(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex + 1, i);
    }
  }
  throw new Error(`unmatched paren at ${openIndex}`);
}

function matchStringLiteral(src) {
  let trimmed = src.trim();
  // The upstream `P(x,)` / trailing-comma pattern shows up when Prettier wraps a P() call
  // across lines; strip any trailing commas plus their surrounding whitespace before
  // checking the closing quote.
  while (trimmed.endsWith(",")) trimmed = trimmed.slice(0, -1).trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;
  if (trimmed[trimmed.length - 1] !== quote) return null;
  // Un-escape only the two common cases.
  return trimmed.slice(1, -1).replaceAll(`\\${quote}`, quote).replaceAll("\\\\", "\\");
}

// ── Comparison layer ────────────────────────────────────────────────────────
// The JSX side emits { tag, attrs } items; the JS side emits { kind: … } items. Normalise
// both to a shape:
//   { kind: "call", helper, args }         helper call with argument strings
//   { kind: "path", value }                literal path data
//   { kind: "circle", cx, cy, r, ... }     circle primitive (attrs as pairs)
// so that JSX `<path d={ring(10.5, 10.5, 6)}/>` and JS `P(ring(10.5, 10.5, 6))` normalise
// identically, and the JSX `<circle cx="6" cy="17.4" r="2.3"/>` matches the equivalent JS
// raw string of the same shape.

const normaliseArg = (arg) => String(arg).replace(/\s+/gu, "");

// The two files call gearPath with different signatures — lift-icons.jsx passes a single
// destructured options object `gearPath({ cx, cy, rOut, ... })`, lift-glyphs.js uses the
// positional form `gearPath(cx, cy, rOut, ...)`. Both implementations use the same math on
// the same field-order underneath, so this expands the JSX side's single object argument to
// the same positional tuple the JS side uses.
const GEAR_PATH_ORDER = ["cx", "cy", "rOut", "rIn", "teeth", "half", "slope", "gapHalf"];

function normaliseCallArgs(helper, args) {
  if (helper === "gearPath" && args.length === 1) {
    const objBody = args[0].replace(/^\{|\}$/gu, "");
    const fields = {};
    for (const field of splitTopLevelArgs(objBody)) {
      const parts = field.split(":");
      if (parts.length < 2) continue;
      const key = parts[0].trim();
      const value = parts.slice(1).join(":").trim().replace(/,$/u, "").trim();
      fields[key] = value;
    }
    return GEAR_PATH_ORDER.map((k) => normaliseArg(fields[k] ?? ""));
  }
  return args.map(normaliseArg);
}

function normaliseJsxPath(op) {
  const dAttr = op.attrs.get("d");
  if (!dAttr) throw new Error("<path> without d attribute");
  if (dAttr.kind === "literal") return { kind: "path", value: dAttr.value };
  if (dAttr.kind === "call") {
    return {
      kind: "call",
      helper: dAttr.helper,
      args: normaliseCallArgs(dAttr.helper, dAttr.args),
    };
  }
  return { kind: "expr", source: dAttr.source ?? "" };
}

function normaliseJsxLiteralPrimitive(op, kind) {
  const primitive = { kind };
  for (const [k, v] of op.attrs) {
    if (v.kind === "literal") primitive[k] = String(v.value);
  }
  return primitive;
}

function normaliseFromJsx(ops) {
  return ops.map((op) => {
    if (op.tag === "path") return normaliseJsxPath(op);
    if (op.tag === "circle") return normaliseJsxLiteralPrimitive(op, "circle");
    if (op.tag === "rect") return normaliseJsxLiteralPrimitive(op, "rectPrimitive");
    throw new Error(`unexpected JSX tag: ${String(op.tag)}`);
  });
}

// From the JS side, a `raw` operand can contain one or more primitives. Split them.
const CIRCLE_RE = /<circle\b([^/>]*)\/>/gu;
const RECT_RE = /<rect\b([^/>]*)\/>/gu;

// Parse `name="value"` attribute pairs from a serialised SVG element opening tag. Hand-parsed
// instead of using one regex — SonarJS S8786 flags `([^"]*)` between quotes as super-linear on
// pathological input, so we scan the tape once with no backtracking.
const isNameStart = (ch) => ch !== undefined && /[A-Za-z]/u.test(ch);
const isNameTail = (ch) => ch !== undefined && /[A-Za-z0-9_-]/u.test(ch);
const isInlineSpace = (ch) => ch === " " || ch === "\t";

function skipInlineSpace(src, from) {
  let i = from;
  while (i < src.length && isInlineSpace(src[i])) i += 1;
  return i;
}

function readName(src, from) {
  let i = from;
  while (i < src.length && isNameTail(src[i])) i += 1;
  return { name: src.slice(from, i), end: i };
}

function readQuotedValue(src, from) {
  let i = from;
  while (i < src.length && src[i] !== '"') i += 1;
  if (i >= src.length) return null;
  return { value: src.slice(from, i), end: i + 1 };
}

function parseOneAttribute(src, from) {
  let i = skipInlineSpace(src, from);
  if (i >= src.length) return { done: true };
  if (!isNameStart(src[i])) return { skipTo: i + 1 };
  const { name, end: afterName } = readName(src, i);
  i = skipInlineSpace(src, afterName);
  if (src[i] !== "=") return { skipTo: afterName };
  i = skipInlineSpace(src, i + 1);
  if (src[i] !== '"') return { skipTo: i };
  const value = readQuotedValue(src, i + 1);
  if (value === null) return { done: true };
  return { name, value: value.value, next: value.end };
}

function parseAttrList(attrsSrc) {
  const attrs = {};
  let i = 0;
  while (i < attrsSrc.length) {
    const step = parseOneAttribute(attrsSrc, i);
    if (step.done) break;
    if (step.skipTo !== undefined) {
      i = step.skipTo;
      continue;
    }
    attrs[step.name] = step.value;
    i = step.next;
  }
  return attrs;
}

function normaliseFromJs(ops) {
  const out = [];
  for (const op of ops) {
    if (op.kind === "call") {
      out.push({ kind: "call", helper: op.helper, args: normaliseCallArgs(op.helper, op.args) });
    } else if (op.kind === "path") {
      out.push({ kind: "path", value: op.value });
    } else if (op.kind === "raw") {
      // Extract each primitive in encounter order.
      const raw = op.value;
      const primitives = [];
      for (const m of raw.matchAll(CIRCLE_RE)) {
        primitives.push({ start: m.index, kind: "circle", ...parseAttrList(m[1]) });
      }
      for (const m of raw.matchAll(RECT_RE)) {
        primitives.push({ start: m.index, kind: "rectPrimitive", ...parseAttrList(m[1]) });
      }
      primitives.sort((a, b) => a.start - b.start);
      for (const p of primitives) {
        const rest = { ...p };
        delete rest.start;
        out.push(rest);
      }
    }
  }
  return out;
}

function opEquals(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "call") {
    return (
      a.helper === b.helper &&
      a.args.length === b.args.length &&
      a.args.every((arg, i) => arg === b.args[i])
    );
  }
  if (a.kind === "path") return a.value === b.value;
  // primitive (circle / rect / other)
  const keysA = Object.keys(a)
    .filter((k) => k !== "kind")
    .sort((x, y) => x.localeCompare(y));
  const keysB = Object.keys(b)
    .filter((k) => k !== "kind")
    .sort((x, y) => x.localeCompare(y));
  if (keysA.length !== keysB.length) return false;
  if (keysA.some((k, i) => k !== keysB[i])) return false;
  return keysA.every((k) => String(a[k]) === String(b[k]));
}

function opsEqual(opsA, opsB) {
  if (opsA.length !== opsB.length) return false;
  return opsA.every((op, i) => opEquals(op, opsB[i]));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Compare the two icon libraries and return an array of divergence strings — empty when the
 * two sides agree on every shared key. Exported for the co-located regression pin so the
 * check can run without spawning this script as a subprocess.
 */
export function checkParity({ jsxPath: jsxOverride, jsPath: jsOverride } = {}) {
  const jsxOps = extractOpsFromJsx(jsxOverride);
  const jsOps = extractOpsFromJs(jsOverride);
  const divergences = [];
  const sharedKeys = [...jsxOps.keys()]
    .filter((k) => jsOps.has(k))
    .sort((x, y) => x.localeCompare(y));
  for (const key of sharedKeys) {
    const a = normaliseFromJsx(jsxOps.get(key));
    const b = normaliseFromJs(jsOps.get(key));
    if (!opsEqual(a, b)) {
      divergences.push(
        `${key}: JSX and JS differ.\n  JSX: ${JSON.stringify(a)}\n  JS:  ${JSON.stringify(b)}`,
      );
    }
  }
  // Report keys present in only one side, but tolerate CTL entries (min/max/restore/close)
  // that lift-glyphs.js merges into its main G map — they're the same icons under the same
  // names, just organised differently in the JSX source.
  const jsxOnly = [...jsxOps.keys()].filter((k) => !jsOps.has(k));
  const jsOnly = [...jsOps.keys()].filter((k) => !jsxOps.has(k));
  if (jsxOnly.length) divergences.push(`present only in lift-icons.jsx: ${jsxOnly.join(", ")}`);
  if (jsOnly.length) divergences.push(`present only in lift-glyphs.js: ${jsOnly.join(", ")}`);
  return divergences;
}

// ── CLI entry point ─────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const divergences = checkParity();
  if (divergences.length === 0) {
    console.log(`lift-icons.jsx ↔ lift-glyphs.js: parity holds across every shared icon key.`);
    process.exit(0);
  }
  console.error(
    `FAIL: lift-icons.jsx and lift-glyphs.js diverge on ${divergences.length} icon(s):`,
  );
  for (const d of divergences) console.error(`  ${d}`);
  process.exit(1);
}
