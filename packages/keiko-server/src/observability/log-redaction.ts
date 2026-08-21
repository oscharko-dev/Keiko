// The single redaction choke point for the server activity log.
//
// Every field a caller supplies through `ServerLogEvent.extra` passes through `redactLogFields`
// before it is serialised. The policy is STRUCTURAL, not advisory: a caller cannot opt out, and
// the guards do not depend on the caller naming its fields honestly.
//
// Four independent layers, each of which alone stops a body/prompt/secret:
//
//  1. Type allowlist — only strings, finite numbers, booleans, arrays and plain objects survive.
//     Errors, Buffers, Maps, class instances, functions, symbols, bigints and null are dropped,
//     so an `extra: { error }` or `extra: { buffer }` can never serialise its payload.
//  2. Field-name denylist — names that mean "content" or "credential" in this product
//     (body, prompt, text, message, apiKey, token, authorization, email, …) are replaced with a
//     marker. Names are normalised (lowercased, separators stripped) so `api_key`, `api-key` and
//     `apiKey` are the same name. Neighbouring evidence fields that merely CONTAIN a denied word
//     (`promptTokens`, `strategyKey`, `requestBytes`, `probeName`) keep working — the match is on
//     the whole name, never a substring.
//  3. Value guards — a surviving string is refused if it is longer than a short cap, carries any
//     control character or newline, leaves printable ASCII (document text in any script), reads
//     as prose (more than a few spaces), looks like a credential (sk-…, Bearer …, JWT, AWS key,
//     PEM, credentialed URL, `password=…`, opaque high-entropy token), carries a personal
//     identifier (an email address, a phone number, a national id), or has the structure of a
//     filesystem path. Long strings are REPLACED, never truncated: a truncated prompt is still a
//     leaked prompt. The text-shape guard is the one that closes the hole a name-based rule
//     cannot — a SHORT body fragment under an innocuous field name the caller invented.
//  4. Shape caps — bounded nesting depth, bounded array length and a bounded field count, so a
//     deep or wide structure cannot be used to smuggle content past the other three layers.
//
// Hashed identifiers (documentIdHash, capsuleIdDigest, dbPathHash) are the evidence that REPLACES
// a raw value, so the opaque-token guard must not refuse them — refusing them would push callers
// back to logging the original. That now falls out of the guard's own rule rather than needing an
// exemption: a digest is written in one case of one alphabet, and the guard asks for the mixed
// lowercase/uppercase/digit alphabet a randomly generated credential has.
//
// An absolute path is not passed through under any exemption. A request path is reduced to its
// route TEMPLATE by `route-template.ts` — literal route segments survive, every other segment is
// digested — and everything else that starts at the filesystem root is refused.

import { redactRoutePath } from "./route-template.js";

// A log field value is an identifier, a code, a host or a status — never prose. 160 characters is
// far above every legitimate value in the instrumentation surface and far below any body.
export const MAX_LOG_STRING_LENGTH = 160;

// Log field values are identifiers, codes, hosts, reasons and statuses. None of them is prose, and
// none of them contains more than a stray space. Prose does. This is what stops a SHORT body or
// prompt fragment smuggled under an innocuous field name — the length cap alone would let it
// through, and no name-based rule can, since the caller picks the name.
export const MAX_LOG_STRING_WHITESPACE = 3;

// The upper bound of printable ASCII. A log field value is an identifier, a code, a host, an
// error kind or a status, and every one of those is written in ASCII. Document text is not.
const MAX_IDENTIFIER_CHAR_CODE = 0x7e;

// `extra` itself is depth 0. Its own values may nest three more levels, which covers the deepest
// existing producer (a diagnostic record carrying a nested counts object) and nothing beyond it.
export const MAX_LOG_FIELD_DEPTH = 3;

export const MAX_LOG_ARRAY_LENGTH = 16;

export const MAX_LOG_FIELD_COUNT = 48;

export const REDACTED_KEY = "[redacted:key]";
export const REDACTED_LENGTH = "[redacted:length]";
export const REDACTED_SHAPE = "[redacted:shape]";
export const REDACTED_SECRET = "[redacted:secret]";
export const REDACTED_PATH = "[redacted:path]";
export const REDACTED_PERSONAL = "[redacted:personal]";
export const DROPPED_DEPTH = "[dropped:depth]";

