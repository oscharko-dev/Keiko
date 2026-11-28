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
 * A name is split into segments on every non-alphanumeric run and on lower-to-upper boundaries
 * (`accessToken` is `access`, `token`), any case, and never judged on a substring. It is sensitive
 * when its LAST segment is a credential word (`--db-password`, `--apiKey`, `--auth-token`), or when
 * ANY segment is a strong secret word (password, secret, token, credential, api key) and the last
 * segment is not a known non-secret suffix: `--token-value` is masked, `--password-file` and
 * `--api-key-id` are not. Weak words (`pass`, `key`, `auth`, `cert`) only count as the last segment,
 * so `--pass-through`, `--keyword` and `--key-file` stay visible.
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
/** Words that name a secret anywhere in an option name (unless a non-secret suffix ends it). */
const STRONG_SEGMENTS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "secret",
  "token",
  "credential",
  "credentials",
  "apikey",
]);
/** A last segment that makes the name about something other than the secret itself. */
const NON_SECRET_SUFFIXES: ReadonlySet<string> = new Set([
  "file",
  "path",
  "dir",
  "id",
  "name",
  "type",
  "length",
  "count",
  "size",
  "url",
  "uri",
  "host",
  "port",
  "version",
  "format",
]);
const ENV_NAME = /^[A-Za-z_]\w*$/u;
const SEPARATOR_CHARS = ";|&";
const BEARER_VALUE = /(\b(?:bearer|basic)\s+)[^\s"']+/giu;
/** Options that always take a value, even one that starts with a hyphen. */
const REQUIRED_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-u",
  "--user",
  "--proxy-user",
  "--oauth2-bearer",
]);
const POWERSHELL_ENV = "$env:";

/** `required` masks the next word unconditionally; `next` skips a word that looks like an option. */
type Pending = "none" | "next" | "required" | "env" | "run" | "assign" | "value";

