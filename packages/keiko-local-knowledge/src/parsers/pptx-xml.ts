// OOXML tokenizer shared by the docx and pptx readers. A small XML-aware tokenizer (a linear scan
// with sticky, non-backtracking patterns; no regex over document bodies) yields element tags and
// character data in document order. Comments are skipped whole, CDATA sections yield their
// literal character data, and attribute values are read quote aware. Entities are never expanded
// beyond the five predefined ones and numeric character references, and every construct the text
// layer does not need - a DOCTYPE or ENTITY declaration, a processing instruction other than the
// leading XML declaration, markup that does not parse, a part that is not exactly one XML document
// - fails closed instead of being skipped. Element and attribute names carry the canonical prefix
// of their namespace (`w`, `a`, `p`, `r`, `mc`, `m`, `c`, `dgm`), whatever prefix the producer
// declared for it: a document that a generic XML library wrote as `ns0:p` reads like one Word wrote.

import { decodeXmlEntities } from "./_internal.js";

const NAME_PATTERN = /[A-Za-z_][\w.-]*(?::[\w.-]+)?/uy;
const SPACE_PATTERN = /\s*/uy;
const ATTRIBUTE_PATTERN = /([^\s=/<>"']+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/uy;
const CLOSING_END_PATTERN = /\s*>/uy;
const XML_DECLARATION_PATTERN = /<\?xml\s[^>]*\?>/uy;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";
const BYTE_ORDER_MARK = "﻿";
const NAMESPACE_DECLARATION = "xmlns";

// The Transitional and Strict namespaces of every vocabulary the readers match by name.
const CANONICAL_PREFIX_BY_NAMESPACE: ReadonlyMap<string, string> = new Map([
  ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w"],
  ["http://purl.oclc.org/ooxml/wordprocessingml/main", "w"],
  ["http://schemas.openxmlformats.org/drawingml/2006/main", "a"],
  ["http://purl.oclc.org/ooxml/drawingml/main", "a"],
  ["http://schemas.openxmlformats.org/presentationml/2006/main", "p"],
  ["http://purl.oclc.org/ooxml/presentationml/main", "p"],
  ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "r"],
  ["http://purl.oclc.org/ooxml/officeDocument/relationships", "r"],
  ["http://schemas.openxmlformats.org/markup-compatibility/2006", "mc"],
  ["http://schemas.openxmlformats.org/officeDocument/2006/math", "m"],
  ["http://purl.oclc.org/ooxml/officeDocument/math", "m"],
  ["http://schemas.openxmlformats.org/drawingml/2006/chart", "c"],
  ["http://purl.oclc.org/ooxml/drawingml/chart", "c"],
  ["http://schemas.openxmlformats.org/drawingml/2006/diagram", "dgm"],
  ["http://purl.oclc.org/ooxml/drawingml/diagram", "dgm"],
]);
const CANONICAL_PREFIXES: ReadonlySet<string> = new Set(CANONICAL_PREFIX_BY_NAMESPACE.values());

export interface XmlTag {
  readonly kind: "tag";
  /** Element name without its namespace prefix. */
  readonly local: string;
  /** Namespace prefix as written (`w`, `a`, `mc`), or an empty string when the name has none. */
  readonly prefix: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  /** Decoded attribute values keyed by their qualified name. */
  readonly attributes: ReadonlyMap<string, string>;
}

export interface XmlText {
  readonly kind: "text";
  /** Decoded character data, or the literal content of a CDATA section. */
  readonly value: string;
}

export type XmlToken = XmlTag | XmlText;

/** Written prefix (empty for the default namespace) to the canonical prefix its namespace has. */
type NamespaceScope = ReadonlyMap<string, string>;

interface OpenElement {
  readonly qualified: string;
  /** Scope inside the element: the one that names it and its attributes. */
  readonly scope: NamespaceScope;
  /** Scope outside the element, restored when it closes. */
  readonly outer: NamespaceScope;
}

interface ScanState {
  readonly stack: OpenElement[];
  scope: NamespaceScope;
  /** Root elements opened so far; a part holds exactly one. */
  roots: number;
}

interface Markup {
  readonly token: XmlToken | undefined;
  readonly next: number;
}

interface TagTail {
  readonly attributes: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
  readonly next: number;
}

function malformed(): Error {
  return new Error("ooxml xml is not well formed");
}

function localNameOf(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

function prefixOf(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon === -1 ? "" : qualified.slice(0, colon);
}

function matchAt(pattern: RegExp, xml: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(xml);
}

// ─── Namespaces ──────────────────────────────────────────────────────────────

/** The prefix a namespace declaration binds, `""` for the default namespace; undefined otherwise. */
function declaredPrefix(attribute: string): string | undefined {
  if (attribute === NAMESPACE_DECLARATION) return "";
  const own = `${NAMESPACE_DECLARATION}:`;
  return attribute.startsWith(own) ? attribute.slice(own.length) : undefined;
}

/**
 * A known namespace binds its prefix to the canonical one. A foreign namespace that reuses a
 * canonical prefix gets a prefix no reader matches, so it cannot impersonate the real vocabulary.
 */
function bindPrefix(scope: Map<string, string>, prefix: string, namespace: string): void {
  const canonical = CANONICAL_PREFIX_BY_NAMESPACE.get(namespace);
  if (canonical !== undefined) scope.set(prefix, canonical);
  else if (CANONICAL_PREFIXES.has(prefix)) scope.set(prefix, `~${prefix}`);
  else scope.delete(prefix);
}

/** The scope inside an element: the outer one plus the declarations the element itself makes. */
function declareNamespaces(
  outer: NamespaceScope,
  attributes: ReadonlyMap<string, string>,
): NamespaceScope {
  let scope: Map<string, string> | undefined;
  for (const [name, namespace] of attributes) {
    const prefix = declaredPrefix(name);
    if (prefix === undefined) continue;
    scope ??= new Map(outer);
    bindPrefix(scope, prefix, namespace);
  }
  return scope ?? outer;
}

function canonicalPrefix(scope: NamespaceScope, prefix: string): string {
  return scope.get(prefix) ?? prefix;
}

function canonicalAttribute(scope: NamespaceScope, name: string): string {
  const colon = name.indexOf(":");
  if (colon === -1) return name;
  const prefix = name.slice(0, colon);
  const canonical = scope.get(prefix);
  if (canonical === undefined || canonical === prefix) return name;
  return `${canonical}${name.slice(colon)}`;
}

/** The attributes keyed by canonical qualified name; the same map when no name changes. */
function canonicalAttributes(
  scope: NamespaceScope,
  attributes: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  for (const name of attributes.keys()) {
    if (canonicalAttribute(scope, name) === name) continue;
    return new Map(
      Array.from(attributes, ([key, value]) => [canonicalAttribute(scope, key), value] as const),
    );
  }
  return attributes;
}

function trackNesting(
  state: ScanState,
  tag: XmlTag,
  element: { readonly qualified: string; readonly scope: NamespaceScope },
  maxDepth: number,
): void {
  const { stack } = state;
  if (!tag.closing && stack.length === 0) {
    state.roots += 1;
    if (state.roots > 1) throw malformed();
  }
  if (tag.selfClosing) return;
  if (!tag.closing) {
    if (stack.length >= maxDepth) throw new Error("ooxml xml exceeds nesting limit");
    stack.push({ ...element, outer: state.scope });
    state.scope = element.scope;
    return;
  }
  const closed = stack.pop();
  if (closed?.qualified !== element.qualified) throw malformed();
  state.scope = closed.outer;
}

interface AttributeRead {
  readonly name: string;
  readonly value: string;
  readonly next: number;
}

/** One `name="value"` pair that must follow whitespace; anything else is not well formed. */
function readAttribute(xml: string, at: number, separated: boolean): AttributeRead {
  const match = separated ? matchAt(ATTRIBUTE_PATTERN, xml, at) : null;
  const name = match?.[1];
  const value = match?.[2] ?? match?.[3];
  if (match === null || name === undefined || value === undefined) throw malformed();
  return { name, value: decodeXmlEntities(value), next: at + match[0].length };
}

/** Reads the attributes and the end of a start tag; a quoted `>` never ends the tag. */
function readStartTagTail(xml: string, from: number): TagTail {
  const attributes = new Map<string, string>();
  let cursor = from;
  for (;;) {
    const spaceEnd = cursor + (matchAt(SPACE_PATTERN, xml, cursor)?.[0].length ?? 0);
    if (xml[spaceEnd] === ">") return { attributes, selfClosing: false, next: spaceEnd + 1 };
    if (xml.startsWith("/>", spaceEnd)) {
      return { attributes, selfClosing: true, next: spaceEnd + 2 };
    }
    const attribute = readAttribute(xml, spaceEnd, spaceEnd > cursor);
    if (attributes.has(attribute.name)) throw new Error("ooxml xml repeats an attribute");
    attributes.set(attribute.name, attribute.value);
    cursor = attribute.next;
  }
}

function readTagTail(xml: string, afterName: number, closing: boolean): TagTail {
  if (!closing) return readStartTagTail(xml, afterName);
  const end = matchAt(CLOSING_END_PATTERN, xml, afterName);
  if (end === null) throw malformed();
  return { attributes: new Map(), selfClosing: false, next: afterName + end[0].length };
}

function readElement(xml: string, open: number, state: ScanState, maxDepth: number): Markup {
  const closing = xml[open + 1] === "/";
  const nameStart = open + (closing ? 2 : 1);
  const name = matchAt(NAME_PATTERN, xml, nameStart)?.[0];
  if (name === undefined) throw malformed();
  const tail = readTagTail(xml, nameStart + name.length, closing);
  // A closing tag is named by the scope of the element it closes, a start tag by its own.
  const scope = closing
    ? (state.stack.at(-1)?.scope ?? state.scope)
    : declareNamespaces(state.scope, tail.attributes);
  const tag: XmlTag = {
    kind: "tag",
    local: localNameOf(name),
    prefix: canonicalPrefix(scope, prefixOf(name)),
    closing,
    selfClosing: tail.selfClosing,
    attributes: canonicalAttributes(scope, tail.attributes),
  };
  trackNesting(state, tag, { qualified: name, scope }, maxDepth);
  return { token: tag, next: tail.next };
}

function closerOf(xml: string, open: number, opener: string, closer: string): number {
  const close = xml.indexOf(closer, open + opener.length);
  if (close === -1) throw new Error("ooxml xml has an unterminated construct");
  return close;
}

function readMarkup(xml: string, open: number, state: ScanState, maxDepth: number): Markup {
  if (xml.startsWith(COMMENT_OPEN, open)) {
    const close = closerOf(xml, open, COMMENT_OPEN, COMMENT_CLOSE);
    return { token: undefined, next: close + COMMENT_CLOSE.length };
  }
  if (xml.startsWith(CDATA_OPEN, open)) {
    const close = closerOf(xml, open, CDATA_OPEN, CDATA_CLOSE);
    const value = xml.slice(open + CDATA_OPEN.length, close);
    return { token: { kind: "text", value }, next: close + CDATA_CLOSE.length };
  }
  if (xml.startsWith("<!", open)) throw new Error("ooxml xml declares a DOCTYPE or ENTITY");
  if (xml.startsWith("<?", open)) throw new Error("ooxml xml carries a processing instruction");
  return readElement(xml, open, state, maxDepth);
}

function declarationEnd(xml: string): number {
  const start = xml.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
  const declaration = matchAt(XML_DECLARATION_PATTERN, xml, start);
  return declaration === null ? start : start + declaration[0].length;
}

/**
 * Yields element tags and character data in document order. Throws when the document declares a
 * DOCTYPE or ENTITY, carries a processing instruction other than the leading XML declaration,
 * contains markup that does not parse, nests deeper than `maxDepth`, is not balanced, or is not
 * exactly one root element with only whitespace around it (the generator only reports a complete
 * document when it runs to completion).
 */
export function* scanXmlTokens(
  xml: string,
  maxDepth: number,
): Generator<XmlToken, void, undefined> {
  const state: ScanState = { stack: [], scope: new Map(), roots: 0 };
  let cursor = declarationEnd(xml);
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    const textEnd = open === -1 ? xml.length : open;
    if (textEnd > cursor) {
      const text = decodeXmlEntities(xml.slice(cursor, textEnd));
      requireInsideRoot(state, text);
      yield { kind: "text", value: text };
    }
    if (open === -1) break;
    const markup = readMarkup(xml, open, state, maxDepth);
    if (markup.token?.kind === "text") requireInsideRoot(state, markup.token.value);
    if (markup.token !== undefined) yield markup.token;
    cursor = markup.next;
  }
  if (state.stack.length > 0) throw new Error("ooxml xml has unterminated elements");
  if (state.roots !== 1) throw new Error("ooxml xml has no root element");
}

/** Character data outside the root element is not part of the document. */
function requireInsideRoot(state: ScanState, text: string): void {
  if (state.stack.length === 0 && text.trim().length > 0) {
    throw new Error("ooxml xml has text outside its root element");
  }
}

/** Yields only the element tags of `scanXmlTokens`. */
export function* scanXmlTags(xml: string, maxDepth: number): Generator<XmlTag, void, undefined> {
  for (const token of scanXmlTokens(xml, maxDepth)) {
    if (token.kind === "tag") yield token;
  }
}

export function attributeOf(tag: XmlTag, name: string): string | undefined {
  return tag.attributes.get(name);
}

// No-break and narrow no-break spaces keep a number and its unit together on screen; in indexed
// text they would stop "10 EUR" from matching a query typed with an ordinary space.
const NO_BREAK_SPACES = new RegExp(`[${String.fromCodePoint(0xa0, 0x2007, 0x202f)}]`, "gu");

/** The text with every no-break space replaced by an ordinary one. */
export function plainSpaces(text: string): string {
  return text.replaceAll(NO_BREAK_SPACES, " ");
}
