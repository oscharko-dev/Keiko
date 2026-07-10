import {
  CREDENTIAL_REDACTED_SENTINEL,
  MAX_VALUE_WHITESPACE,
  isHorizontalWhitespace,
  isValueWhitespace,
  lineValueEnd,
  type CredentialKeyPredicate,
  type StructuredCredentialDetection,
  type StructuredCredentialSpan,
} from "./credential-structure-primitives.js";
import { structuredValueDetection, valueStart } from "./credential-value-scan.js";

export { CREDENTIAL_REDACTED_SENTINEL } from "./credential-structure-primitives.js";
export type {
  CredentialKeyPredicate,
  StructuredCredentialDetection,
  StructuredCredentialDisposition,
  StructuredCredentialSpan,
  StructuredCredentialUnitKind,
} from "./credential-structure-primitives.js";

const MAX_KEY_CHARACTERS = 128;

function isIdentifierStart(value: string): boolean {
  return /[A-Za-z_]/u.test(value);
}

function isIdentifierCharacter(value: string): boolean {
  return /[A-Za-z0-9_-]/u.test(value);
}

function urlAuthorityEnd(input: string, schemeColon: number): number {
  let cursor = schemeColon + 3;
  while (cursor < input.length && !/[\s/?#"'`<>]/u.test(input[cursor] ?? "")) cursor += 1;
  return cursor;
}

type CredentialScanEvent =
  | { readonly kind: "separator"; readonly index: number }
  | {
      readonly kind: "embedded";
      readonly detection: StructuredCredentialDetection;
      readonly next: number;
    };

interface CredentialScanPolicy {
  readonly isCredentialKey: CredentialKeyPredicate;
  readonly allowUnanchoredColon: boolean;
}

interface QuoteScanResult {
  readonly next: number;
  readonly detection?: StructuredCredentialDetection | undefined;
}

interface QuoteTermination {
  readonly next: number;
  readonly end: number;
  readonly closed: boolean;
}

function embeddedQuoteDetection(
  start: number,
  end: number,
  closed: boolean,
  quote: string,
): StructuredCredentialDetection {
  return {
    start,
    end,
    replacement: "",
    disposition: "quarantine",
    unitKind: closed ? "quoted-segment" : "line-remainder",
    legacySpan: {
      start,
      end,
      replacement: `${quote}${CREDENTIAL_REDACTED_SENTINEL}${quote}`,
    },
  };
}

function quoteEscapeNext(input: string, cursor: number, quote: string): number | undefined {
  const current = input[cursor] ?? "";
  const escaped = input[cursor + 1] ?? "";
  if (current === "\\" && escaped !== "\r" && escaped !== "\n") {
    return Math.min(input.length, cursor + 2);
  }
  return current === quote && quote === "'" && input[cursor + 1] === "'" ? cursor + 2 : undefined;
}

function quoteTermination(
  input: string,
  start: number,
  cursor: number,
  quote: string,
): QuoteTermination | undefined {
  const current = input[cursor] ?? "";
  if (current === quote) return { next: cursor + 1, end: cursor + 1, closed: true };
  if (current !== "\r" && current !== "\n") return undefined;
  return {
    next: current === "\r" && input[cursor + 1] === "\n" ? cursor + 2 : cursor + 1,
    end: current === "\r" ? cursor : lineValueEnd(input, start),
    closed: false,
  };
}

function quoteResult(
  start: number,
  termination: QuoteTermination,
  governed: boolean,
  quote: string,
): QuoteScanResult {
  return governed
    ? {
        next: termination.next,
        detection: embeddedQuoteDetection(start, termination.end, termination.closed, quote),
      }
    : { next: termination.next };
}

function isGovernedQuoteSeparator(
  input: string,
  cursor: number,
  policy: CredentialScanPolicy,
): boolean {
  const current = input[cursor] ?? "";
  if (current !== ":" && current !== "=") return false;
  if (current === ":" && input.startsWith("://", cursor)) return false;
  return governedKeyBounds(input, cursor, policy) !== undefined;
}

function scanQuotedRegion(
  input: string,
  start: number,
  quote: string,
  policy: CredentialScanPolicy,
): QuoteScanResult {
  let cursor = start + 1;
  let governed = false;
  while (cursor < input.length) {
    const escaped = quoteEscapeNext(input, cursor, quote);
    if (escaped !== undefined) {
      cursor = escaped;
      continue;
    }
    const termination = quoteTermination(input, start, cursor, quote);
    if (termination !== undefined) {
      if (termination.closed || !governed) return quoteResult(start, termination, governed, quote);
      cursor = termination.next;
      continue;
    }
    if (!governed && isGovernedQuoteSeparator(input, cursor, policy)) {
      governed = true;
    }
    cursor += 1;
  }
  return quoteResult(
    start,
    { next: input.length, end: input.length, closed: false },
    governed,
    quote,
  );
}

function nextCredentialEvent(
  input: string,
  from: number,
  policy: CredentialScanPolicy,
): CredentialScanEvent | undefined {
  let cursor = from;
  while (cursor < input.length) {
    const current = input[cursor] ?? "";
    if (current === '"' || current === "'") {
      const quote = scanQuotedRegion(input, cursor, current, policy);
      if (quote.detection !== undefined) {
        return { kind: "embedded", detection: quote.detection, next: quote.next };
      }
      cursor = quote.next;
      continue;
    }
    if (current === ":" && input.startsWith("://", cursor)) {
      cursor = urlAuthorityEnd(input, cursor);
      continue;
    }
    if (current === ":" || current === "=") return { kind: "separator", index: cursor };
    cursor += 1;
  }
  return undefined;
}

interface KeyBounds {
  readonly start: number;
  readonly end: number;
  readonly anchor: number;
  readonly overBudget: boolean;
}

function quotedKeyBounds(input: string, end: number, quote: string): KeyBounds | undefined {
  const floor = Math.max(0, end - MAX_KEY_CHARACTERS - 2);
  let cursor = end - 2;
  while (cursor >= floor) {
    if (input[cursor] === quote && input[cursor - 1] !== "\\") {
      return {
        start: cursor + 1,
        end: end - 1,
        anchor: cursor,
        overBudget: cursor === floor && floor > 0,
      };
    }
    cursor -= 1;
  }
  return floor > 0 ? { start: floor, end: end - 1, anchor: floor, overBudget: true } : undefined;
}

function unquotedKeyBounds(input: string, end: number): KeyBounds {
  const floor = Math.max(0, end - MAX_KEY_CHARACTERS);
  let start = end;
  while (start > floor && !isValueWhitespace(input[start - 1] ?? "")) start -= 1;
  const overBudget = start === floor && floor > 0 && !isValueWhitespace(input[floor - 1] ?? "");
  return {
    start,
    end,
    anchor: start,
    overBudget,
  };
}

interface BoundedKeyEnd {
  readonly end: number;
  readonly overflow: boolean;
}

function boundedKeyEnd(input: string, separator: number): BoundedKeyEnd {
  let end = separator;
  let whitespace = 0;
  while (end > 0 && whitespace < MAX_VALUE_WHITESPACE && isValueWhitespace(input[end - 1] ?? "")) {
    end -= 1;
    whitespace += 1;
  }
  return {
    end,
    overflow: whitespace === MAX_VALUE_WHITESPACE && isValueWhitespace(input[end - 1] ?? ""),
  };
}

function keyBounds(input: string, separator: number): KeyBounds | undefined {
  const { end, overflow } = boundedKeyEnd(input, separator);
  if (end === 0) return undefined;
  if (overflow) {
    return { start: end, end, anchor: end, overBudget: true };
  }
  const closing = input[end - 1] ?? "";
  return closing === '"' || closing === "'"
    ? quotedKeyBounds(input, end, closing)
    : unquotedKeyBounds(input, end);
}

function hasGovernedIdentifier(
  input: string,
  start: number,
  end: number,
  isCredentialKey: CredentialKeyPredicate,
): boolean {
  let cursor = start;
  while (cursor < end) {
    if (!isIdentifierStart(input[cursor] ?? "")) {
      cursor += 1;
      continue;
    }
    let identifierEnd = cursor + 1;
    while (identifierEnd < end && isIdentifierCharacter(input[identifierEnd] ?? "")) {
      identifierEnd += 1;
    }
    if (isCredentialKey(input.slice(cursor, identifierEnd))) return true;
    cursor = identifierEnd;
  }
  return false;
}

function keyIsGoverned(
  input: string,
  bounds: KeyBounds,
  isCredentialKey: CredentialKeyPredicate,
): boolean {
  if (bounds.overBudget) return true;
  const token = input.slice(bounds.start, bounds.end);
  if (isCredentialKey(token)) return true;
  return (
    !/\s/u.test(token) && hasGovernedIdentifier(input, bounds.start, bounds.end, isCredentialKey)
  );
}

function colonIsAnchored(input: string, bounds: KeyBounds): boolean {
  let cursor = bounds.anchor - 1;
  let inspected = 0;
  while (
    cursor >= 0 &&
    inspected < MAX_KEY_CHARACTERS &&
    isHorizontalWhitespace(input[cursor] ?? "")
  ) {
    cursor -= 1;
    inspected += 1;
  }
  if (inspected === MAX_KEY_CHARACTERS) return true;
  return cursor < 0 || input[cursor] === "\n" || /[-,;{[(]/u.test(input[cursor] ?? "");
}

function governedKeyBounds(
  input: string,
  separator: number,
  policy: CredentialScanPolicy,
): KeyBounds | undefined {
  const bounds = keyBounds(input, separator);
  if (bounds === undefined || !keyIsGoverned(input, bounds, policy.isCredentialKey))
    return undefined;
  const governed =
    input[separator] === "=" ||
    policy.allowUnanchoredColon ||
    bounds.overBudget ||
    colonIsAnchored(input, bounds);
  return governed ? bounds : undefined;
}

function lineStart(input: string, from: number): number {
  return input.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
}

function overBudgetDetection(
  input: string,
  floor: number,
  detection: StructuredCredentialDetection,
): StructuredCredentialDetection {
  return {
    start: Math.max(floor, lineStart(input, detection.start)),
    end: detection.legacySpan?.end ?? detection.end,
    replacement: "",
    disposition: "quarantine",
    unitKind: "line-remainder",
    legacySpan: detection.legacySpan,
  };
}

export function structuredCredentialDetections(
  input: string,
  isCredentialKey: CredentialKeyPredicate,
  allowUnanchoredColon = false,
): readonly StructuredCredentialDetection[] {
  const detections: StructuredCredentialDetection[] = [];
  const policy = { isCredentialKey, allowUnanchoredColon };
  let cursor = 0;
  while (cursor < input.length) {
    const event = nextCredentialEvent(input, cursor, policy);
    if (event === undefined) break;
    if (event.kind === "embedded") {
      detections.push(event.detection);
      cursor = event.next;
      continue;
    }
    const bounds = governedKeyBounds(input, event.index, policy);
    if (bounds === undefined) {
      cursor = event.index + 1;
      continue;
    }
    const value = valueStart(input, event.index);
    const detection = structuredValueDetection(input, value);
    if (detection === undefined) {
      cursor = Math.max(event.index + 1, value.start);
      continue;
    }
    const bounded = bounds.overBudget ? overBudgetDetection(input, cursor, detection) : detection;
    detections.push(bounded);
    cursor = Math.max(bounded.end, event.index + 1);
  }
  return detections;
}

export function structuredCredentialSpans(
  input: string,
  isCredentialKey: CredentialKeyPredicate,
  allowUnanchoredColon = false,
): readonly StructuredCredentialSpan[] {
  const spans: StructuredCredentialSpan[] = [];
  for (const detection of structuredCredentialDetections(
    input,
    isCredentialKey,
    allowUnanchoredColon,
  )) {
    if (detection.legacySpan === undefined) continue;
    const previous = spans.at(-1);
    if (previous !== undefined && detection.legacySpan.start < previous.end) continue;
    spans.push(detection.legacySpan);
  }
  return spans;
}
