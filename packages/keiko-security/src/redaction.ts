// Secret redaction at the boundary. Every provider-derived string passes through
// redact() before it can reach an error message, log call, or serialised artefact.
//
// ReDoS-safe by construction: built-in regexes are linear character classes without nested
// quantifiers, and multiline PEM blocks use the explicit linear scanner below. Caller-supplied
// literals are escaped before RegExp construction, so no caller-controlled metacharacter reaches
// the regex engine. This keeps the CodeQL js/polynomial-redos gate green (ADR-0002).

import type { AuditRedactionConfig } from "@oscharko-dev/keiko-contracts";

import {
  isCredentialKeyName as isCredentialKeyNameShared,
  redactCredentialSpans,
} from "./credential-spans.js";
import { redactLiteralUnion } from "./literal-redaction.js";

const REDACTED = "[REDACTED]";

// OpenAI-style keys (sk-, sk-proj-, etc.): a prefix followed by >= 16 secret chars.
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}/g;

// Common third-party credential shapes. Each is a single linear character class with one
// bounded/open quantifier (no nesting), so none can backtrack catastrophically — this keeps
// CodeQL js/polynomial-redos satisfied while scrubbing non-OpenAI secrets from tool output.
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}/g;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}/g;
const GOOGLE_API_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{20,}/g;
const STRIPE_KEY_PATTERN = /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const LONG_DIGIT_PATTERN = /\b\d{13,19}\b/g;
const PEM_BEGIN_PREFIX = "-----BEGIN ";
const PEM_END_PREFIX = "-----END ";
const PEM_MARKER_SUFFIX = "PRIVATE KEY-----";
const GERMAN_IBAN_PATTERN = /\bDE\d{2}(?:[ ]?\d{4}){4}[ ]?\d{2}\b/gi;
const GERMAN_PHONE_PATTERN =
  /(?<![0-9A-F-])(?:\+49|0049)(?:[ ./-]?\d){7,13}\b(?!-[0-9A-F])|(?<![0-9A-F-])0\d{1,4}[ ./-]\d(?:[ ./-]?\d){4,11}\b(?!-[0-9A-F])/gi;
const BUILTIN_PATTERNS: readonly RegExp[] = [
  GITHUB_TOKEN_PATTERN,
  AWS_ACCESS_KEY_PATTERN,
  SLACK_TOKEN_PATTERN,
  GOOGLE_API_KEY_PATTERN,
  STRIPE_KEY_PATTERN,
];

export const SHARED_REDACTION_RULE_CODES = [
  "authorization-secret",
  "credential-assignment",
  "url-userinfo",
  "personal-identifier",
  "credential-shape",
  "configured-literal",
] as const;
export type SharedRedactionRuleCode = (typeof SHARED_REDACTION_RULE_CODES)[number];

export interface SharedRedactionRuleCount {
  readonly code: SharedRedactionRuleCode;
  readonly count: number;
}

export interface SharedRedactionResult {
  readonly value: string;
  readonly rules: readonly SharedRedactionRuleCount[];
}

type MutableRuleCounts = Partial<Record<SharedRedactionRuleCode, number>>;

function addRuleCount(
  counts: MutableRuleCounts,
  code: SharedRedactionRuleCode,
  count: number,
): void {
  if (count > 0) counts[code] = (counts[code] ?? 0) + count;
}

function replaceTracked(
  input: string,
  pattern: RegExp,
  replacement: string,
  code: SharedRedactionRuleCode,
  counts: MutableRuleCounts,
): string {
  pattern.lastIndex = 0;
  const count = input.match(pattern)?.length ?? 0;
  pattern.lastIndex = 0;
  addRuleCount(counts, code, count);
  if (count === 0) return input;
  const output = input.replace(pattern, replacement);
  pattern.lastIndex = 0;
  return output;
}

interface PemMarker {
  readonly start: number;
  readonly end: number;
}

function pemMarkerEnd(input: string, start: number, prefix: string): number | undefined {
  let cursor = start + prefix.length;
  while (cursor < input.length) {
    if (input.startsWith(PEM_MARKER_SUFFIX, cursor)) {
      return cursor + PEM_MARKER_SUFFIX.length;
    }
    const code = input.charCodeAt(cursor);
    if (code !== 0x20 && (code < 0x41 || code > 0x5a)) return undefined;
    cursor += 1;
  }
  return undefined;
}

function findPemMarker(input: string, prefix: string, from: number): PemMarker | undefined {
  let cursor = from;
  while (cursor < input.length) {
    const start = input.indexOf(prefix, cursor);
    if (start < 0) return undefined;
    const end = pemMarkerEnd(input, start, prefix);
    if (end !== undefined) return { start, end };
    cursor = start + prefix.length;
  }
  return undefined;
}

function replacePemPrivateKeyBlocks(input: string, counts: MutableRuleCounts): string {
  const parts: string[] = [];
  let copyFrom = 0;
  let searchFrom = 0;
  let count = 0;
  while (searchFrom < input.length) {
    const begin = findPemMarker(input, PEM_BEGIN_PREFIX, searchFrom);
    if (begin === undefined) break;
    const end = findPemMarker(input, PEM_END_PREFIX, begin.end);
    if (end === undefined) {
      parts.push(input.slice(copyFrom, begin.start), REDACTED);
      copyFrom = input.length;
      count += 1;
      break;
    }
    parts.push(input.slice(copyFrom, begin.start), REDACTED);
    copyFrom = end.end;
    searchFrom = end.end;
    count += 1;
  }
  if (count === 0) return input;
  parts.push(input.slice(copyFrom));
  addRuleCount(counts, "credential-shape", count);
  return parts.join("");
}