// The identity of a log line: timestamp, severity and routing. An `extra` field may never spoof
// one, because every operator query and every alert keys on them. The remaining envelope fields
// (correlationId, durationMs, status, errorKind) are NOT reserved — an instrumentation site
// naturally carries `durationMs` or `httpStatus` in its field list, and dropping those would be a
// silent footgun. The formatter simply applies the envelope after `extra`, so the envelope wins
// when both are present and `extra` fills the gap when it is not.
const RESERVED_FIELD_NAMES = new Set<string>(["ts", "level", "category", "op"]);

// Whole-name matches only, normalised to lowercase with `_` and `-` removed.
const DENIED_FIELD_NAMES = new Set<string>([
  // Content: anything that can carry a body, a prompt, model output or document text.
  "answer",
  "answers",
  "args",
  "argv",
  "body",
  "chunk",
  "chunks",
  "chunktext",
  "comment",
  "comments",
  "completion",
  "content",
  "contents",
  "data",
  "description",
  "doc",
  "document",
  "documents",
  "documenttext",
  "excerpt",
  "input",
  "inputs",
  "message",
  "messages",
  "msg",
  "note",
  "notes",
  "output",
  "outputs",
  "payload",
  "preview",
  "prompt",
  "prompts",
  "queries",
  "query",
  "querytext",
  "raw",
  "request",
  "response",
  "result",
  "results",
  "sample",
  "snippet",
  "snippets",
  "sql",
  "jql",
  "summary",
  "systemprompt",
  "text",
  "texts",
  "title",
  "userprompt",
  "value",
  "values",
  // Diagnostics that carry a foreign error message or a process transcript.
  "cause",
  "err",
  "error",
  "exception",
  "stack",
  "stacktrace",
  "stderr",
  "stdout",
  // Credentials and anything that authenticates.
  "accesstoken",
  "apikey",
  "apikeys",
  "auth",
  "authheader",
  "authorization",
  "bearer",
  "cert",
  "certificate",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "header",
  "headers",
  "idtoken",
  "key",
  "keys",
  "passphrase",
  "password",
  "privatekey",
  "publickey",
  "pwd",
  "salt",
  "refreshtoken",
  "secret",
  "secrets",
  "seed",
  "sessiontoken",
  "sig",
  "signature",
  "token",
  "tokens",
  // Filesystem and location strings, and process environment.
  "absolutepath",
  "connectionstring",
  "cwd",
  "dir",
  "directory",
  "dsn",
  "endpointurl",
  "env",
  "environment",
  "file",
  "filename",
  "filepath",
  "files",
  "homedir",
  "href",
  "location",
  "uri",
  "url",
  "urls",
  "workspacepath",
  // Direct personal data.
  "account",
  "accountid",
  "address",
  "email",
  "emails",
  "familyname",
  "fullname",
  "givenname",
  "mail",
  "phone",
  "phonenumber",
  "ssn",
  "user",
  "userid",
  "username",
  "users",
]);

// A field name is an identifier, not free text; anything else is dropped outright.
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

const SECRET_PATTERNS: readonly RegExp[] = [
  /^(?:sk|pk|rk|ak|sk-proj|sk-ant)-[a-z0-9_-]{8,}/i,
  /^(?:ghp|gho|ghu|ghs|ghr|github_pat)_/,
  /^xox[abprs]-/,
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\./,
  /^(?:bearer|basic|digest|token)\s+\S/i,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // A URL carrying userinfo credentials, e.g. https://user:pass@host/.
  /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:[^/@\s]*@/i,
  // A query string handing over a credential.
  /[?&](?:api[_-]?key|access[_-]?token|token|secret|password|sig|signature)=/i,
  // A credential written as `name=value` or `name: value` anywhere in the string.
  /\b(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd|authorization)\s*[=:]\s*\S/i,
];

