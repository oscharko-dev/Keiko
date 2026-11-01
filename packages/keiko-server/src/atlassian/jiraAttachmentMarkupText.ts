import { decodeXmlEntities } from "@oscharko-dev/keiko-workspace";

/**
 * The text a markup parser recovers from an XML-like source (#4176): comments, processing
 * instructions and tags are dropped (quoted attribute values may contain `>`), CDATA is unwrapped
 * and the character and entity references of the text between tags are decoded. Text runs that the
 * markup splits are therefore joined, as a reader of the document sees them. One linear pass: an
 * unterminated construct consumes the rest of the source, so no input makes this quadratic.
 */
export function markupText(source: string): string {
  const parts: string[] = [];
  let position = 0;
  while (position < source.length) {
    const open = source.indexOf("<", position);
    if (open < 0) {
      parts.push(decodeXmlEntities(source.slice(position)));
      break;
    }
    parts.push(decodeXmlEntities(source.slice(position, open)));
    const construct = readConstruct(source, open);
    if (construct.text !== undefined) parts.push(construct.text);
    position = construct.end;
  }
  return parts.join("");
}

interface Construct {
  /** The text the construct contributes, undefined when it contributes none. */
  readonly text?: string;
  /** The offset of the first character after the construct. */
  readonly end: number;
}

function terminated(source: string, from: number, closer: string): number {
  const at = source.indexOf(closer, from);
  return at < 0 ? source.length : at + closer.length;
}

const TAG_START = /[A-Za-z_:/!]/u;

/** The end of a tag, skipping a `>` inside a quoted attribute value. */
function tagEnd(source: string, from: number): number {
  let quote = "";
  for (let index = from; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (quote !== "") {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  return source.length;
}

function readConstruct(source: string, open: number): Construct {
  if (source.startsWith("<!--", open)) return { end: terminated(source, open + 4, "-->") };
  if (source.startsWith("<![CDATA[", open)) {
    const close = source.indexOf("]]>", open + 9);
    return close < 0
      ? { text: source.slice(open + 9), end: source.length }
      : { text: source.slice(open + 9, close), end: close + 3 };
  }
  if (source.startsWith("<?", open)) return { end: terminated(source, open + 2, "?>") };
  // A `<` that opens no tag (a comparison in prose) is ordinary text.
  if (!TAG_START.test(source.charAt(open + 1))) return { text: "<", end: open + 1 };
  return { end: tagEnd(source, open + 1) };
}
