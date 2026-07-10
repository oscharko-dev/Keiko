import {
  CREDENTIAL_REDACTED_SENTINEL as REDACTED,
  structuredCredentialDetections,
  structuredCredentialSpans,
  type StructuredCredentialDetection,
  type StructuredCredentialUnitKind,
} from "./credential-structured.js";
import { authorizationDetections, authorizationSpans } from "./authorization-spans.js";

const MAX_KEY_CHARACTERS = 128;

export type CredentialSpanKind = "authorization-secret" | "credential-assignment" | "url-userinfo";

export interface CredentialSpanRuleCount {
  readonly code: CredentialSpanKind;
  readonly count: number;
}

export interface CredentialSpanRedaction {
  readonly value: string;
  readonly rules: readonly CredentialSpanRuleCount[];
}

export interface FeedbackCredentialDisposition {
  readonly action: "redacted" | "quarantined";
  readonly unitKind: StructuredCredentialUnitKind;
}

export interface FeedbackCredentialRedaction extends CredentialSpanRedaction {
  readonly dispositions: readonly FeedbackCredentialDisposition[];
}

interface CredentialSpan {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

const NORMALIZED_SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  "passwd",
  "password",
  "apikey",
  "apitoken",
  "token",
  "secretkey",
  "secret",
  "clientsecret",
  "refreshtoken",
  "accesstoken",
  "idtoken",
  "privatekey",
  "awssecretaccesskey",
  "secretaccesskey",
  "sastoken",
  "jwtsecret",
  "dbpassword",
  "connectionstring",
  "credential",
]);

const GOVERNED_SECRET_KEY_SUFFIXES = [...NORMALIZED_SECRET_KEY_NAMES].filter(
  (value) => value.length >= 5,
);

const URL_SCHEME_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\//gi;
const CONSERVATIVE_COLON_ASSIGNMENTS = true;

export function isCredentialKeyName(value: string): boolean {
  const bounded = value.slice(Math.max(0, value.length - MAX_KEY_CHARACTERS));
  const normalized = bounded.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return (
    NORMALIZED_SECRET_KEY_NAMES.has(normalized) ||
    GOVERNED_SECRET_KEY_SUFFIXES.some(
      (suffix) => normalized.length > suffix.length && normalized.endsWith(suffix),
    )
  );
}

function rangeEquals(input: string, start: number, end: number, expected: string): boolean {
  return end - start === expected.length && input.startsWith(expected, start);
}

function applySpans(input: string, spans: readonly CredentialSpan[]): string {
  if (spans.length === 0) return input;
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor || span.end < span.start) {
      throw new Error("credential span invariant violated");
    }
    parts.push(input.slice(cursor, span.start), span.replacement);
    cursor = span.end;
  }
  parts.push(input.slice(cursor));
  return parts.join("");
}

interface AuthorityBounds {
  readonly end: number;
  readonly finalAt: number;
  readonly firstColon: number;
}

function authorityBounds(input: string, start: number): AuthorityBounds {
  let cursor = start;
  let finalAt = -1;
  let firstColon = -1;
  while (cursor < input.length && !/[\s/?#"'`<>]/u.test(input[cursor] ?? "")) {
    if (input[cursor] === "@") finalAt = cursor;
    if (input[cursor] === ":" && firstColon < 0) firstColon = cursor;
    cursor += 1;
  }
  return { end: cursor, finalAt, firstColon };
}

function isSshLoginScheme(value: string): boolean {
  return /^(?:git\+)?ssh(?:\+git)?$/iu.test(value);
}

function urlUserinfoSpans(input: string): readonly CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  let coveredUntil = 0;
  URL_SCHEME_PATTERN.lastIndex = 0;
  for (const match of input.matchAll(URL_SCHEME_PATTERN)) {
    const matchStart = match.index;
    if (matchStart < coveredUntil) continue;
    const authorityStart = matchStart + match[0].length;
    const bounds = authorityBounds(input, authorityStart);
    if (bounds.finalAt < authorityStart) continue;
    if (rangeEquals(input, authorityStart, bounds.finalAt, REDACTED)) continue;
    const hasPassword = bounds.firstColon >= authorityStart && bounds.firstColon < bounds.finalAt;
    const scheme = match[0].slice(0, -3);
    if (!hasPassword && isSshLoginScheme(scheme)) continue;
    spans.push({ start: authorityStart, end: bounds.finalAt, replacement: REDACTED });
    coveredUntil = bounds.end;
  }
  URL_SCHEME_PATTERN.lastIndex = 0;
  return spans;
}