function trackCredentialAssignments(input: string, counts: MutableRuleCounts): string {
  const output = replacePemPrivateKeyBlocks(input, counts);
  const credentials = redactCredentialSpans(output);
  for (const rule of credentials.rules) addRuleCount(counts, rule.code, rule.count);
  return credentials.value;
}

function trackSensitiveValues(input: string, counts: MutableRuleCounts): string {
  let output = input;
  output = replaceTracked(output, GERMAN_IBAN_PATTERN, REDACTED, "personal-identifier", counts);
  output = replaceTracked(output, GERMAN_PHONE_PATTERN, REDACTED, "personal-identifier", counts);
  output = replaceTracked(output, API_KEY_PATTERN, REDACTED, "credential-shape", counts);
  output = replaceTracked(output, JWT_PATTERN, REDACTED, "credential-shape", counts);
  output = replaceTracked(output, LONG_DIGIT_PATTERN, REDACTED, "credential-shape", counts);
  for (const pattern of BUILTIN_PATTERNS) {
    output = replaceTracked(output, pattern, REDACTED, "credential-shape", counts);
  }
  return output;
}

function trackedRules(input: string, counts: MutableRuleCounts): string {
  return trackSensitiveValues(trackCredentialAssignments(input, counts), counts);
}

function trackNonCredentialRules(input: string, counts: MutableRuleCounts): string {
  return trackSensitiveValues(replacePemPrivateKeyBlocks(input, counts), counts);
}

export function isCredentialKeyName(value: string): boolean {
  return isCredentialKeyNameShared(value);
}

export function objectContainsCredentialKey(value: unknown, seen = new WeakSet()): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => objectContainsCredentialKey(entry, seen));
  }
  for (const [key, entry] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    if (isCredentialKeyName(key)) return true;
    if (objectContainsCredentialKey(entry, seen)) return true;
  }
  return false;
}

// Strips known secret shapes and any caller-supplied literal secrets from `input`.
// `additionalSecrets` lets the caller pass exact apiKey/baseUrl/env values it holds
// so even non-standard key formats are scrubbed.
export function redact(input: string, additionalSecrets: readonly string[] = []): string {
  return redactWithRuleCounts(input, additionalSecrets).value;
}

export function redactWithRuleCounts(
  input: string,
  additionalSecrets: readonly string[] = [],
): SharedRedactionResult {
  const counts: MutableRuleCounts = {};
  const output = redactLiteralUnion(trackedRules(input, counts), additionalSecrets);
  addRuleCount(counts, "configured-literal", output.count);
  return {
    value: output.value,
    rules: SHARED_REDACTION_RULE_CODES.flatMap((code) =>
      counts[code] === undefined ? [] : [{ code, count: counts[code] }],
    ),
  };
}

export function redactNonCredentialWithRuleCounts(
  input: string,
  additionalSecrets: readonly string[] = [],
): SharedRedactionResult {
  const counts: MutableRuleCounts = {};
  const output = redactLiteralUnion(trackNonCredentialRules(input, counts), additionalSecrets);
  addRuleCount(counts, "configured-literal", output.count);
  return {
    value: output.value,
    rules: SHARED_REDACTION_RULE_CODES.flatMap((code) =>
      counts[code] === undefined ? [] : [{ code, count: counts[code] }],
    ),
  };
}

// A literal shorter than this is too generic to scrub safely: redacting a 2-char value would
// over-redact ordinary prose. redact() itself only skips empty strings, so the floor lives here.
const MIN_LITERAL_LENGTH = 4;

// Resolves the VALUES of the named env vars (never the names), keeping only non-empty values long
// enough to be a plausible secret. The builder passes these as escaped literals to redact().
function resolveEnvValues(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const values: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length >= MIN_LITERAL_LENGTH) {
      values.push(value);
    }
  }
  return values;
}

function keepLongEnough(literals: readonly string[]): readonly string[] {
  return literals.filter((literal) => literal.length >= MIN_LITERAL_LENGTH);
}

// Returns a function string -> string applying redact() with the union of all literal secrets
// (additionalSecrets ∪ resolved env values ∪ sensitiveLiterals). Idempotent: redact() over already-
// redacted text is a no-op on the redacted tokens (ADR-0010 D3 audit-redaction layer).
export function createAuditRedactor(
  config: AuditRedactionConfig,
  env: Readonly<Record<string, string | undefined>>,
): (input: string) => string {
  const literals = [
    ...keepLongEnough(config.additionalSecrets ?? []),
    ...resolveEnvValues(config.redactEnvValues ?? [], env),
    ...keepLongEnough(config.sensitiveLiterals ?? []),
  ];
  return (input: string): string => redact(input, literals);
}

// Recursively re-applies a redactor to EVERY STRING LEAF of a plain-JSON value, rebuilding
// arrays/objects so the input is never mutated and the JSON structure is preserved exactly. Bounded
// by the (finite) nesting depth of an EvidenceManifest. Idempotent (redact over already-redacted
// text is a no-op), so it is safe to apply at build time AND again as defense in depth at persist
// time. This is what makes the audit builder truly redacted-by-construction even for embedded
// summaries that the audit redactor would otherwise miss.
export function deepRedactStrings(
  value: unknown,
  redactString: (input: string) => string,
): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRedactStrings(item, redactString));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = deepRedactStrings(child, redactString);
    }
    return out;
  }
  return value;
}
