import { REDACTION_PLACEHOLDER as REDACTED } from "./redaction-source-map.js";

// Exact secrets as a text may spell them (PR #4064 review, #3903 AC3): a server that echoes a
// credential it received hands it back inside JSON, a URL or an HTML page, where each character may
// be written as itself or escaped, in any mix. A JSON parser, a URL decoder, a browser or Python's
// `html.unescape` restores the exact secret from any of these spellings, so each counts as the
// secret. Only text that decodes to one of the given secrets is replaced, never a heuristic shape.
//
// HTML character references follow the WHATWG grammar a decoder applies: a numeric reference takes
// every digit that follows, leading zeros included, with or without its semicolon; a named reference
// is the longest name of the table, case-sensitive, and the legacy names also stand without their
// semicolon. A secret is printable ASCII, which is what an admitted credential holds, so the named
// references that matter are the ones standing for printable ASCII (and `&fjlig;`, for two of its
// letters), and the longer names that begin with a legacy one, which stand for something else.

const BACKSLASH = "\\";
/** JSON's two-character escapes. */
const JSON_SHORT_ESCAPES: ReadonlySet<string> = new Set(['"', "\\", "/"]);
/** Characters that begin an escaped spelling; any other position starts only with a plain character. */
const SPELLING_STARTS: ReadonlySet<string> = new Set(["\\", "%", "+", "&"]);
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/u;
const DECIMAL_DIGITS = "0123456789";
const HEX_DIGITS = "0123456789abcdefABCDEF";
const HEX_MARKERS: ReadonlySet<string> = new Set(["x", "X"]);
/**
 * Text a stream may hold back while it may still spell a secret. Each character of the longest
 * admitted secret spelled with its longest named reference fits; nothing ordinary comes near it.
 */
const MAX_HELD_CHARS = 256 * 1024;

/** The WHATWG named references for printable ASCII, by what they stand for. */
const HTML_NAMES_BY_VALUE: Readonly<Record<string, readonly string[]>> = {
  "!": ["excl;"],
  '"': ["quot;", "quot", "QUOT;", "QUOT"],
  "#": ["num;"],
  $: ["dollar;"],
  "%": ["percnt;"],
  "&": ["amp;", "amp", "AMP;", "AMP"],
  "'": ["apos;"],
  "(": ["lpar;"],
  ")": ["rpar;"],
  "*": ["ast;", "midast;"],
  "+": ["plus;"],
  ",": ["comma;"],
  ".": ["period;"],
  "/": ["sol;"],
  ":": ["colon;"],
  ";": ["semi;"],
  "<": ["lt;", "lt", "LT;", "LT"],
  "=": ["equals;"],
  ">": ["gt;", "gt", "GT;", "GT"],
  "?": ["quest;"],
  "@": ["commat;"],
  "[": ["lsqb;", "lbrack;"],
  "\\": ["bsol;"],
  "]": ["rsqb;", "rbrack;"],
  "^": ["Hat;"],
  _: ["lowbar;", "UnderBar;"],
  "`": ["grave;", "DiacriticalGrave;"],
  "{": ["lcub;", "lbrace;"],
  "|": ["verbar;", "vert;", "VerticalLine;"],
  "}": ["rcub;", "rbrace;"],
  fj: ["fjlig;"],
};
/** The longer names that begin with a legacy one: `&ltcc;` stands for one character, not `<cc;`. */
const HTML_LONGER_NAMES: readonly string[] = [
  "gtcc;",
  "gtcir;",
  "gtdot;",
  "gtlPar;",
  "gtquest;",
  "gtrapprox;",
  "gtrarr;",
  "gtrdot;",
  "gtreqless;",
  "gtreqqless;",
  "gtrless;",
  "gtrsim;",
  "ltcc;",
  "ltcir;",
  "ltdot;",
  "lthree;",
  "ltimes;",
  "ltlarr;",
  "ltquest;",
  "ltrPar;",
  "ltri;",
  "ltrie;",
  "ltrif;",
];
const HTML_VALUES: ReadonlyMap<string, string> = new Map(
  Object.entries(HTML_NAMES_BY_VALUE).flatMap(([value, names]) =>
    names.map((name) => [name, value] as const),
  ),
);
const HTML_NAMES: readonly string[] = [...HTML_VALUES.keys(), ...HTML_LONGER_NAMES];
const LONGEST_HTML_NAME = Math.max(...HTML_NAMES.map((name) => name.length));
/** Code points Python's `html.unescape` drops instead of decoding, after its own replacements. */
const DROPPED_RANGES: readonly (readonly [number, number])[] = [
  [0x01, 0x08],
  [0x0b, 0x0b],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0xfdd0, 0xfdef],
];