function assignmentSpans(input: string): readonly CredentialSpan[] {
  return structuredCredentialSpans(input, isCredentialKeyName, CONSERVATIVE_COLON_ASSIGNMENTS);
}

function feedbackAssignmentDetections(input: string): readonly StructuredCredentialDetection[] {
  return structuredCredentialDetections(input, isCredentialKeyName);
}

function sharedAssignmentDetections(input: string): readonly StructuredCredentialDetection[] {
  return structuredCredentialDetections(input, isCredentialKeyName, CONSERVATIVE_COLON_ASSIGNMENTS);
}

function feedbackAssignmentRedaction(input: string): FeedbackCredentialRedaction {
  const detections = feedbackAssignmentDetections(input);
  if (detections.length === 0) return { value: input, rules: [], dispositions: [] };
  return {
    value: applySpans(input, detections),
    rules: [{ code: "credential-assignment", count: detections.length }],
    dispositions: detections.map((detection) => ({
      action: detection.disposition === "redact" ? "redacted" : "quarantined",
      unitKind: detection.unitKind,
    })),
  };
}

function feedbackAuthorizationRedaction(input: string): FeedbackCredentialRedaction {
  const detections = authorizationDetections(input);
  if (detections.length === 0) return { value: input, rules: [], dispositions: [] };
  return {
    value: applySpans(input, detections),
    rules: [{ code: "authorization-secret", count: detections.length }],
    dispositions: detections.map((detection) => ({
      action: detection.disposition === "redact" ? "redacted" : "quarantined",
      unitKind: detection.unitKind,
    })),
  };
}

function redactKind(
  input: string,
  kind: CredentialSpanKind,
  scan: (value: string) => readonly CredentialSpan[],
): { readonly value: string; readonly rule?: CredentialSpanRuleCount } {
  const spans = scan(input);
  return spans.length === 0
    ? { value: input }
    : { value: applySpans(input, spans), rule: { code: kind, count: spans.length } };
}

export function redactCredentialSpans(input: string): CredentialSpanRedaction {
  const rules: CredentialSpanRuleCount[] = [];
  const assignment = redactKind(input, "credential-assignment", assignmentSpans);
  if (assignment.rule !== undefined) rules.push(assignment.rule);
  const authorization = redactKind(assignment.value, "authorization-secret", authorizationSpans);
  if (authorization.rule !== undefined) rules.push(authorization.rule);
  const userinfo = redactKind(authorization.value, "url-userinfo", urlUserinfoSpans);
  if (userinfo.rule !== undefined) rules.push(userinfo.rule);
  return { value: userinfo.value, rules };
}

function appendRedactedDispositions(
  output: { readonly rule?: CredentialSpanRuleCount | undefined },
  unitKind: StructuredCredentialUnitKind,
  dispositions: FeedbackCredentialDisposition[],
): void {
  const count = output.rule?.count ?? 0;
  for (let index = 0; index < count; index += 1) {
    dispositions.push({ action: "redacted", unitKind });
  }
}

export function sanitizeFeedbackCredentialSpans(input: string): FeedbackCredentialRedaction {
  const assignment = feedbackAssignmentRedaction(input);
  const authorization = feedbackAuthorizationRedaction(assignment.value);
  const dispositions = [...assignment.dispositions, ...authorization.dispositions];
  const userinfo = redactKind(authorization.value, "url-userinfo", urlUserinfoSpans);
  appendRedactedDispositions(userinfo, "structured-value", dispositions);
  return {
    value: userinfo.value,
    rules: [
      ...assignment.rules,
      ...authorization.rules,
      ...(userinfo.rule === undefined ? [] : [userinfo.rule]),
    ],
    dispositions,
  };
}

export function containsFeedbackCredentialDetection(input: string): boolean {
  return (
    feedbackAssignmentDetections(input).length > 0 ||
    authorizationDetections(input).length > 0 ||
    urlUserinfoSpans(input).length > 0
  );
}

export function containsCredentialDetection(input: string): boolean {
  return (
    sharedAssignmentDetections(input).length > 0 ||
    authorizationDetections(input).length > 0 ||
    urlUserinfoSpans(input).length > 0
  );
}

export function containsCredentialSpan(input: string): boolean {
  return redactCredentialSpans(input).value !== input;
}
