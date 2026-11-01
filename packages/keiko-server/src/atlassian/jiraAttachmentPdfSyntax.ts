import { Buffer } from "node:buffer";

/**
 * A bounded, single-pass reader of PDF object syntax (#4176). A credential scan must read a PDF the
 * way a viewer does: dictionary names are decoded (`/F#69lter` is `/Filter`), strings are decoded
 * (hexadecimal, escaped literal, UTF-16 text), and a stream's own dictionary says how its bytes are
 * encoded. Pattern matching on the file's source text misses every one of those spellings.
 *
 * `file` mode reads a whole file strictly: stream data is skipped and located, and syntax this
 * reader cannot interpret makes the result undefined so the caller refuses the file. `inflated`
 * mode reads the decoded bytes of a stream (an object stream or content stream) leniently, since
 * those bytes can be any data, and only collects the strings and names.
 */
export interface PdfStream {
  /** Offset of the `stream` keyword. */
  readonly keywordStart: number;
  /** Offset of the first data byte and of the first byte after the data. */
  readonly start: number;
  readonly end: number;
  /** The decoded filter names, or undefined when the dictionary does not state them readably. */
  readonly filters: readonly string[] | undefined;
}

export interface PdfSyntax {
  readonly streams: readonly PdfStream[];
  /** Every decoded dictionary or array name. */
  readonly names: ReadonlySet<string>;
  /** Every decoded string, one per line. */
  readonly stringText: string;
}

const TAB = 9;
const LF = 10;
const FF = 12;
const CR = 13;
const SPACE = 32;
const PERCENT = 0x25;
const LPAREN = 0x28;
const RPAREN = 0x29;
const SLASH = 0x2f;
const LT = 0x3c;
const GT = 0x3e;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const BACKSLASH = 0x5c;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const STRING_BATCH = 4096;
const STREAM_KEYWORD = "stream";
const END_STREAM = "endstream";
const NUMBER = /^[+-]?\d+$/u;
const NAME_ESCAPE = /#([0-9A-Fa-f]{2})/gu;
const HEX_DIGITS = /^[0-9A-Fa-f]*$/u;
const WHITESPACE_RUN = /[\0\t\n\f\r ]+/gu;

const SPACES: ReadonlySet<number> = new Set([0, TAB, LF, FF, CR, SPACE]);
const DELIMITERS: ReadonlySet<number> = new Set([
  PERCENT,
  LPAREN,
  RPAREN,
  SLASH,
  LT,
  GT,
  LBRACKET,
  RBRACKET,
  LBRACE,
  RBRACE,
]);
const ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
};

function isRegular(code: number): boolean {
  return !SPACES.has(code) && !DELIMITERS.has(code);
}

function isOctal(code: number): boolean {
  return code >= 0x30 && code <= 0x37;
}

/** One backslash escape of a literal string: its text and the offset after it. */
function readEscape(raw: string, at: number): { readonly text: string; readonly next: number } {
  const char = raw.charAt(at);
  const code = raw.charCodeAt(at);
  if (isOctal(code)) {
    let end = at + 1;
    while (end < at + 3 && isOctal(raw.charCodeAt(end))) end += 1;
    return { text: String.fromCharCode(Number.parseInt(raw.slice(at, end), 8) & 0xff), next: end };
  }
  if (code === CR) return { text: "", next: raw.charCodeAt(at + 1) === LF ? at + 2 : at + 1 };
  return { text: ESCAPES[char] ?? char, next: at + 1 };
}

/** The text of a PDF text string: UTF-16 and UTF-8 behind their byte order mark, else Latin-1. */
function textStringVariants(latin1: string): readonly string[] {
  const first = latin1.charCodeAt(0);
  const second = latin1.charCodeAt(1);
  let decoded = latin1;
  if ((first === 0xfe && second === 0xff) || (first === 0xff && second === 0xfe)) {
    decoded = utf16Text(Buffer.from(latin1.slice(2), "latin1"), first === 0xfe);
  } else if (first === 0xef && second === 0xbb && latin1.charCodeAt(2) === 0xbf) {
    decoded = Buffer.from(latin1.slice(3), "latin1").toString("utf8");
  }
  // A text string whose two-byte characters carry no byte order mark still reads as ASCII with NULs.
  return decoded.includes("\0") ? [decoded, decoded.replaceAll("\0", "")] : [decoded];
}