/** A stream held back more text than any secret's spelling needs; it must end here, unpublished. */
export class SecretSpellingOverflowError extends RangeError {
  public override readonly name = "SecretSpellingOverflowError";
  public constructor() {
    super("secret spelling held back beyond its bound");
  }
}

// How one character may be written with a fixed escape, lowercased (hex digits compare without
// case): JSON's `\uXXXX` and short escapes, the same again inside a JSON string (JSON in JSON), URL
// percent-encoding, and a form's `+` for a space.
function characterSpellings(character: string): readonly string[] {
  const code = character.codePointAt(0) ?? 0;
  const json = [
    String.raw`\u${code.toString(16).padStart(4, "0")}`,
    ...(JSON_SHORT_ESCAPES.has(character) ? [`${BACKSLASH}${character}`] : []),
  ];
  const nested = json.map((spelling) =>
    spelling.replaceAll(BACKSLASH, String.raw`\\`).replaceAll('"', String.raw`\"`),
  );
  const url = [`%${code.toString(16).padStart(2, "0")}`, ...(character === " " ? ["+"] : [])];
  return [...new Set([...json, ...nested, ...url])]
    .map((spelling) => spelling.toLowerCase())
    .sort((left, right) => right.length - left.length);
}

/** What a spelling stands for, which may be several characters of a secret or none. */
interface Decoded {
  readonly value: string;
  readonly length: number;
}

interface Decoding {
  readonly options: readonly Decoded[];
  /** The text ended where more text could complete or change the reference. */
  readonly partial: boolean;
}

const NO_REFERENCE: Decoding = { options: [], partial: false };
const HELD_REFERENCE: Decoding = { options: [], partial: true };

