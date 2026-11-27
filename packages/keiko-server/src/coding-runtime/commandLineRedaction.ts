/**
 * Masks the value of a credential-named option in one command line. The credential floor
 * (`redactCredentialShapes`) knows header, URL and token shapes but not `--password=value` or
 * `-Dpassword=value`, so the approval card applies this first and the floor second.
 *
 * Covered spellings: `--name=v`, `--name v`, `-Dname=v`, `NAME=v` and PowerShell `$env:NAME=v`
 * prefixes, `--env=NAME=v` / `--env NAME=v`, a quoted whole argument such as `"--password=p@ss
 * word"` (the card quotes any argument with special characters), `-u user:pass`, `-uuser:pass`,
 * `--user user:pass` and `scheme://user:pass@host` userinfo. A bare `-p <value>` is deliberately not
 * masked: too many tools use it for a port or a path, and the shared floor stays behind it.
 *
 * A name is sensitive when its LAST segment (split on `-`, `_`, `.`, any case) is a credential
 * word, never on a substring: `--db-password` is masked, `--pass-through` and `--key-file` are not.
 *
 * Quotes follow the shell: inside double quotes a backslash escapes the next character, inside
 * single quotes it does not. When the span is unsure (an unterminated quote, or an escaped quote
 * in a masked value) the mask runs to the end of the token run, up to the next `&&`, `||`, `;` or
 * `|`, because showing a credential costs more than hiding a harmless word.
 *
 * Scope: the approval preview only. Widening the shared floor changes every content surface
 * (Chat, memory, history) and is a separate, ADR-0022 decision; this projection stays local to the
 * one line a person approves.
 *
 * The scan is a single linear pass: no regular expression with nested or overlapping quantifiers,
 * so a hostile line cannot cost more than its length.
 */