function utf16Text(bytes: Buffer, bigEndian: boolean): string {
  const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
  return (bigEndian ? Buffer.from(even).swap16() : even).toString("utf16le");
}

function decodeName(encoded: string): string {
  return encoded.replace(NAME_ESCAPE, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** The index after the array that opens at `index`. */
function skipArray(tokens: readonly string[], index: number): number {
  let depth = 0;
  for (let at = index; at < tokens.length; at += 1) {
    if (tokens[at] === "[") depth += 1;
    else if (tokens[at] === "]") depth -= 1;
    if (depth === 0) return at + 1;
  }
  return tokens.length;
}

/** Whether `n g R` (an indirect reference) starts at `index`. */
function isReference(tokens: readonly string[], index: number): boolean {
  return (
    NUMBER.test(tokens[index] ?? "") &&
    NUMBER.test(tokens[index + 1] ?? "") &&
    tokens[index + 2] === "R"
  );
}

/** The index of the first token after the value that starts at `index`. */
function skipValue(tokens: readonly string[], index: number): number {
  if (tokens[index] === "[") return skipArray(tokens, index);
  return index + (isReference(tokens, index) ? 3 : 1);
}

/** The filter names a stream dictionary states, or undefined when it states them unreadably. */
function dictionaryFilters(tokens: readonly string[]): readonly string[] | undefined {
  let index = 0;
  while (index < tokens.length) {
    const key = tokens[index] ?? "";
    const valueAt = index + 1;
    if (key === "/Filter") return filterNames(tokens, valueAt);
    index = key.startsWith("/") ? skipValue(tokens, valueAt) : valueAt;
  }
  return [];
}

function filterNames(tokens: readonly string[], at: number): readonly string[] | undefined {
  const value = tokens[at];
  if (value?.startsWith("/") === true) return [value.slice(1)];
  if (value !== "[") return undefined;
  const names: string[] = [];
  for (let index = at + 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "]") return names;
    if (!token.startsWith("/")) return undefined;
    names.push(token.slice(1));
  }
  return undefined;
}

class PdfReader {
  private position = 0;
  private readonly raw: string;
  private readonly strict: boolean;
  private readonly names = new Set<string>();
  private readonly streams: PdfStream[] = [];
  private readonly flushed: string[] = [];
  private pending: string[] = [];
  private readonly frames: string[][] = [];
  private lastDictionary: readonly string[] | undefined;

  constructor(raw: string, strict: boolean) {
    this.raw = raw;
    this.strict = strict;
  }

  read(): PdfSyntax | undefined {
    while (this.position < this.raw.length) {
      if (!this.step()) return undefined;
    }
    this.flush();
    return { streams: this.streams, names: this.names, stringText: this.flushed.join("\n") };
  }

  private flush(): void {
    if (this.pending.length > 0) this.flushed.push(this.pending.join("\n"));
    this.pending = [];
  }

  private addString(latin1: string): void {
    this.token("(");
    for (const variant of textStringVariants(latin1)) {
      if (variant.length === 0) continue;
      this.pending.push(variant);
      if (this.pending.length >= STRING_BATCH) {
        this.flush();
      }
    }
  }

  private token(value: string): void {
    this.frames.at(-1)?.push(value);
  }

  /** Whether reading may continue after syntax a strict reader cannot interpret. */
  private recover(next: number): boolean {
    this.position = next;
    return !this.strict;
  }

  private step(): boolean {
    const code = this.raw.charCodeAt(this.position);
    if (SPACES.has(code)) {
      this.position += 1;
      return true;
    }
    if (code === PERCENT) return this.skipComment();
    if (code === SLASH) return this.readName();
    if (code === LPAREN) return this.readLiteral();
    return this.stepDelimiter(code);
  }

  private stepDelimiter(code: number): boolean {
    if (code === LT) {
      return this.raw.charCodeAt(this.position + 1) === LT ? this.openDictionary() : this.readHex();
    }
    if (code === GT) {
      return this.raw.charCodeAt(this.position + 1) === GT
        ? this.closeDictionary()
        : this.recover(this.position + 1);
    }
    if (code === LBRACKET || code === RBRACKET) {
      this.token(code === LBRACKET ? "[" : "]");
      this.position += 1;
      return true;
    }
    if (DELIMITERS.has(code)) return this.recover(this.position + 1);
    return this.readKeyword();
  }

  private skipComment(): boolean {
    let end = this.position;
    while (
      end < this.raw.length &&
      this.raw.charCodeAt(end) !== LF &&
      this.raw.charCodeAt(end) !== CR
    ) {
      end += 1;
    }
    this.position = end;
    return true;
  }

  private readName(): boolean {
    let end = this.position + 1;
    while (end < this.raw.length && isRegular(this.raw.charCodeAt(end))) end += 1;
    const name = decodeName(this.raw.slice(this.position + 1, end));
    this.names.add(name);
    this.token(`/${name}`);
    this.position = end;
    return true;
  }

  private openDictionary(): boolean {
    this.token("<<");
    this.frames.push([]);
    this.position += 2;
    return true;
  }

  private closeDictionary(): boolean {
    const frame = this.frames.pop();
    if (frame === undefined) return this.recover(this.position + 2);
    this.position += 2;
    if (this.frames.length === 0) this.lastDictionary = frame;
    else this.token(">>");
    return true;
  }

  private readLiteral(): boolean {
    const parts: string[] = [];
    let depth = 1;
    let chunk = this.position + 1;
    for (let index = chunk; index < this.raw.length; index += 1) {
      const code = this.raw.charCodeAt(index);
      if (code === BACKSLASH) {
        parts.push(this.raw.slice(chunk, index));
        const escape = readEscape(this.raw, index + 1);
        parts.push(escape.text);
        chunk = escape.next;
        index = escape.next - 1;
        continue;
      }
      if (code === LPAREN) depth += 1;
      if (code === RPAREN) depth -= 1;
      if (depth > 0) continue;
      parts.push(this.raw.slice(chunk, index));
      this.addString(parts.join(""));
      this.position = index + 1;
      return true;
    }
    // Unterminated: a lenient reader still decodes what is there.
    parts.push(this.raw.slice(chunk));
    this.addString(parts.join(""));
    return this.recover(this.raw.length);
  }

  private readHex(): boolean {
    const close = this.raw.indexOf(">", this.position + 1);
    const next = close < 0 ? this.raw.length : close + 1;
    const digits = this.raw
      .slice(this.position + 1, close < 0 ? next : close)
      .replace(WHITESPACE_RUN, "");
    if (close < 0 || !HEX_DIGITS.test(digits)) return this.recover(next);
    const even = digits.length % 2 === 0 ? digits : `${digits}0`;
    this.addString(Buffer.from(even, "hex").toString("latin1"));
    this.position = next;
    return true;
  }

  private readKeyword(): boolean {
    let end = this.position;
    while (end < this.raw.length && isRegular(this.raw.charCodeAt(end))) end += 1;
    const keyword = this.raw.slice(this.position, end);
    const keywordStart = this.position;
    this.position = end;
    if (keyword === "obj" || keyword === "endobj") this.lastDictionary = undefined;
    if (this.frames.length > 0) {
      this.token(keyword);
      return true;
    }
    if (keyword === STREAM_KEYWORD && this.strict) return this.readStream(keywordStart);
    return true;
  }

  /** Locate the stream data that follows the `stream` keyword and skip it. */
  private readStream(keywordStart: number): boolean {
    const after = this.position;
    const lineEnd = this.raw.startsWith("\r\n", after) ? after + 2 : after + 1;
    if (this.raw.charCodeAt(after) !== LF && lineEnd !== after + 2) return this.recover(after);
    const endKeyword = this.raw.indexOf(END_STREAM, lineEnd);
    if (endKeyword < 0) return this.recover(this.raw.length);
    let end = endKeyword;
    if (this.raw.charCodeAt(end - 1) === LF) end -= 1;
    if (this.raw.charCodeAt(end - 1) === CR) end -= 1;
    end = Math.max(end, lineEnd);
    const filters =
      this.lastDictionary === undefined ? undefined : dictionaryFilters(this.lastDictionary);
    this.streams.push({ keywordStart, start: lineEnd, end, filters });
    this.lastDictionary = undefined;
    this.position = endKeyword + END_STREAM.length;
    return true;
  }
}

/** Read the syntax of a PDF file (`file`) or of a stream's decoded bytes (`inflated`). */
export function readPdfSyntax(raw: string, mode: "file" | "inflated"): PdfSyntax | undefined {
  return new PdfReader(raw, mode === "file").read();
}
