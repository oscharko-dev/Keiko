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
  // A bank account of any country, compact or grouped (IBAN).
  /(?:^|[^A-Za-z0-9])[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}(?:[^A-Za-z0-9]|$)/,
  // The same written lowercase, at the German length. Other countries are recognised by their
  // checksum in `containsLowercaseIban`: two letters and two digits also start a short hex digest.
  /(?:^|[^a-z0-9])de\d{20}(?:[^a-z0-9]|$)/,
  // A run of seven to nineteen digits, compact or grouped: a telephone number without its country
  // code, a card or account number, a tax id, a date of birth written year first. A longer run is
  // no number a person holds; it is a digest. A run that continues an identifier (`corr-root-00000001`)
  // is that identifier's own counter.
  /(?:^|[^\dA-Za-z._-])\d(?:[ /-]?\d){6,18}(?:[^\dA-Za-z_]|$)/,
  // A telephone number inside an identifier: announced by its name (`tel-491711234567`), or in the
  // national form (`contact_01711234567`): a mobile prefix or an area code. A counter or a fixture id
  // counts from zero (`corr-0123456789`).
  /(?:^|[^a-z])(?:tel|telefon|phone|mobil|mobile|handy|fax)[-_.:=]?\+?\d[\d ()./-]{5,}/i,
  /[-_.]0(?:1[5-7]|[2-9])\d{7,12}(?:[^\dA-Za-z_]|$)/,
  // A date with a four-digit year, as a birth date is written in a form or a contract.
  /(?:^|[^\d.])\d{1,2}[./]\d{1,2}[./](?:19|20)\d{2}(?:[^\d.]|$)/,
  // An IPv4 address, which identifies a person's machine.
  /(?:^|[^\d.])\d{1,3}(?:\.\d{1,3}){3}(?:[^\d.]|$)/,
  // A single capitalised word, which is how a surname stands alone (`Aydogan`, `Hans-Peter`).
  /^[A-Z][a-z]+(?:-[A-Z][a-z]+)?$/,
];

// Machine shapes that legitimately hold digit runs and are never personal: they are taken out of
// the value before the personal shapes are judged, and only the whole shape counts.
const NON_PERSONAL_DIGIT_SHAPES: readonly RegExp[] = [
  // A UUID.
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  // An instant with its time of day. A bare date stays personal: it may be a date of birth.
  // Its offset stays behind and holds no run a personal shape reads.
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?/g,
  // The loopback and unspecified addresses a local server binds. They identify no one's machine.
  /\b(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0)\b/g,
  // A measurement by its name (`responseBudgetBytes=114819072`). A name that says what the number
  // measures leaves no room for an account or a telephone number.
  /\b[A-Za-z]+(?:Bytes|Ms|Count|Tokens)=\d+\b/g,
];

// The name of the base error class is the one capitalised word a log line carries by design.
const NON_PERSONAL_WORDS: ReadonlySet<string> = new Set(["Error"]);

const LOWERCASE_IBAN = /(?:^|[^a-z0-9])([a-z]{2}\d{2}[a-z0-9]{11,30})(?![a-z0-9])/g;

// ISO 7064 mod 97-10, the check every IBAN carries: the first four characters move to the end,
// letters count as 10 to 35, and the number leaves a remainder of 1.
function ibanChecksumHolds(iban: string): boolean {
  let remainder = 0;
  for (const char of iban.slice(4) + iban.slice(0, 4)) {
    const digit = Number.parseInt(char, 36);
    remainder = (remainder * (digit < 10 ? 10 : 100) + digit) % 97;
  }
  return remainder === 1;
}

// The length ISO 13616 fixes per country, with the countries that use the form outside the registry.
// One random value in 97 passes the checksum, so a generated hex id would read as an IBAN without it.
const IBAN_COUNTRIES_BY_LENGTH: readonly (readonly [number, string])[] = [
  [15, "no"],
  [16, "be"],
  [18, "dk fi fk fo gl nl sd"],
  [19, "mk si"],
  [20, "at ba ee kz lt lu mn xk"],
  [21, "ch hr li lv"],
  [22, "bg bh cr de gb ge ie me rs va"],
  [23, "ae gi il iq om so tl"],
  [24, "ad cz es md pk ro sa se sk tn vg"],
  [25, "ao cv ly mz pt st"],
  [26, "dz ir is tr"],
  [27, "bi cm dj fr ga gr it mc mg mr sm"],
  [28, "al az bf bj by ci cy do gt hn hu lb ml ni pl sn sv"],
  [29, "br eg ps qa ua"],
  [30, "jo kw mu ye"],
  [31, "mt sc"],
  [32, "lc"],
  [33, "ru"],
];

const IBAN_LENGTHS: ReadonlyMap<string, number> = new Map(
  IBAN_COUNTRIES_BY_LENGTH.flatMap(([length, countries]) =>
    countries.split(" ").map((country) => [country, length] as const),
  ),
);

function isLowercaseIban(candidate: string): boolean {
  return (
    IBAN_LENGTHS.get(candidate.slice(0, 2)) === candidate.length && ibanChecksumHolds(candidate)
  );
}

// A URL names a machine and often its owner (`https://jane.doe.example`). Only a local one is
// nobody's.
const URL_START = /(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\//gi;
const LOCAL_URL_AUTHORITY = /^(?:localhost|127\.\d|0\.0\.0\.0|\[::1\])(?:[:/?#]|$)/i;
// Longer than any local authority above; what follows does not change the answer.
const URL_AUTHORITY_WINDOW = 32;

function containsRemoteUrl(value: string): boolean {
  for (const match of value.matchAll(URL_START)) {
    const start = match.index + match[0].length;
    const authority = value.slice(start, start + URL_AUTHORITY_WINDOW);
    if (/^[^\s/:]/.test(authority) && !LOCAL_URL_AUTHORITY.test(authority)) return true;
  }
  return false;
}

function containsLowercaseIban(value: string): boolean {
  for (const match of value.matchAll(LOWERCASE_IBAN)) {
    if (isLowercaseIban(match[1] ?? "")) return true;
  }
  return false;
}

function withoutNonPersonalDigitShapes(value: string): string {
  return NON_PERSONAL_DIGIT_SHAPES.reduce((text, shape) => text.replace(shape, ""), value);
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

export function looksLikePersonalIdentifier(value: string): boolean {
  if (containsEmailAddress(value)) return true;
  if (NON_PERSONAL_WORDS.has(value)) return false;
  const judged = withoutNonPersonalDigitShapes(value);
  return (
    containsLowercaseIban(judged) ||
    containsRemoteUrl(judged) ||
    PERSONAL_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(judged))
  );
}