interface Token {
  readonly text: string;
  readonly space: boolean;
  /** A quote opened and never closed; the word then ends at the next whitespace. */
  readonly open: boolean;
  /** A run of statement separators (`;`, `&&`, `||`, `|`): never masked, ends a masked run. */
  readonly separator?: boolean;
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

function segmentsOf(name: string): readonly string[] {
  return stripQuotes(name)
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}

function namesApiKey(segments: readonly string[]): boolean {
  return segments.some((segment, index) => segment === "api" && segments[index + 1] === "key");
}

function isSensitiveName(name: string): boolean {
  const segments = segmentsOf(name);
  const last = segments.at(-1);
  if (last === undefined) return false;
  if (SENSITIVE_SEGMENTS.has(last)) return true;
  if (NON_SECRET_SUFFIXES.has(last)) return false;
  return segments.some((segment) => STRONG_SEGMENTS.has(segment)) || namesApiKey(segments);
}

function literalWordEnd(line: string, start: number): number {
  let index = start;
  while (index < line.length && !isSpace(line.charAt(index))) index += 1;
  return index;
}

function endsWord(char: string): boolean {
  return isSpace(char) || SEPARATOR_CHARS.includes(char);
}

/** The quote state after `char`: it opens a span, closes the span it opened, or is literal inside the other. */
function toggleQuote(quote: string | undefined, char: string): string | undefined {
  if (quote === undefined) return char;
  return quote === char ? undefined : quote;
}

/** The end of the word at `start`: a quote keeps its span, a backslash escapes outside single quotes. */
function scanWord(line: string, start: number): { readonly end: number; readonly open: boolean } {
  let index = start;
  let quote: string | undefined;
  while (index < line.length) {
    const char = line.charAt(index);
    if (quote === undefined && endsWord(char)) return { end: index, open: false };
    if (char === "\\" && quote !== "'") {
      index += 2;
      continue;
    }
    if (isQuote(char)) quote = toggleQuote(quote, char);
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
    const char = line.charAt(index);
    const space = isSpace(char);
    const separator = SEPARATOR_CHARS.includes(char);
    let end = index + 1;
    let open = false;
    if (space) {
      while (end < line.length && isSpace(line.charAt(end))) end += 1;
    } else if (separator) {
      while (end < line.length && SEPARATOR_CHARS.includes(line.charAt(end))) end += 1;
    } else {
      ({ end, open } = scanWord(line, index));
    }
    tokens.push({ text: line.slice(index, end), space, open, ...(separator ? { separator } : {}) });
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
  /** PowerShell `$env:NAME`, which may be assigned with spaces around `=`. */
  readonly powershell: boolean;
}

function optionLead(core: string, double: boolean, powershell: boolean): number {
  if (powershell) return POWERSHELL_ENV.length;
  return double || core.startsWith("-D") ? 2 : 0;
}

/** The option of `--name[=v]`, `-Dname[=v]`, `$env:NAME[=v]` or `NAME=v`, or undefined. */
function optionOf(core: string): Option | undefined {
  const lower = core.slice(0, POWERSHELL_ENV.length).toLowerCase();
  const double = core.startsWith("--");
  const powershell = lower === POWERSHELL_ENV;
  const lead = optionLead(core, double, powershell);
  const body = core.slice(lead);
  const equals = body.indexOf("=");
  if (equals < 0)
    return lead > 0 && body.length > 0
      ? { name: body, hasValue: false, spaced: double, powershell }
      : undefined;
  const name = body.slice(0, equals);
  return lead > 0 || ENV_NAME.test(name)
    ? { name, hasValue: true, spaced: double, powershell }
    : undefined;
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
    if (isQuote(char)) open = toggleQuote(open, char);
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
  // `Bearer abc` / `Basic abc`, alone or inside a quoted header value; a bare scheme word masks
  // the word after it.
  const bare = ["bearer", "basic"].includes(core.toLowerCase());
  const scheme = core.replace(BEARER_VALUE, `$1${MASK}`);
  return { text: `${prefix}${maskUserinfo(scheme)}`, pending: bare ? "next" : "none" };
}

function emptyValue(word: string): boolean {
  return word.endsWith("=");
}

function maskSensitive(token: Token, option: Option): { text: string; pending: Pending } {
  if (!option.hasValue) {
    const spaced: Pending = option.spaced ? "next" : "none";
    return { text: token.text, pending: option.powershell ? "assign" : spaced };
  }
  if (token.open || hasEscapedQuote(token.text)) {
    return { text: maskValue(token.text), pending: "run" };
  }
  // `$env:NAME= "v"`: PowerShell takes the value from the next word.
  const waits = option.powershell && emptyValue(token.text);
  return { text: maskValue(token.text), pending: waits ? "value" : "none" };
}

function maskOption(
  token: Token,
  prefix: string,
  core: string,
  option: Option,
): { text: string; pending: Pending } {
  if (isSensitiveName(option.name)) return maskSensitive(token, option);
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
  if (REQUIRED_VALUE_OPTIONS.has(core)) return { text: token.text, pending: "required" };
  const option = optionOf(core);
  return option === undefined ? maskLoose(prefix, core) : maskOption(token, prefix, core, option);
}

/** The word after `--password`: masked unless it is another option; an unsure span runs on. */
function maskFollowing(
  token: Token,
  pending: Pending,
): { text: string; pending: Pending } | undefined {
  if (pending === "run") return { text: MASK, pending: "run" };
  if (pending === "env") return { text: maskEnvAssignment(token.text), pending: "none" };
  if (pending === "assign") return maskAssignment(token);
  if (pending === "next" && unwrap(token.text).core.startsWith("-")) return undefined;
  const unsure = token.open || hasEscapedQuote(token.text);
  return { text: MASK, pending: unsure ? "run" : "none" };
}

/** After `$env:NAME`: an `=` word (or `=value`) is the assignment, anything else is not. */
function maskAssignment(token: Token): { text: string; pending: Pending } | undefined {
  if (token.text === "=") return { text: token.text, pending: "value" };
  if (!token.text.startsWith("=")) return undefined;
  const unsure = token.open || hasEscapedQuote(token.text);
  return { text: `=${MASK}`, pending: unsure ? "run" : "none" };
}

/** Returns the line with the value of every credential-named option replaced by a mask. */
export function redactCommandLineCredentials(line: string): string {
  let pending: Pending = "none";
  return tokenize(line)
    .map((token) => {
      if (token.space || token.separator === true) {
        // A statement separator ends every masked run and is never masked itself.
        if (token.separator === true) pending = "none";
        return token.text;
      }
      const was = pending;
      pending = "none";
      const result = (was === "none" ? undefined : maskFollowing(token, was)) ?? maskWord(token);
      pending = result.pending;
      return result.text;
    })
    .join("");
}