// A serialised document announces itself in its first character. No log field value is ever a
// JSON object, a JSON array or a markup document, so this costs nothing legitimate and closes the
// compact-body route the prose guard cannot see (a minified JSON body has almost no spaces).
const STRUCTURED_PAYLOAD_PATTERN = /^\s*[[{<]/;

// A high-entropy credential and an ordinary long identifier are both long, and the rule this
// replaces could not tell them apart. It accepted any value that was 40+ characters drawn from
// `[A-Za-z0-9+/_=-]` — and `/` is in that alphabet, because base64 uses it. So EVERY request path
// of 40 characters or more, `/api/local-knowledge/capsules/cap-2f9c/sources/src-7c1a/root`
// included, was destroyed as `[redacted:secret]`, while a short customer-named route passed
// untouched: exactly backwards on both halves.
//
// The rule below describes what an opaque token IS, on two axes the old one conflated:
//
//   * it is ONE UNBROKEN RUN, not a path. `/` and `.` end a run, so a path is measured segment by
//     segment and no segment of a real route or a dotted identifier reaches the threshold.
//   * it is HIGH ENTROPY. A randomly generated 40-character base64 token contains lowercase,
//     uppercase and digits with overwhelming probability — missing any one class has probability
//     below 1e-3 — while a hex digest, a padded placeholder, a repeated character and a long
//     lowercase-and-hyphen slug each occupy a single case of a single alphabet.
//
// A run is scanned anywhere in the value, not just anchored at both ends, so a credential pasted
// into the middle of a longer field is caught where the anchored rule missed it.
export const OPAQUE_TOKEN_RUN_LENGTH = 40;
const OPAQUE_TOKEN_RUN_PATTERN = new RegExp(
  `[A-Za-z0-9+_=-]{${String(OPAQUE_TOKEN_RUN_LENGTH)},}`,
  "g",
);
const OPAQUE_TOKEN_ALPHABETS: readonly RegExp[] = [/[a-z]/, /[A-Z]/, /\d/];

// A personal identifier is not a credential and not prose, so neither of the guards above sees it:
// `contact: "jane.doe@example.com"` is short, space-free, ASCII and not credential-shaped. Only the
// field-name denylist stopped one, and a name-based rule is exactly what the value layer exists to
// backstop — the caller picks the name. These are the shapes that carry an identifiable person.
const PERSONAL_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  // An internationally formatted telephone number, ANYWHERE in the value. Anchoring this to the
  // whole string let `tel:+14155550142` through: the digit run is far below the opaque-token
  // length, so the secret guard does not see it either, and a phone number is exactly the kind of
  // personal identifier this layer is the backstop for.
  /(?:^|[^\d+])\+\d[\d ()./-]{6,}/,
  // A national identification number written in the common grouped form (e.g. a US SSN).
  /(?:^|[^\d-])\d{3}-\d{2}-\d{4}(?:[^\d-]|$)/,
];

// PATH DETECTION IS STRUCTURAL, AND DEFAULTS TO REFUSING.
//
// It used to be an allowlist of first segments (`/Users`, `/home`, `/var`, …), which answered only
// the paths someone had thought of: `/Volumes/External/customer.db`, `/data/keiko/state`, and every
// RELATIVE path (`../../etc/passwd`, `packages/keiko-server/src/store.ts`) serialised verbatim. The
// rules below describe what a path IS instead, and an absolute value is refused unless it is
// recognisably a web route — unknown now fails closed rather than open.
const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const HOME_PATH_PATTERN = /^~[/\\]/;
const FILE_URL_PATTERN = /^file:\/\//i;
// A backslash used as a separator between two segments; Windows paths that carry no drive letter.
const BACKSLASH_SEPARATOR_PATTERN = /^[^\\]+\\[^\\]/;
// An explicit relative marker, or a traversal segment anywhere in the value.
const RELATIVE_MARKER_PATTERN = /(?:^|[/\\])\.\.?(?:[/\\]|$)/;
// A separator whose final segment carries a file extension: `report.pdf`, `store.ts`,
// `index.sqlite3`. The extension must START with a letter so a versioned identifier that merely
// contains a dot (`openai/gpt-4.1`) is not mistaken for a file.
const EXTENSION_SEGMENT_PATTERN = /[/\\][^/\\]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
// A relative path of three or more segments. Two segments alone are left readable, because a media
// type (`text/plain`) and a namespaced identifier (`vendor/model`) have exactly that shape.
const DEEP_RELATIVE_PATH_PATTERN = /^[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+){2,}$/;

export function normalizeLogFieldName(name: string): string {
  return name.toLowerCase().replaceAll("_", "").replaceAll("-", "");
}

export function isDeniedLogFieldName(name: string): boolean {
  return DENIED_FIELD_NAMES.has(normalizeLogFieldName(name));
}

// Control characters are how a body announces itself: newlines, tabs, NUL. Latin prose announces
// itself with spaces. MOST OF THE WORLD'S PROSE ANNOUNCES ITSELF WITH NEITHER — Japanese, Chinese,
// Thai and Khmer separate nothing, and an HTML extractor routinely emits NBSP where a space
// belongs. Counting ASCII spaces therefore answered one script and passed a whole extracted
// document verbatim in every other, which is precisely the content this log must never carry.
//
// The guard is script-agnostic instead, and states the positive rule: a log field value is an
// ASCII identifier, code, host, error kind or status. A value that leaves printable ASCII is not
// one, whatever script it is written in; a value that stays inside it still gets the space budget,
// which is what catches short English body fragments. One bounded pass covers both, and it runs
// after the length cap so the scan is bounded by MAX_LOG_STRING_LENGTH.
function hasProseShape(value: string): boolean {
  let spaces = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code < 0x20 || code > MAX_IDENTIFIER_CHAR_CODE) return true;
    if (code === 0x20) {
      spaces += 1;
      if (spaces > MAX_LOG_STRING_WHITESPACE) return true;
    }
  }
  return false;
}

