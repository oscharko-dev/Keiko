// Narrow ambient extractors for natural-chat identity statements.
//
// These patterns intentionally cover only high-precision self-identification phrases such as
// "my name is Paul" or "Hallo Keiko, ich bin Paul". They still emit `proposed` candidates, so
// governance remains unchanged: nothing is auto-accepted, but common identity facts no longer
// depend on a model-side salience pass to become reviewable.

import type { MemoryScope } from "@oscharko-dev/keiko-contracts/memory";

import { buildProposal } from "./_envelopes.js";
import { applyPolicy } from "./policy.js";
import { scanForSecrets } from "./secret-patterns.js";
import type { CaptureContext, CaptureOutcome, CapturePolicyOptions } from "./types.js";

const IDENTITY_CAPTURE_RATIONALE = "Automatically inferred from conversation (identity statement)";
const MAX_NAME_TOKENS = 4;
const NAME_TOKEN_RE = /^\p{L}[\p{L}'’.-]*$/u;
// Trailing whitespace/punctuation used to be stripped inline by the identity regexes via a
// `\s*[.!?]*$` tail. That chained two unbounded, overlapping-character-class quantifiers right
// next to the capturing group ahead of them (`.`/`[\s\S]` both include whitespace and `.!?`),
// which is super-linear to backtrack on adversarial input (S8786). Stripping is now done with
// plain string scans instead, so the regexes only ever have a single unbounded atom in their tail.
const IDENTITY_TRAILING_PUNCTUATION = new Set([".", "!", "?"]);

function stripTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && IDENTITY_TRAILING_PUNCTUATION.has(value.charAt(end - 1))) {
    end -= 1;
  }
  return value.slice(0, end);
}

function stripTrailingWhitespace(value: string): string {
  let end = value.length;
  while (end > 0 && /\s/u.test(value.charAt(end - 1))) {
    end -= 1;
  }
  return value.slice(0, end);
}

// Mirrors the old inline `\s*[.!?]*$` tail: strip a trailing punctuation run, then a trailing
// whitespace run, from the raw capture (in that order, matching the original match semantics).
function stripIdentityCaptureTail(rawCapture: string): string {
  return stripTrailingWhitespace(stripTrailingPunctuation(rawCapture));
}

// The identity regexes below intentionally match ONLY the fixed-alternation prefix ("my name
// is", "ich bin", …) and stop — no capture group, no `$`. The name itself is never extracted by
// regex backtracking; it is sliced out manually below. This is what the original `.`-based
// capture ("cannot cross a line terminator") structurally guaranteed, and what a bare `[\s\S]+`
// capture would silently give up: without this split, a two-line chat message like "my name is
// Sarah\nNice to chat" would merge the unrelated second line into the captured name instead of
// failing to match, the way the original single-line-only regex did.
const STRONG_IDENTITY_PREFIX_RE =
  /^(?:my\s+name\s+is|call\s+me|ich\s+hei(?:ß|ss)e|mein\s+name\s+ist)\s+/iu;
