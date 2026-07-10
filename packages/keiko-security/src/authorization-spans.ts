import {
  CREDENTIAL_REDACTED_SENTINEL as REDACTED,
  MAX_VALUE_WHITESPACE,
  isValueWhitespace,
  lineValueEnd,
  quotedEnd,
  type StructuredCredentialUnitKind,
} from "./credential-structure-primitives.js";

export interface AuthorizationSpan {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface AuthorizationDetection extends AuthorizationSpan {
  readonly disposition: "redact" | "quarantine";
  readonly unitKind: StructuredCredentialUnitKind;
  readonly legacySpan: AuthorizationSpan;
}

interface AuthorizationValueStart {
  readonly start: number;
  readonly overflow: boolean;
}

const AUTHORIZATION_SCHEME_PATTERN = /\b(?:Bearer|Basic)\b/gi;

function authorizationValueStart(
  input: string,
  matchEnd: number,
): AuthorizationValueStart | undefined {
  if (!isValueWhitespace(input[matchEnd] ?? "")) return undefined;
  let cursor = matchEnd;
  let count = 0;
  while (isValueWhitespace(input[cursor] ?? "") && count < MAX_VALUE_WHITESPACE) {
    cursor += 1;
    count += 1;
  }
  return {
    start: cursor,
    overflow: count === MAX_VALUE_WHITESPACE && isValueWhitespace(input[cursor] ?? ""),
  };
}

function rangeEquals(input: string, start: number, end: number, expected: string): boolean {
  return end - start === expected.length && input.startsWith(expected, start);
}

function quotedAuthorizationDetection(
  input: string,
  start: number,
  opening: string,
): AuthorizationDetection | undefined {
  const closedEnd = quotedEnd(input, start, opening);
  const legacyEnd = closedEnd ?? input.length;
  const replacement = `${opening}${REDACTED}${opening}`;
  const legacySpan = { start, end: legacyEnd, replacement };
  if (closedEnd !== undefined && rangeEquals(input, start + 1, closedEnd - 1, REDACTED)) {
    return undefined;
  }
  return closedEnd === undefined
    ? {
        start,
        end: lineValueEnd(input, start),
        replacement,
        disposition: "quarantine",
        unitKind: "line-remainder",
        legacySpan,
      }
    : {
        ...legacySpan,
        disposition: "redact",
        unitKind: "quoted-segment",
        legacySpan,
      };
}

function unquotedTokenEnd(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && !isValueWhitespace(input[cursor] ?? "")) cursor += 1;
  return cursor;
}

function unquotedAuthorizationDetection(
  input: string,
  value: AuthorizationValueStart,
): AuthorizationDetection | undefined {
  const end = value.overflow
    ? lineValueEnd(input, value.start)
    : unquotedTokenEnd(input, value.start);
  if (end === value.start || rangeEquals(input, value.start, end, REDACTED)) return undefined;
  const legacySpan = { start: value.start, end, replacement: REDACTED };
  return value.overflow
    ? {
        ...legacySpan,
        disposition: "quarantine",
        unitKind: "line-remainder",
        legacySpan,
      }
    : {
        ...legacySpan,
        disposition: "redact",
        unitKind: "structured-value",
        legacySpan,
      };
}

function authorizationDetection(
  input: string,
  matchEnd: number,
): AuthorizationDetection | undefined {
  const value = authorizationValueStart(input, matchEnd);
  if (value === undefined) return undefined;
  const opening = input[value.start] ?? "";
  return opening === '"' || opening === "'"
    ? quotedAuthorizationDetection(input, value.start, opening)
    : unquotedAuthorizationDetection(input, value);
}

export function authorizationDetections(input: string): readonly AuthorizationDetection[] {
  const detections: AuthorizationDetection[] = [];
  let coveredUntil = 0;
  AUTHORIZATION_SCHEME_PATTERN.lastIndex = 0;
  for (const match of input.matchAll(AUTHORIZATION_SCHEME_PATTERN)) {
    if (match.index < coveredUntil) continue;
    const detection = authorizationDetection(input, match.index + match[0].length);
    if (detection === undefined) continue;
    detections.push(detection);
    coveredUntil = detection.legacySpan.end;
  }
  AUTHORIZATION_SCHEME_PATTERN.lastIndex = 0;
  return detections;
}

export function authorizationSpans(input: string): readonly AuthorizationSpan[] {
  return authorizationDetections(input).map((detection) => detection.legacySpan);
}