const MASK = "[REDACTED]";
const SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set([
  "pass",
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "pw",
  "secret",
  "token",
  "key",
  "apikey",
  "credential",
  "credentials",
  "auth",
  "cert",
]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const USER_OPTIONS: ReadonlySet<string> = new Set(["-u", "--user", "--proxy-user"]);
const SEPARATORS: ReadonlySet<string> = new Set(["&&", "||", ";", "|", "&"]);
const POWERSHELL_ENV = "$env:";

type Pending = "none" | "next" | "env" | "run";

interface Token {
  readonly text: string;
  readonly space: boolean;
  /** A quote opened and never closed; the word then ends at the next whitespace. */
  readonly open: boolean;
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isQuote(char: string): boolean {
  return char === '"' || char === "'";
}

function stripQuotes(text: string): string {
  let out = "";
  for (const char of text) if (!isQuote(char)) out += char;
  return out;
}

function isSensitiveName(name: string): boolean {
  const segments = stripQuotes(name)
    .split(/[-_.]/u)
    .filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  return last !== undefined && SENSITIVE_SEGMENTS.has(last.toLowerCase());
}

function literalWordEnd(line: string, start: number): number {
  let index = start;
  while (index < line.length && !isSpace(line.charAt(index))) index += 1;
  return index;
}

/** The end of the word at `start`: a quote keeps its span, a backslash escapes outside single quotes. */
function scanWord(line: string, start: number): { readonly end: number; readonly open: boolean } {
  let index = start;
  let quote: string | undefined;
  while (index < line.length) {
    const char = line.charAt(index);
    if (quote === undefined && isSpace(char)) return { end: index, open: false };
    if (char === "\\" && quote !== "'") {
      index += 2;
      continue;
    }
    if (isQuote(char)) quote = quote === undefined ? char : quote === char ? undefined : quote;
    index += 1;
  }
  return quote === undefined
    ? { end: Math.min(index, line.length), open: false }
    : { end: literalWordEnd(line, start), open: true };
}

/** Splits into runs of whitespace and words. */
function tokenize(line: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < line.length) {
    const space = isSpace(line.charAt(index));
    let end = index + 1;
    let open = false;
    if (space) {
      while (end < line.length && isSpace(line.charAt(end))) end += 1;
    } else {
      ({ end, open } = scanWord(line, index));
    }
    tokens.push({ text: line.slice(index, end), space, open });
    index = end;
  }
  return tokens;
}

interface Core {
  readonly prefix: string;
  readonly core: string;
}

/** Splits the quotes wrapped around the start of a whole quoted argument from its content. */
function unwrap(word: string): Core {
  let start = 0;
  while (start < word.length && isQuote(word.charAt(start))) start += 1;
  return { prefix: word.slice(0, start), core: word.slice(start) };
}

interface Option {
  readonly name: string;
  readonly hasValue: boolean;
  /** Only the double-dash spelling separates its value by a space. */
  readonly spaced: boolean;
}

/** The option of `--name[=v]`, `-Dname[=v]`, `$env:NAME[=v]` or `NAME=v`, or undefined. */
function optionOf(core: string): Option | undefined {
  const lower = core.slice(0, POWERSHELL_ENV.length).toLowerCase();
  const double = core.startsWith("--");
  const lead =
    lower === POWERSHELL_ENV ? POWERSHELL_ENV.length : double || core.startsWith("-D") ? 2 : 0;
  const body = core.slice(lead);
  const equals = body.indexOf("=");
  if (equals < 0)
    return lead > 0 && body.length > 0
      ? { name: body, hasValue: false, spaced: double }
      : undefined;
  const name = body.slice(0, equals);
  return lead > 0 || ENV_NAME.test(name) ? { name, hasValue: true, spaced: double } : undefined;
}

function hasEscapedQuote(word: string): boolean {
  for (let index = 0; index + 1 < word.length; index += 1) {
    if (word.charAt(index) === "\\" && isQuote(word.charAt(index + 1))) return true;
  }
  return false;
}

/** Everything up to and including the first `=`, then a mask; a quote left open is closed again. */
function maskValue(word: string): string {
  const head = word.slice(0, word.indexOf("=") + 1);
  let open: string | undefined;
  for (const char of head) {
    if (isQuote(char)) open = open === undefined ? char : open === char ? undefined : open;
  }
  return `${head}${MASK}${open ?? ""}`;
}

/** `NAME=secret` of `--env`: the value after the second `=` when NAME is sensitive. */
function maskEnvAssignment(assignment: string): string {
  const equals = assignment.indexOf("=");
  const name = assignment.slice(0, equals);
  return equals > 0 && ENV_NAME.test(stripQuotes(name)) && isSensitiveName(name)
    ? `${assignment.slice(0, equals + 1)}${MASK}`
    : assignment;
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

function maskLoose(prefix: string, core: string): { text: string; pending: Pending } {
  // `-uuser:pass`: the colon spelling only; a bare `-u` value is masked as the next word.
  if (core.startsWith("-u") && core.indexOf(":") > 2)
    return { text: `${prefix}-u${MASK}`, pending: "none" };
  return { text: `${prefix}${maskUserinfo(core)}`, pending: "none" };
}

function maskOption(
  token: Token,
  prefix: string,
  core: string,
  option: Option,
): { text: string; pending: Pending } {
  if (isSensitiveName(option.name)) {
    if (!option.hasValue) return { text: token.text, pending: option.spaced ? "next" : "none" };
    const unsure = token.open || hasEscapedQuote(token.text);
    return { text: maskValue(token.text), pending: unsure ? "run" : "none" };
  }
  if (stripQuotes(option.name).toLowerCase() !== "env" || !option.spaced) {
    return { text: token.text, pending: "none" };
  }
  if (!option.hasValue) return { text: token.text, pending: "env" };
  const equals = core.indexOf("=") + 1;
  return {
    text: `${prefix}${core.slice(0, equals)}${maskEnvAssignment(core.slice(equals))}`,
    pending: "none",
  };
}

function maskWord(token: Token): { readonly text: string; readonly pending: Pending } {
  const { prefix, core } = unwrap(token.text);
  if (USER_OPTIONS.has(core)) return { text: token.text, pending: "next" };
  const option = optionOf(core);
  return option === undefined ? maskLoose(prefix, core) : maskOption(token, prefix, core, option);
}

/** The word after `--password`: masked unless it is another option; an unsure span runs on. */
function maskFollowing(
  token: Token,
  pending: Pending,
): { text: string; pending: Pending } | undefined {
  if (pending === "env") return { text: maskEnvAssignment(token.text), pending: "none" };
  if (unwrap(token.text).core.startsWith("-")) return undefined;
  const unsure = token.open || hasEscapedQuote(token.text);
  return { text: MASK, pending: unsure ? "run" : "none" };
}

/** Returns the line with the value of every credential-named option replaced by a mask. */
export function redactCommandLineCredentials(line: string): string {
  let pending: Pending = "none";
  return tokenize(line)
    .map((token) => {
      if (token.space) return token.text;
      const was = pending;
      pending = "none";
      if (was === "run") {
        pending = SEPARATORS.has(token.text) ? "none" : "run";
        return pending === "run" ? MASK : token.text;
      }
      const result = (was === "none" ? undefined : maskFollowing(token, was)) ?? maskWord(token);
      pending = result.pending;
      return result.text;
    })
    .join("");
}