const WEAK_IDENTITY_PREFIX_RE = /^(?:i\s+am|i(?:'|’)m|ich\s+bin)\s+/iu;
const GREETING_WORDS = ["hello", "hi", "hey", "hallo"];
const GREETING_PUNCTUATION = new Set([",", "!", ".", "-", ":"]);

function greetingWordLength(lowerText: string): number {
  for (const word of GREETING_WORDS) {
    if (lowerText.startsWith(word)) {
      return word.length;
    }
  }
  return 0;
}

function skipWhitespaceRun(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/u.test(text.charAt(index))) {
    index += 1;
  }
  return index;
}

// Consumes an optional "hello keiko, " (or hi/hey/hallo, one optional punctuation char,
// surrounding whitespace) greeting prefix, returning the index right after it (0 if no greeting
// is present). The original regex spelled this as `\s+keiko\s*[,!.\-:]?\s*` inside an outer
// optional group: two `\s`-matching quantifiers sitting on either side of an optional
// possibly-empty character class, which is the overlapping-adjacent-quantifier shape S8786
// flags — confirmed empirically quadratic (a "hello keiko" + N spaces body that never completes
// the match went from ~80ms at 10k spaces to ~4.4s at 80k, a clean ~4x-per-doubling curve). This
// scans the identical shape once, left to right, with no backtracking possible.
function skipGreetingPrefix(text: string): number {
  const lower = text.toLowerCase();
  const wordLength = greetingWordLength(lower);
  if (wordLength === 0 || !/\s/u.test(text.charAt(wordLength))) {
    return 0;
  }
  const afterGreetingWord = skipWhitespaceRun(text, wordLength);
  if (!lower.startsWith("keiko", afterGreetingWord)) {
    return 0;
  }
  let index = afterGreetingWord + "keiko".length;
  index = skipWhitespaceRun(text, index);
  if (GREETING_PUNCTUATION.has(text.charAt(index))) {
    index += 1;
  }
  return skipWhitespaceRun(text, index);
}
// JS `.` (no `s`/dotAll flag) stops at any of these four LineTerminator code points, not just
// `\n` (ECMA-262 LineTerminator = LF | CR | LS | PS). A plain `indexOf("\n")` would therefore be
// narrower than the original's line boundary; this class matches it exactly. It carries no
// quantifier, so `String#search` with it is a single linear scan — no backtracking is possible.
const LINE_TERMINATOR_RE = /[\n\r\u2028\u2029]/u;
// Whatever follows an embedded line break must be pure filler (blank lines / trailing
// punctuation) for the match to still count — anything else is ordinary further chat content,
// which the original regex could never reach past its embedded-`.`-stopping capture. The
// original tail was `\s*[.!?]*$`: an order-sensitive whitespace run followed by a punctuation
// run. A same-class `[\s.!?]*` bag-of-characters check is not equivalent — it also accepts
// punctuation *before* trailing whitespace (e.g. "!\n " after the name), which the original
// rejected. `isPureTrailingFiller` reproduces the exact two-phase order with no regex at all, so
// there is nothing left to backtrack on either way.
function isPureTrailingFiller(text: string): boolean {
  let index = 0;
  while (index < text.length && /\s/u.test(text.charAt(index))) index += 1;
  while (index < text.length && ".!?".includes(text.charAt(index))) index += 1;
  return index === text.length;
}
const DISALLOWED_NAME_TOKENS = new Set([
  "and",
  "are",
  "as",
  "at",
  "aus",
  "based",
  "bin",
  "building",
  "for",
  "from",
  "here",
  "in",
  "ist",
  "mit",
  "on",
  "the",
  "und",
  "using",
  "with",
  "working",
]);

function userScope(context: CaptureContext): MemoryScope {
  return { kind: "user", userId: context.userId };
}

function normalizeCandidateName(raw: string): string | null {
  const trimmed = stripTrailingPunctuation(raw.trim());
  if (trimmed.length === 0) {
    return null;
  }
  const tokens = trimmed.split(/\s+/u);
  if (tokens.length === 0 || tokens.length > MAX_NAME_TOKENS) {
    return null;
  }
  const normalized: string[] = [];
  for (const token of tokens) {
    if (!NAME_TOKEN_RE.test(token)) {
      return null;
    }
    if (DISALLOWED_NAME_TOKENS.has(token.toLowerCase())) {
      return null;
    }
    normalized.push(token);
  }
  return normalized.join(" ");
}

function isStrictIdentityName(name: string): boolean {
  return name.split(/\s+/u).every((token) => /^\p{Lu}/u.test(token));
}

function buildIdentityCandidate(
  name: string,
  context: CaptureContext,
  policy: CapturePolicyOptions,
): CaptureOutcome {
  const body = `The user's name is ${name}.`;
  const rejection = scanForSecrets(body, policy.customerIdentifierMatchers ?? []);
  if (rejection !== null) {
    return { kind: "rejected", reason: rejection };
  }
  const decision = applyPolicy(body, {
    ...(policy.defaultSensitivity !== undefined && {
      defaultSensitivity: policy.defaultSensitivity,
    }),
  });
  const proposal = buildProposal(
    {
      context,
      scope: userScope(context),
      body,
      type: "semantic-fact",
      sensitivity: decision.sensitivity,
      sourceKind: "system-default",
      captureRationale: IDENTITY_CAPTURE_RATIONALE,
    },
    0.9,
  );
  return { kind: "candidate", proposal, requiresApproval: decision.requiresApproval };
}

function extractIdentityName(text: string, requireStrictName: boolean): string | null {
  const prefixRe = requireStrictName ? WEAK_IDENTITY_PREFIX_RE : STRONG_IDENTITY_PREFIX_RE;
  const afterGreeting = text.slice(skipGreetingPrefix(text));
  const prefixMatch = prefixRe.exec(afterGreeting);
  if (prefixMatch === null) {
    return null;
  }
  const rest = afterGreeting.slice(prefixMatch[0].length);
  const terminatorIndex = rest.search(LINE_TERMINATOR_RE);
  const firstLine = terminatorIndex === -1 ? rest : rest.slice(0, terminatorIndex);
  const remainder = terminatorIndex === -1 ? "" : rest.slice(terminatorIndex);
  // Anything after the first line break must be pure filler; real further content (a second
  // chat line, another sentence, …) means this was never a single-line identity statement.
  if (remainder.length > 0 && !isPureTrailingFiller(remainder)) {
    return null;
  }
  const name = normalizeCandidateName(stripIdentityCaptureTail(firstLine));
  if (name === null) {
    return null;
  }
  if (requireStrictName && !isStrictIdentityName(name)) {
    return null;
  }
  return name;
}

export function tryExtractAmbientIdentity(
  text: string,
  context: CaptureContext,
  policy: CapturePolicyOptions = {},
): CaptureOutcome | null {
  const strongName = extractIdentityName(text, false);
  if (strongName !== null) {
    return buildIdentityCandidate(strongName, context, policy);
  }
  const weakName = extractIdentityName(text, true);
  if (weakName !== null) {
    return buildIdentityCandidate(weakName, context, policy);
  }
  return null;
}