function dropped(codePoint: number): boolean {
  if ((codePoint & 0xfffe) === 0xfffe) return true;
  return DROPPED_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

// What a numeric reference's digits stand for, as far as printable ASCII is concerned: its
// character, nothing where a decoder drops it, or undefined for anything else.
function numericValue(digits: string, radix: 10 | 16): string | undefined {
  let first = 0;
  while (digits.charAt(first) === "0") first += 1;
  const significant = digits.slice(first);
  // More significant digits than 0x10FFFF has in either radix stand for U+FFFD.
  if (significant.length > 7) return undefined;
  const codePoint = significant === "" ? 0 : Number.parseInt(significant, radix);
  if (codePoint >= 0x20 && codePoint <= 0x7e) return String.fromCodePoint(codePoint);
  if (codePoint > 0x10ffff || (codePoint >= 0x80 && codePoint <= 0x9f)) return undefined;
  return dropped(codePoint) ? "" : undefined;
}

/** Where the run of `digits` that begins at `start` ends. */
function digitRunEnd(text: string, start: number, digits: string): number {
  let end = start;
  while (end < text.length && digits.includes(text.charAt(end))) end += 1;
  return end;
}

function numericReference(text: string, position: number, final: boolean): Decoding {
  const hex = HEX_MARKERS.has(text.charAt(position + 2));
  const start = position + (hex ? 3 : 2);
  const end = digitRunEnd(text, start, hex ? HEX_DIGITS : DECIMAL_DIGITS);
  // More digits, or the `x` itself, may still follow.
  if (end === text.length && !final) return HELD_REFERENCE;
  if (end === start) return NO_REFERENCE;
  const value = numericValue(text.slice(start, end), hex ? 16 : 10);
  if (value === undefined) return NO_REFERENCE;
  const length = end - position + (text.charAt(end) === ";" ? 1 : 0);
  return { options: [{ value, length }], partial: false };
}

function namedReference(text: string, position: number, final: boolean): Decoding {
  const rest = text.slice(position + 1, position + 1 + LONGEST_HTML_NAME);
  let longest = "";
  for (const name of HTML_NAMES) {
    if (!final && name.length > rest.length && name.startsWith(rest)) return HELD_REFERENCE;
    if (name.length > longest.length && rest.startsWith(name)) longest = name;
  }
  const value = HTML_VALUES.get(longest);
  if (value === undefined) return NO_REFERENCE;
  return { options: [{ value, length: longest.length + 1 }], partial: false };
}

/** The HTML character reference at `position`, which holds `&`. */
function htmlReference(text: string, position: number, final: boolean): Decoding {
  return text.charAt(position + 1) === "#"
    ? numericReference(text, position, final)
    : namedReference(text, position, final);
}

type References = (position: number) => Decoding;

interface SecretPlan {
  readonly secret: string;
  readonly spellings: readonly (readonly string[])[];
}

function plan(secret: string): SecretPlan {
  return { secret, spellings: Array.from(secret, characterSpellings) };
}

/** One way forward: how many characters of the secret it spells, from how much text. */
interface Step {
  readonly advance: number;
  readonly length: number;
}

interface Steps {
  readonly steps: readonly Step[];
  /** The text ended inside a spelling that more text could complete. */
  readonly partial: boolean;
}

function referenceSteps(
  plain: readonly Step[],
  decoding: Decoding,
  secret: string,
  index: number,
): Steps {
  const steps = [...plain];
  for (const option of decoding.options) {
    // A reference standing for nothing belongs to a spelling only once it has begun.
    if (option.value === "" && index === 0) continue;
    if (secret.startsWith(option.value, index))
      steps.push({ advance: option.value.length, length: option.length });
  }
  return { steps, partial: decoding.partial };
}

function escapeSteps(
  plain: readonly Step[],
  text: string,
  position: number,
  spellings: readonly string[],
): Steps {
  const steps = [...plain];
  let partial = false;
  for (const spelling of spellings) {
    const available = text.slice(position, position + spelling.length).toLowerCase();
    if (available === spelling) steps.push({ advance: 1, length: spelling.length });
    else if (available.length < spelling.length && spelling.startsWith(available)) partial = true;
  }
  return { steps, partial };
}

// Every way the secret's character at `index` is spelled at `position`, and every reference there
// that stands for the next characters of the secret, or for none.
function stepsAt(
  text: string,
  position: number,
  secret: SecretPlan,
  index: number,
  references: References,
): Steps {
  if (position >= text.length) return { steps: [], partial: true };
  const head = text.charAt(position);
  const plain: Step[] = head === secret.secret.charAt(index) ? [{ advance: 1, length: 1 }] : [];
  if (head === "&") return referenceSteps(plain, references(position), secret.secret, index);
  if (!SPELLING_STARTS.has(head)) return { steps: plain, partial: false };
  return escapeSteps(plain, text, position, secret.spellings[index] ?? []);
}

type Spelled = { readonly end: number } | "partial" | undefined;

interface Reach {
  /** For each count of the secret's characters spelled, where in the text the spelling may end. */
  readonly ends: readonly Set<number>[];
  furthest: number;
  partial: boolean;
}

// Follows every step from the spellings of `index` characters; a reference standing for nothing
// stays at `index`, so its ends are followed too.
function follow(
  text: string,
  secret: SecretPlan,
  index: number,
  reach: Reach,
  refs: References,
): void {
  const queue = [...(reach.ends[index] ?? [])];
  for (const end of queue) {
    const steps = stepsAt(text, end, secret, index, refs);
    if (steps.partial) reach.partial = true;
    for (const step of steps.steps) {
      const target = reach.ends[index + step.advance];
      const next = end + step.length;
      if (target === undefined || target.has(next)) continue;
      target.add(next);
      reach.furthest = Math.max(reach.furthest, index + step.advance);
      if (step.advance === 0) queue.push(next);
    }
  }
}

// The secret spelled from `start`: its end, "partial" when only more text could complete it, or
// undefined. Every character may take any of its spellings, so all reachable ends are followed.
function spelledAt(text: string, start: number, secret: SecretPlan, refs: References): Spelled {
  const length = secret.secret.length;
  const reach: Reach = {
    ends: Array.from({ length: length + 1 }, () => new Set<number>()),
    furthest: 0,
    partial: false,
  };
  reach.ends[0]?.add(start);
  for (let index = 0; index < length && index <= reach.furthest; index += 1)
    follow(text, secret, index, reach, refs);
  const ends = reach.ends[length] ?? new Set<number>();
  if (ends.size === 0) return reach.partial ? "partial" : undefined;
  return { end: Math.max(...ends) };
}

interface Scan {
  /** Where the published text ends; the rest waits for more text. */
  readonly end: number;
  readonly spans: readonly { readonly start: number; readonly end: number }[];
}

// The HTML references of one text, each decoded once however many spellings pass through it.
function referencesOf(text: string, final: boolean): References {
  const decoded = new Map<number, Decoding>();
  return (position) => {
    const known = decoded.get(position);
    if (known !== undefined) return known;
    const decoding = htmlReference(text, position, final);
    decoded.set(position, decoding);
    return decoding;
  };
}

// The secrets spelled in `text`, and how far it can be published: up to the first position where
// a secret may still be completing, unless the text is final.
function scan(text: string, secrets: readonly SecretPlan[], final: boolean): Scan {
  const spans: { start: number; end: number }[] = [];
  const firsts = new Set(secrets.map((secret) => secret.secret.charAt(0)));
  const references = referencesOf(text, final);
  let position = 0;
  while (position < text.length) {
    const first = text.charAt(position);
    if (!firsts.has(first) && !SPELLING_STARTS.has(first)) {
      position += 1;
      continue;
    }
    let end: number | undefined;
    let waits = false;
    for (const secret of secrets) {
      const spelled = spelledAt(text, position, secret, references);
      if (spelled === "partial") waits = !final;
      else if (spelled !== undefined) end = Math.max(end ?? 0, spelled.end);
    }
    if (waits) return { end: position, spans };
    if (end === undefined) position += 1;
    else {
      spans.push({ start: position, end });
      position = end;
    }
  }
  return { end: text.length, spans };
}

function replaced(text: string, scanned: Scan): string {
  const parts: string[] = [];
  let from = 0;
  for (const span of scanned.spans) {
    parts.push(text.slice(from, span.start), REDACTED);
    from = span.end;
  }
  parts.push(text.slice(from, scanned.end));
  return parts.join("");
}

export interface SecretSpellingStreamRedactor {
  /**
   * What can no longer belong to a secret, with every spelled secret replaced. Throws
   * SecretSpellingOverflowError when more text is held back than any secret's spelling needs; the
   * held text is never published, and the instance takes no more text.
   */
  push(text: string): string;
  /** What remains once the stream completed; a cancelled stream discards its instance instead. */
  finish(): string;
  /** Spelled secrets replaced so far. */
  redactedCount(): number;
}

/**
 * Replaces every spelling of the given exact secrets, each printable ASCII, in a stream. Text that
 * may still complete a secret across the next chunk waits for it, so neither a secret's parts nor
 * the whole reach the consumer; a line break never waits, since no spelling contains one.
 */
export function createSecretSpellingStreamRedactor(
  secrets: readonly string[],
): SecretSpellingStreamRedactor {
  if (!secrets.every((secret) => PRINTABLE_ASCII.test(secret)))
    throw new TypeError("secret-not-printable-ascii");
  const plans = [...new Set(secrets)].filter((secret) => secret.length > 0).map(plan);
  let pending = "";
  let redacted = 0;
  let overflowed = false;
  const publish = (final: boolean): string => {
    if (overflowed) throw new SecretSpellingOverflowError();
    const scanned = scan(pending, plans, final);
    redacted += scanned.spans.length;
    const published = replaced(pending, scanned);
    pending = pending.slice(scanned.end);
    if (pending.length > MAX_HELD_CHARS) {
      overflowed = true;
      pending = "";
      throw new SecretSpellingOverflowError();
    }
    return published;
  };
  return {
    push(text: string): string {
      pending += text;
      return publish(false);
    },
    finish(): string {
      return publish(true);
    },
    redactedCount: (): number => redacted,
  };
}
