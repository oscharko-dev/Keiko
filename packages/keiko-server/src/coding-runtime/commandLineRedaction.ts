/**
 * Masks the value of a credential-named option in one command line. The credential floor
 * (`redactCredentialShapes`) knows header, URL and token shapes but not `--password=value` or
 * `-Dpassword=value`, so the approval card applies this first and the floor second.
 *
 * Covered spellings: `--name=v`, `--name v`, `-Dname=v`, `NAME=v` environment prefixes, a quoted
 * whole argument such as `"--password=p@ss word"` (the card quotes any argument with special
 * characters), `-u user:pass` / `--user user:pass`, and `scheme://user:pass@host` userinfo. An
 * unterminated quote is treated as a literal character, never as a span that swallows the rest.
 *
 * Scope: the approval preview only. Widening the shared floor changes every content surface
 * (Chat, memory, history) and is a separate, ADR-0022 decision; this projection stays local to the
 * one line a person approves.
 *
 * The scan is a single linear pass: no regular expression with nested or overlapping quantifiers,
 * so a hostile line cannot cost more than its length.
 */

const MASK = "[REDACTED]";
const SENSITIVE_NAME = /(?:pass|pwd|secret|token|key|credential|auth|cert)/iu;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const USER_OPTIONS: ReadonlySet<string> = new Set(["-u", "--user", "--proxy-user"]);

interface Token {
  readonly text: string;
  readonly space: boolean;
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isQuote(char: string): boolean {
  return char === '"' || char === "'";
}

/** The end of the word at `start`; a quote keeps its whole span, an unclosed one is literal. */
function wordEnd(line: string, start: number): number {
  let index = start;
  let quote: string | undefined;
  while (index < line.length) {
    const char = line.charAt(index);
    if (quote === undefined && isSpace(char)) return index;
    if (isQuote(char)) quote = quote === undefined ? char : quote === char ? undefined : quote;
    index += 1;
  }
  return quote === undefined ? index : literalWordEnd(line, start);
}

function literalWordEnd(line: string, start: number): number {
  let index = start;
  while (index < line.length && !isSpace(line.charAt(index))) index += 1;
  return index;
}

/** Splits into runs of whitespace and words. */
function tokenize(line: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < line.length) {
    const space = isSpace(line.charAt(index));
    let end = index + 1;
    if (space) {
      while (end < line.length && isSpace(line.charAt(end))) end += 1;
    } else {
      end = wordEnd(line, index);
    }
    tokens.push({ text: line.slice(index, end), space });
    index = end;
  }
  return tokens;
}

interface Core {
  readonly prefix: string;
  readonly core: string;
  readonly suffix: string;
}

/** Splits the quotes wrapped around a whole argument from its content. */
function unwrap(word: string): Core {
  let start = 0;
  while (start < word.length && isQuote(word.charAt(start))) start += 1;
  // Only a whole quoted argument has a closing quote to peel; `--password="a b"` keeps its own.
  let end = word.length;
  while (start > 0 && end > start && isQuote(word.charAt(end - 1))) end -= 1;
  return { prefix: word.slice(0, start), core: word.slice(start, end), suffix: word.slice(end) };
}

/** The option name of `--name[=v]`, `-Dname[=v]` or `NAME=v`, or undefined for any other word. */
function optionName(
  core: string,
): { readonly name: string; readonly hasValue: boolean } | undefined {
  const dashed = core.startsWith("--") || core.startsWith("-D");
  const body = dashed ? core.slice(2) : core;
  const equals = body.indexOf("=");
  if (equals < 0) return dashed && body.length > 0 ? { name: body, hasValue: false } : undefined;
  const name = body.slice(0, equals);
  return dashed || ENV_NAME.test(name) ? { name, hasValue: true } : undefined;
}

function maskValue(core: string): string {
  return `${core.slice(0, core.indexOf("=") + 1)}${MASK}`;
}

/** `scheme://user:pass@host/…`: the userinfo before the last `@` of the authority is masked. */
function maskUserinfo(core: string): string {
  const scheme = core.indexOf("://");
  if (scheme < 0) return core;
  const from = scheme + 3;
  let end = from;
  while (end < core.length && !"/?#".includes(core.charAt(end))) end += 1;
  const at = core.lastIndexOf("@", end - 1);
  return at < from ? core : `${core.slice(0, from)}${MASK}${core.slice(at)}`;
}

function maskWord(word: string): { readonly text: string; readonly maskNext: boolean } {
  const { prefix, core, suffix } = unwrap(word);
  const option = optionName(core);
  if (option !== undefined && SENSITIVE_NAME.test(option.name)) {
    // `--password value`: only the double-dash spelling separates its value by a space.
    return option.hasValue
      ? { text: `${prefix}${maskValue(core)}${suffix}`, maskNext: false }
      : { text: word, maskNext: core.startsWith("--") };
  }
  return { text: `${prefix}${maskUserinfo(core)}${suffix}`, maskNext: USER_OPTIONS.has(core) };
}

/** Returns the line with the value of every credential-named option replaced by a mask. */
export function redactCommandLineCredentials(line: string): string {
  let maskNext = false;
  return tokenize(line)
    .map((token) => {
      if (token.space) return token.text;
      const takesValue = maskNext;
      maskNext = false;
      // A following option is not the value: `--auth --verbose` masks nothing.
      if (takesValue && !unwrap(token.text).core.startsWith("-")) return MASK;
      const masked = maskWord(token.text);
      maskNext = masked.maskNext;
      return masked.text;
    })
    .join("");
}
