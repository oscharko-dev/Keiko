/** Shared body-free label privacy policy used by Activity Log and browser report producers. */
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

export function looksLikePersonalIdentifier(value: string): boolean {
  if (containsEmailAddress(value)) return true;
  return PERSONAL_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(value));
}
