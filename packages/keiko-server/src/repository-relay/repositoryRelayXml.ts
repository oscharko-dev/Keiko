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
const TOKEN =
  /<!\[CDATA\[(?<cdata>[\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(?<close>\/)?(?<name>[A-Za-z_][\w.:-]*)(?:\s[^<>]*?)?(?<self>\/)?>|(?<text>[^<]+)/uy;
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
    TOKEN.lastIndex = index;
    const token = TOKEN.exec(xml);
    if (token === null || !step(state, token.groups as TokenGroups)) return undefined;
    index = TOKEN.lastIndex;
  }
  return state.stack.length === 0 ? state.root : undefined;
}

export function childElements(element: XmlElement, name: string): readonly XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

export function childText(element: XmlElement, name: string): string | undefined {
  return childElements(element, name)[0]?.text;
}
