// Conservative, deterministic redaction of credential-shaped substrings in real conversation text
// (#4208). The pass is shape-based and best effort: it over-redacts on purpose and is not a
// guarantee, and the text it protects stays on the local machine regardless. Counts are kept so the
// conversion manifest can state how much was removed without ever quoting it.
//
// Every pattern is bounded (no unbounded nested quantifier), so the pass is linear in the text, and
// each stays small enough to read. Several patterns may share one counted kind, and a rule may
// carry an `accept` check that keeps a lookalike (a match without enough digits) unredacted.
//
// The kinds are the manifest's vocabulary and stay six: PEM private keys and `name=value` secrets
// count as `token`, credentials inside a URL (`scheme://user:secret@host`) as `bearer`.
const REDACTED = "[redacted]";
const MIN_IBAN_DIGITS = 8;

// A secret assigned to a name (`password=...`, `"api_key": "..."`, `token: ...`, `Passwort: ...`):
// the whole assignment goes, the value being a quoted string or a run of four or more characters.
// The name must start at a boundary, so `compass=north` is not a `pass` assignment.
const SECRET_ASSIGNMENT = new RegExp(
  [
    String.raw`(?<![A-Za-z0-9])`,
    String.raw`(?:pass(?:word|wd|wort|phrase)?|pwd|kennwort|secret|token|`,
    String.raw`(?:client|api|access|auth|refresh|private|session)[_-]?(?:secret|key|token))`,
    String.raw`["']?\s{0,3}[:=]\s{0,3}`,
    String.raw`(?:"[^"\r\n]{1,200}"|'[^'\r\n]{1,200}'|[^\s"'<>]{4,200})`,
  ].join(""),
  "giu",
);

// Order matters: a token is replaced before the generic hex and digit rules could eat part of it, a
// whole assignment before the token inside it is counted a second time, and URL credentials before
// the e-mail rule could take `secret@host` for an address.
const RULES = Object.freeze([
  // A PEM private key block, whole when its end marker follows, else its marker and the base64 lines.
  {
    kind: "token",
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,16384}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/gu,
  },
  {
    kind: "token",
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:\s{1,3}[A-Za-z0-9+/=]{16,200}){0,300}/gu,
  },
  // The user and password of `scheme://user:password@host`; the scheme and host stay readable.
  {
    kind: "bearer",
    pattern: /(?<=\b[a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/@:]{1,64}:[^\s/@]{1,128}(?=@)/giu,
  },
  { kind: "token", pattern: SECRET_ASSIGNMENT },
  // sk-/ghp_/xox-prefixed tokens and other well-known key shapes.
  { kind: "token", pattern: /\bsk-[A-Za-z0-9_-]{16,}/gu },
  { kind: "token", pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/gu },
  { kind: "token", pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/gu },
  { kind: "token", pattern: /\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/gu },
  // "Bearer <value>" / "Basic <value>" whose value is not a plain word, and JWT-shaped triples.
  {
    kind: "bearer",
    pattern: /\b(?:Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{16,}/giu,
  },
  { kind: "bearer", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu },
  {
    kind: "email",
    pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/gu,
  },
  // Country code, check digits, then up to 30 alphanumerics in groups of four (spaces optional). Two
  // short words after something like "HR12" have that shape too, so a match needs real digits.
  {
    kind: "iban",
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?\d{1,4})?\b/giu,
    accept: (match) => match.replaceAll(/\D/gu, "").length >= MIN_IBAN_DIGITS,
  },
  { kind: "hex", pattern: /\b[0-9a-f]{32,}\b/giu },
  // Nine or more digits with short separators: phone numbers and long identifiers.
  { kind: "phone", pattern: /(?<!\w)\+?\d(?:[\s()./-]{0,2}\d){8,}(?!\w)/gu },
]);

const KINDS = Object.freeze([...new Set(RULES.map((rule) => rule.kind))]);

/** A fresh counter object with a zero for every redaction kind. */
export function emptyRedactionCounts() {
  return Object.fromEntries(KINDS.map((kind) => [kind, 0]));
}

/** Adds `source` counts into `target` (in place) and returns `target`. */
export function addRedactionCounts(target, source) {
  for (const kind of KINDS) target[kind] += source[kind] ?? 0;
  return target;
}

/** Sum of every kind. */
export function totalRedactions(counts) {
  return KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
}

/** Returns the text with every credential-shaped substring replaced, and what was replaced. */
export function redactText(text) {
  const counts = emptyRedactionCounts();
  const redacted = RULES.reduce(
    (current, rule) =>
      current.replaceAll(rule.pattern, (match) => {
        if (rule.accept?.(match) === false) return match;
        counts[rule.kind] += 1;
        return REDACTED;
      }),
    String(text),
  );
  return { text: redacted, counts };
}