// A single run drawn from more than one alphabet. See OPAQUE_TOKEN_RUN_PATTERN for why both halves
// of this test are needed and what each one lets through on purpose.
function isHighEntropyRun(run: string): boolean {
  return OPAQUE_TOKEN_ALPHABETS.every((alphabet) => alphabet.test(run));
}

function hasOpaqueTokenRun(value: string): boolean {
  for (const match of value.matchAll(OPAQUE_TOKEN_RUN_PATTERN)) {
    if (isHighEntropyRun(match[0])) return true;
  }
  return false;
}

// Exported so the route-template reducer can refuse to digest a credential-shaped segment.
// A stable digest of a secret is worse than useless: it is an oracle that confirms a guess.
export function looksLikeSecret(value: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
  return hasOpaqueTokenRun(value);
}

// The email test is structural rather than a regular expression on purpose. Every regex form of
// it needs an unanchored run over a class that itself contains `.`, which the engine can match
// from many start positions — super-linear on adversarial input, in a guard whose whole job is to
// process values it does not trust. Scanning for `@` and validating its two sides is linear and
// has exactly one interpretation.
// Matches an email address anywhere in the value, with or without a `mailto:` scheme.
function containsEmailAddress(value: string): boolean {
  // EVERY `@`, not just the first. Checking only `indexOf("@")` fails OPEN: in
  // `"x@ jane@example.com"` the first `@` has no valid domain, the guard returned false, and the
  // real address behind it reached the log. A guard that gives up after one candidate is not a
  // guard. The scan stays linear — each position is visited at most twice.
  for (let at = value.indexOf("@"); at !== -1; at = value.indexOf("@", at + 1)) {
    // A candidate with no local part or no domain is SKIPPED, never terminal: `"@@ a@b.co"` ends
    // the scan at index 0 if the loop stops on the first unusable position.
    if (at === 0 || at === value.length - 1) continue;
    if (isLocalPartChar(value.charAt(at - 1)) && hasDottedDomain(value, at + 1)) return true;
  }
  return false;
}

function isAsciiAlphanumeric(char: string): boolean {
  return (
    (char >= "0" && char <= "9") || (char >= "a" && char <= "z") || (char >= "A" && char <= "Z")
  );
}

const LOCAL_PART_EXTRA_CHARS = "._%+-";

function isLocalPartChar(char: string): boolean {
  return isAsciiAlphanumeric(char) || LOCAL_PART_EXTRA_CHARS.includes(char);
}

function isDomainLabelChar(char: string): boolean {
  return isAsciiAlphanumeric(char) || char === "-";
}

// A domain: at least one label character, then a dot, then at least one more label character.
function hasDottedDomain(value: string, start: number): boolean {
  let labelChars = 0;
  let sawDot = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (isDomainLabelChar(char)) {
      labelChars += 1;
      if (sawDot) return true;
      continue;
    }
    if (char !== "." || labelChars === 0) return false;
    sawDot = true;
  }
  return false;
}

function looksLikePersonalIdentifier(value: string): boolean {
  if (containsEmailAddress(value)) return true;
  return PERSONAL_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(value));
}

