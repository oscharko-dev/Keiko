// OOXML tokenizer shared by the docx and pptx readers. A small XML-aware tokenizer (a linear scan
// with sticky, non-backtracking patterns; no regex over document bodies) yields element tags and
// character data in document order. Comments are skipped whole, CDATA sections yield their
// literal character data, and attribute values are read quote aware. Entities are never expanded
// beyond the five predefined ones and numeric character references, and every construct the text
// layer does not need - a DOCTYPE or ENTITY declaration, a processing instruction other than the
// leading XML declaration, markup that does not parse - fails closed instead of being skipped.

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

interface OpenElement {
  readonly qualified: string;
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

function trackNesting(
  stack: OpenElement[],
  tag: XmlTag,
  qualified: string,
  maxDepth: number,
): void {
  if (tag.selfClosing) return;
  if (!tag.closing) {
    if (stack.length >= maxDepth) throw new Error("ooxml xml exceeds nesting limit");
    stack.push({ qualified });
    return;
  }
  if (stack.pop()?.qualified !== qualified) throw malformed();
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

function readElement(xml: string, open: number, stack: OpenElement[], maxDepth: number): Markup {
  const closing = xml[open + 1] === "/";
  const nameStart = open + (closing ? 2 : 1);
  const name = matchAt(NAME_PATTERN, xml, nameStart)?.[0];
  if (name === undefined) throw malformed();
  const tail = readTagTail(xml, nameStart + name.length, closing);
  const tag: XmlTag = {
    kind: "tag",
    local: localNameOf(name),
    prefix: prefixOf(name),
    closing,
    selfClosing: tail.selfClosing,
    attributes: tail.attributes,
  };
  trackNesting(stack, tag, name, maxDepth);
  return { token: tag, next: tail.next };
}

function closerOf(xml: string, open: number, opener: string, closer: string): number {
  const close = xml.indexOf(closer, open + opener.length);
  if (close === -1) throw new Error("ooxml xml has an unterminated construct");
  return close;
}

function readMarkup(xml: string, open: number, stack: OpenElement[], maxDepth: number): Markup {
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
  return readElement(xml, open, stack, maxDepth);
}

function declarationEnd(xml: string): number {
  const start = xml.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
  const declaration = matchAt(XML_DECLARATION_PATTERN, xml, start);
  return declaration === null ? start : start + declaration[0].length;
}

/**
 * Yields element tags and character data in document order. Throws when the document declares a
 * DOCTYPE or ENTITY, carries a processing instruction other than the leading XML declaration,
 * contains markup that does not parse, nests deeper than `maxDepth`, or is not balanced (the
 * generator only reports a balanced document when it runs to completion).
 */
export function* scanXmlTokens(
  xml: string,
  maxDepth: number,
): Generator<XmlToken, void, undefined> {
  const stack: OpenElement[] = [];
  let cursor = declarationEnd(xml);
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    const textEnd = open === -1 ? xml.length : open;
    if (textEnd > cursor) {
      yield { kind: "text", value: decodeXmlEntities(xml.slice(cursor, textEnd)) };
    }
    if (open === -1) break;
    const markup = readMarkup(xml, open, stack, maxDepth);
    if (markup.token !== undefined) yield markup.token;
    cursor = markup.next;
  }
  if (stack.length > 0) throw new Error("ooxml xml has unterminated elements");
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
