/**
 * A deliberately small XML reader for the two Maven documents the repository relay resolves
 * credentials from (`settings.xml`, `settings-security.xml`). It models elements, text, comments,
 * processing instructions and CDATA, the five predefined entities and numeric character references,
 * and nothing else: a DOCTYPE or any other entity is a refusal, never an expansion (no external
 * entity, no entity-expansion bomb). A document it does not model yields `undefined`, so nothing
 * is resolved from it.
 */
export interface XmlElement {
  readonly name: string;
  readonly children: readonly XmlElement[];
  /** The element's own character data, trimmed. */
  readonly text: string;
}

const XML_MAX_CHARS = 1024 * 1024;
const XML_MAX_DEPTH = 64;
// A tag's attributes are read as XML defines them, a quoted value that may hold `>` but no `<`: a
// reader that ended the tag at the first `>` would take the rest of the value for character data
// and resolve a different credential than Maven does. A tag whose attributes do not fit is refused.
// The scanner below advances by position with small sticky patterns and string searches, never one
// large alternation, so no input can make it backtrack.
const TAG_NAME = /(?<close>\/)?(?<name>[A-Za-z_][\w.:-]*)/uy;
const TAG_ATTRIBUTE = /\s+[^\s=<>/"']+\s*=\s*(?:"[^"<]*"|'[^'<]*')/uy;
const TAG_END = /\s*(?<self>\/)?>/uy;
const REFERENCE =
  /&(?:(?<named>amp|lt|gt|quot|apos)|#(?<decimal>\d{1,7})|#x(?<hex>[0-9a-fA-F]{1,6}));/gu;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

interface OpenElement {
  readonly name: string;
  readonly children: XmlElement[];
  text: string;
}

interface ParseState {
  readonly stack: OpenElement[];
  root: XmlElement | undefined;
}

type TokenGroups = Readonly<
  Partial<Record<"cdata" | "close" | "name" | "self" | "text", string | undefined>>
>;

interface Token {
  readonly groups: TokenGroups;
  readonly next: number;
}

function delimited(xml: string, index: number, open: string, close: string): number | undefined {
  const end = xml.indexOf(close, index + open.length);
  return end < 0 ? undefined : end + close.length;
}

function matchAt(pattern: RegExp, xml: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(xml);
}

function tagToken(xml: string, index: number): Token | undefined {
  const head = matchAt(TAG_NAME, xml, index + 1);
  if (head === null) return undefined;
  let cursor = TAG_NAME.lastIndex;
  while (matchAt(TAG_ATTRIBUTE, xml, cursor) !== null) cursor = TAG_ATTRIBUTE.lastIndex;
  const end = matchAt(TAG_END, xml, cursor);
  if (end === null) return undefined;
  return {
    groups: { close: head.groups?.close, name: head.groups?.name, self: end.groups?.self },
    next: TAG_END.lastIndex,
  };
}

function markupToken(xml: string, index: number): Token | undefined {
  if (xml.startsWith("<![CDATA[", index)) {
    const next = delimited(xml, index, "<![CDATA[", "]]>");
    if (next === undefined) return undefined;
    return { groups: { cdata: xml.slice(index + 9, next - 3) }, next };
  }
  if (xml.startsWith("<!--", index)) {
    const next = delimited(xml, index, "<!--", "-->");
    return next === undefined ? undefined : { groups: {}, next };
  }
  if (xml.startsWith("<?", index)) {
    const next = delimited(xml, index, "<?", "?>");
    return next === undefined ? undefined : { groups: {}, next };
  }
  return tagToken(xml, index);
}

function scanToken(xml: string, index: number): Token | undefined {
  if (xml.codePointAt(index) === 0x3c) return markupToken(xml, index);
  const end = xml.indexOf("<", index);
  const next = end < 0 ? xml.length : end;
  return { groups: { text: xml.slice(index, next) }, next };
}

function characterReference(code: number): string | undefined {
  return Number.isSafeInteger(code) &&
    code > 0 &&
    code <= 0x10ffff &&
    !(code >= 0xd800 && code < 0xe000)
    ? String.fromCodePoint(code)
    : undefined;
}

function referenceText(found: Record<string, string | undefined>): string | undefined {
  if (found.named !== undefined) return NAMED_ENTITIES[found.named];
  return characterReference(
    found.decimal === undefined ? Number.parseInt(found.hex ?? "", 16) : Number(found.decimal),
  );
}

/**
 * Character data with its references decoded, exactly as the parser decodes it; anything that
 * must agree with the parser on an element's text (the run binding's rewrite) uses this.
 */
export function decodeXmlText(raw: string): string | undefined {
  return decodeText(raw);
}

/** Character data with its references decoded; `undefined` for any reference it does not model. */
function decodeText(raw: string): string | undefined {
  // A reference outside the modelled set (a DOCTYPE entity) is refused, never expanded.
  if (raw.replace(REFERENCE, "").includes("&")) return undefined;
  const references = [...raw.matchAll(REFERENCE)].map((match) => referenceText(match.groups ?? {}));
  if (references.includes(undefined)) return undefined;
  let next = 0;
  return raw.replace(REFERENCE, () => references[next++] ?? "");
}

function characterData(state: ParseState, groups: TokenGroups): boolean {
  const current = state.stack.at(-1);
  if (groups.cdata !== undefined) {
    if (current === undefined) return false;
    current.text += groups.cdata;
    return true;
  }
  const decoded = decodeText(groups.text ?? "");
  if (decoded === undefined) return false;
  if (current === undefined) return decoded.trim() === "";
  current.text += decoded;
  return true;
}

function finishElement(state: ParseState): boolean {
  const open = state.stack.pop();
  if (open === undefined) return false;
  const element: XmlElement = {
    name: open.name,
    children: open.children,
    text: open.text.trim(),
  };
  const parent = state.stack.at(-1);
  if (parent === undefined) state.root = element;
  else parent.children.push(element);
  return true;
}

function tag(state: ParseState, groups: TokenGroups): boolean {
  const name = groups.name ?? "";
  if (groups.close !== undefined) return state.stack.at(-1)?.name === name && finishElement(state);
  if (state.root !== undefined && state.stack.length === 0) return false;
  state.stack.push({ name, children: [], text: "" });
  if (state.stack.length > XML_MAX_DEPTH) return false;
  return groups.self === undefined || finishElement(state);
}

function step(state: ParseState, groups: TokenGroups): boolean {
  if (groups.name !== undefined) return tag(state, groups);
  if (groups.cdata !== undefined || groups.text !== undefined) return characterData(state, groups);
  // A comment or a processing instruction carries nothing the resolution reads.
  return true;
}

/** The root element of `xml`, or `undefined` when the document is not one this reader models. */
export function parseXmlElements(xml: string): XmlElement | undefined {
  if (xml.length > XML_MAX_CHARS || /<!(?!--|\[CDATA\[)/u.test(xml)) return undefined;
  const state: ParseState = { stack: [], root: undefined };
  let index = 0;
  while (index < xml.length) {
    const token = scanToken(xml, index);
    if (token === undefined || !step(state, token.groups)) return undefined;
    index = token.next;
  }
  return state.stack.length === 0 ? state.root : undefined;
}

export function childElements(element: XmlElement, name: string): readonly XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

export function childText(element: XmlElement, name: string): string | undefined {
  return childElements(element, name)[0]?.text;
}