function hasPathPrefix(value: string): boolean {
  return (
    HOME_PATH_PATTERN.test(value) ||
    WINDOWS_PATH_PATTERN.test(value) ||
    FILE_URL_PATTERN.test(value)
  );
}

function looksLikeFilesystemPath(value: string): boolean {
  if (hasPathPrefix(value)) return true;
  // A URL is not a filesystem path. The endpoint reducers each package owns have already reduced
  // the ones we log to scheme and host, and a credentialed one was refused by the secret guard two
  // checks earlier — without this, a portless host (`https://api.openai.com`) would read as a file
  // extension.
  if (URI_SCHEME_PATTERN.test(value)) return false;
  if (RELATIVE_MARKER_PATTERN.test(value) || BACKSLASH_SEPARATOR_PATTERN.test(value)) return true;
  // No exemption for an absolute value any more. A request path is not returned to the caller here
  // — `redactLogString` offers it to the route-template reducer, which keeps the declared literal
  // segments and digests everything else. Whatever that reducer declines is refused as a path.
  if (value.startsWith("/")) return true;
  return EXTENSION_SEGMENT_PATTERN.test(value) || DEEP_RELATIVE_PATH_PATTERN.test(value);
}

// The one place a string is judged. The length cap runs first so every later scan is bounded;
// the most specific verdict wins after that.
export function redactLogString(value: string): string {
  if (value.length > MAX_LOG_STRING_LENGTH) return REDACTED_LENGTH;
  if (looksLikeSecret(value)) return REDACTED_SECRET;
  if (looksLikePersonalIdentifier(value)) return REDACTED_PERSONAL;
  if (STRUCTURED_PAYLOAD_PATTERN.test(value)) return REDACTED_SHAPE;
  if (hasProseShape(value)) return REDACTED_SHAPE;
  // A path-shaped value gets exactly one chance to be something an operator may read: a request
  // path this server actually serves, reduced to its route template. Anything the reducer declines
  // — an unknown root, a traversal, a template that would not fit the string cap — is refused.
  if (looksLikeFilesystemPath(value)) {
    return redactRoutePath(value, MAX_LOG_STRING_LENGTH) ?? REDACTED_PATH;
  }
  return value;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

// Returns the sanitised value, or `undefined` when the value type is not on the allowlist and the
// field must be dropped entirely.
function redactLogValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactLogString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "object" || value === null) return undefined;
  if (depth <= 0) return DROPPED_DEPTH;
  if (Array.isArray(value)) return redactLogArray(value, depth - 1);
  if (!isPlainObject(value)) return undefined;
  return redactLogObject(value, depth - 1);
}

function redactLogArray(value: readonly unknown[], depth: number): unknown[] {
  const sanitized: unknown[] = [];
  for (const element of value.slice(0, MAX_LOG_ARRAY_LENGTH)) {
    const redacted = redactLogValue(element, depth);
    if (redacted !== undefined) sanitized.push(redacted);
  }
  return sanitized;
}

function redactLogObject(
  value: Readonly<Record<string, unknown>>,
  depth: number,
  reserved?: ReadonlySet<string>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  let accepted = 0;
  for (const [name, fieldValue] of Object.entries(value)) {
    if (accepted >= MAX_LOG_FIELD_COUNT) break;
    if (reserved?.has(name) === true) continue;
    if (!FIELD_NAME_PATTERN.test(name)) continue;
    accepted += 1;
    if (isDeniedLogFieldName(name)) {
      sanitized[name] = REDACTED_KEY;
      continue;
    }
    const redacted = redactLogValue(fieldValue, depth);
    if (redacted !== undefined) sanitized[name] = redacted;
  }
  return sanitized;
}

// Entry point. Anything that is not a plain object of fields yields no fields at all.
export function redactLogFields(extra: unknown): Record<string, unknown> | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  if (Array.isArray(extra) || !isPlainObject(extra)) return undefined;
  const sanitized = redactLogObject(extra, MAX_LOG_FIELD_DEPTH, RESERVED_FIELD_NAMES);
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

// Envelope fields are narrow by type but still caller-supplied strings, so they take the same
// string guard. Used by the line formatter for `op`, `correlationId` and `errorKind`.
export function redactLogLabel(value: string): string {
  return redactLogString(value);
}
