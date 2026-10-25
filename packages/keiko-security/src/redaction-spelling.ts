import { REDACTION_PLACEHOLDER as REDACTED } from "./redaction-source-map.js";

// Exact secrets as a text may spell them (PR #4064 review, #3903 AC3): a server that echoes a
// credential it received hands it back inside JSON, a URL or an HTML page, where each character may
// be written as itself or escaped, in any mix. A JSON parser, a URL decoder or a browser restores the
// exact secret from any of these spellings, so each counts as the secret. Only text that decodes to
// one of the given secrets is replaced, never a heuristic shape.

const BACKSLASH = "\\";
/** JSON's two-character escapes. */
const JSON_SHORT_ESCAPES: ReadonlySet<string> = new Set(['"', "\\", "/"]);
/** HTML's named references for the characters a secret's printable ASCII may contain. */
const HTML_NAMES: Readonly<Record<string, readonly string[]>> = {
  '"': ["&quot;"],
  "&": ["&amp;"],
  "<": ["&lt;"],
  ">": ["&gt;"],
  "'": ["&apos;"],
};
/** Characters that begin an escaped spelling; any other position starts only with a plain character. */
const SPELLING_STARTS: ReadonlySet<string> = new Set(["\\", "%", "&"]);

// How one character may be written, lowercased (hex digits and reference names compare without
// case): JSON's `\uXXXX` and short escapes, the same again inside a JSON string (JSON in JSON),
// URL percent-encoding, and HTML decimal, hexadecimal and named references.
function characterSpellings(character: string): readonly string[] {
  const code = character.codePointAt(0) ?? 0;
  const hex2 = code.toString(16).padStart(2, "0");
  const json = [
    String.raw`\u${code.toString(16).padStart(4, "0")}`,
    ...(JSON_SHORT_ESCAPES.has(character) ? [`${BACKSLASH}${character}`] : []),
  ];
  const nested = json.map((spelling) =>
    spelling.replaceAll(BACKSLASH, String.raw`\\`).replaceAll('"', String.raw`\"`),
  );
  const html = [`&#${String(code)};`, `&#x${hex2};`, ...(HTML_NAMES[character] ?? [])];
  return [...new Set([...json, ...nested, `%${hex2}`, ...html])]
    .map((spelling) => spelling.toLowerCase())
    .sort((left, right) => right.length - left.length);
}

interface SecretPlan {
  readonly secret: string;
  readonly spellings: readonly (readonly string[])[];
}

function plan(secret: string): SecretPlan {
  return { secret, spellings: Array.from(secret, characterSpellings) };
}

interface Steps {
  readonly lengths: readonly number[];
  /** The text ended inside a spelling that more text could complete. */
  readonly partial: boolean;
}

// Every way `character` is spelled at `position`, by length.
function stepsAt(
  text: string,
  position: number,
  character: string,
  spellings: readonly string[],
): Steps {
  if (position >= text.length) return { lengths: [], partial: true };
  const lengths: number[] = text.charAt(position) === character ? [1] : [];
  let partial = false;
  if (!SPELLING_STARTS.has(text.charAt(position))) return { lengths, partial };
  for (const spelling of spellings) {
    const available = text.slice(position, position + spelling.length).toLowerCase();
    if (available === spelling) lengths.push(spelling.length);
    else if (available.length < spelling.length && spelling.startsWith(available)) partial = true;
  }
  return { lengths, partial };
}

type Spelled = { readonly end: number } | "partial" | undefined;

// The secret spelled from `start`: its end, "partial" when only more text could complete it, or
// undefined. Every character may take any of its spellings, so all reachable ends are followed.
function spelledAt(text: string, start: number, secret: SecretPlan): Spelled {
  let ends: ReadonlySet<number> = new Set([start]);
  let partial = false;
  for (let index = 0; index < secret.secret.length; index += 1) {
    const character = secret.secret.charAt(index);
    const next = new Set<number>();
    for (const end of ends) {
      const steps = stepsAt(text, end, character, secret.spellings[index] ?? []);
      for (const length of steps.lengths) next.add(end + length);
      partial ||= steps.partial;
    }
    if (next.size === 0) return partial ? "partial" : undefined;
    ends = next;
  }
  return { end: Math.max(...ends) };
}

interface Scan {
  /** Where the published text ends; the rest waits for more text. */
  readonly end: number;
  readonly spans: readonly { readonly start: number; readonly end: number }[];
}

// The secrets spelled in `text`, and how far it can be published: up to the first position where
// a secret may still be completing, unless the text is final.
function scan(text: string, secrets: readonly SecretPlan[], final: boolean): Scan {
  const spans: { start: number; end: number }[] = [];
  const firsts = new Set(secrets.map((secret) => secret.secret.charAt(0)));
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
      const spelled = spelledAt(text, position, secret);
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
  /** What can no longer belong to a secret, with every spelled secret replaced. */
  push(text: string): string;
  /** What remains once the stream completed; a cancelled stream discards its instance instead. */
  finish(): string;
  /** Spelled secrets replaced so far. */
  redactedCount(): number;
}

/**
 * Replaces every spelling of the given exact secrets in a stream. Text that may still complete a
 * secret across the next chunk waits for it, so neither a secret's parts nor the whole reach the
 * consumer; a line break never waits, since no spelling contains one.
 */
export function createSecretSpellingStreamRedactor(
  secrets: readonly string[],
): SecretSpellingStreamRedactor {
  const plans = [...new Set(secrets)].filter((secret) => secret.length > 0).map(plan);
  let pending = "";
  let redacted = 0;
  const publish = (final: boolean): string => {
    const scanned = scan(pending, plans, final);
    redacted += scanned.spans.length;
    const published = replaced(pending, scanned);
    pending = pending.slice(scanned.end);
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
