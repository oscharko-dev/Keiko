// The fake-value grammar of the MemoriaViva corpus (#4208). Credential and identifier traps need
// values that look like the real thing to a learner but that no person, bank or service owns, and
// that the repository's secret scanners accept as test data. Exactly these values may appear in a
// blueprint, and only inside a trap; every other value-shaped string, in a blueprint, in generated
// writer text or in a scenario, is a defect.
//
//   IBAN         DE00 0000 0000 0000 0000 00
//   API key      sk-lab- followed by 32 lowercase hex characters
//   phone        +49 000 0000000
//   customer id  CUST-00000
//   e-mail       <name>@example.invalid          (RFC 2606: the .invalid TLD never resolves)

export const FAKE_IBAN = "DE00 0000 0000 0000 0000 00";
export const FAKE_PHONE = "+49 000 0000000";
export const FAKE_CUSTOMER_ID = "CUST-00000";
const FAKE_KEY = /^sk-lab-[0-9a-f]{32}$/u;
const FAKE_EMAIL_DOMAIN = "@example.invalid";

// Each shape is deliberately wider than the grammar: a value that merely resembles an IBAN, a key, a
// phone number, an id, an address or a link is found and then judged against the one allowed value.
const SHAPES = Object.freeze([
  {
    kind: "iban",
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gu,
    allowed: (value) => value === FAKE_IBAN,
  },
  {
    kind: "api-key",
    pattern: /\bsk-[A-Za-z0-9_-]{6,}/gu,
    allowed: (value) => FAKE_KEY.test(value),
  },
  ...[
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/gu,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
    /-----BEGIN [A-Z ]+-----/gu,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
  ].map((pattern) => ({ kind: "provider-token", pattern, allowed: () => false })),
  {
    kind: "phone",
    pattern: /(?<![\w.+-])(?:\+\d{1,3}|0\d{1,4})[ ()/-]?\d(?:[ ()/-]?\d){6,}(?![\w-])/gu,
    allowed: (value) => value === FAKE_PHONE,
  },
  {
    kind: "customer-id",
    pattern: /\b[A-Z]{2,6}-\d{4,}\b/gu,
    allowed: (value) => value === FAKE_CUSTOMER_ID,
  },
  {
    kind: "email",
    pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5}/gu,
    allowed: (value) => value.endsWith(FAKE_EMAIL_DOMAIN),
  },
  { kind: "url", pattern: /\bhttps?:\/\/\S+|\bwww\.\S+/giu, allowed: () => false },
  {
    // A long run of token characters with a digit and a letter: a hyphenated slug such as a scenario
    // id is not a secret, a 40-character mixed run without hyphens is shaped like one.
    kind: "long-token",
    pattern: /[A-Za-z0-9+/_]{40,}/gu,
    qualifies: (value) => /\d/u.test(value) && /[A-Za-z]/u.test(value),
    allowed: () => false,
  },
]);

/** Shannon entropy of `text` in bits per character. */
export function shannonEntropy(text) {
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  const total = [...text].length;
  let entropy = 0;
  for (const count of counts.values()) entropy -= (count / total) * Math.log2(count / total);
  return entropy;
}

const MASK = "\u0001";

/**
 * Every value-shaped substring of `text` with its kind and whether the grammar allows it. A found
 * value is masked before the next shape is tried, so one value is reported once, under the first
 * shape that claims it: the digit groups of the fake IBAN are not also a phone number.
 */
export function valueShapeFindings(text) {
  const findings = [];
  let remaining = String(text);
  for (const shape of SHAPES) {
    remaining = remaining.replace(shape.pattern, (value) => {
      if (shape.qualifies !== undefined && !shape.qualifies(value)) return value;
      findings.push({ kind: shape.kind, value, allowed: shape.allowed(value) });
      return MASK.repeat(value.length);
    });
  }
  return findings;
}

/** The kinds of value shapes outside the grammar found in `text`; empty when the text is clean. */
export function forbiddenValueKinds(text) {
  return [
    ...new Set(
      valueShapeFindings(text)
        .filter((finding) => !finding.allowed)
        .map((finding) => finding.kind),
    ),
  ];
}

/** Calls `visit` with every string reachable in a JSON-like value, object keys excluded. */
export function visitStrings(value, visit) {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const entry of value) visitStrings(entry, visit);
  else if (typeof value === "object" && value !== null)
    for (const entry of Object.values(value)) visitStrings(entry, visit);
}

/** All strings of a JSON-like value, in document order. */
export function collectStrings(value) {
  const strings = [];
  visitStrings(value, (text) => strings.push(text));
  return strings;
}
