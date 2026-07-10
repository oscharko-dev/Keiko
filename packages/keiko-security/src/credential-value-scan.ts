import {
  CREDENTIAL_REDACTED_SENTINEL,
  MAX_VALUE_WHITESPACE,
  isHorizontalWhitespace,
  isValueWhitespace,
  lineValueEnd,
  quotedEnd,
  type StructuredCredentialDetection,
  type StructuredCredentialSpan,
  type StructuredCredentialUnitKind,
} from "./credential-structure-primitives.js";

const MAX_CONTAINER_DEPTH = 64;

export interface ValueStart {
  readonly start: number;
  readonly overflow: boolean;
}

export function valueStart(input: string, separator: number): ValueStart {
  let cursor = separator + 1;
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

function valueStartsAuthorization(input: string, start: number): boolean {
  for (const scheme of ["bearer", "basic"] as const) {
    const end = start + scheme.length;
    if (input.slice(start, end).toLowerCase() === scheme && isValueWhitespace(input[end] ?? "")) {
      return true;
    }
  }
  return false;
}

function isSafeBoundary(value: string): boolean {
  return (
    value === "" ||
    value === "," ||
    value === "}" ||
    value === "]" ||
    value === "\r" ||
    value === "\n"
  );
}

function boundedValueEnd(input: string, balancedEnd: number, knownLineEnd?: number): number {
  let cursor = balancedEnd;
  while (isHorizontalWhitespace(input[cursor] ?? "")) cursor += 1;
  if (isSafeBoundary(input[cursor] ?? "")) return balancedEnd;
  return knownLineEnd !== undefined && balancedEnd <= knownLineEnd
    ? knownLineEnd
    : lineValueEnd(input, balancedEnd);
}

function rangeEquals(input: string, start: number, end: number, expected: string): boolean {
  return end - start === expected.length && input.startsWith(expected, start);
}

function quotedValueSpan(
  input: string,
  start: number,
  opening: string,
  knownLineEnd?: number,
): StructuredCredentialSpan | undefined {
  const closedEnd = quotedEnd(input, start, opening);
  if (closedEnd === undefined) {
    return {
      start,
      end: input.length,
      replacement: `${opening}${CREDENTIAL_REDACTED_SENTINEL}${opening}`,
    };
  }
  const firstLineEnd = knownLineEnd ?? lineValueEnd(input, start);
  if (closedEnd > firstLineEnd) {
    return {
      start,
      end: closedEnd,
      replacement: `${opening}${CREDENTIAL_REDACTED_SENTINEL}${opening}\n`,
    };
  }
  const end = boundedValueEnd(input, closedEnd, knownLineEnd);
  const exactSentinel =
    end === closedEnd && rangeEquals(input, start + 1, closedEnd - 1, CREDENTIAL_REDACTED_SENTINEL);
  return exactSentinel
    ? undefined
    : { start, end, replacement: `${opening}${CREDENTIAL_REDACTED_SENTINEL}${opening}` };
}

function matchingClose(opening: string): string {
  return opening === "{" ? "}" : "]";
}

function isQuote(value: string): boolean {
  return value === '"' || value === "'";
}

function isContainerOpening(value: string): boolean {
  return value === "{" || value === "[";
}

function isContainerClosing(value: string): boolean {
  return value === "}" || value === "]";
}

function closeContainer(stack: string[], closing: string): "invalid" | "complete" | "open" {
  if (stack.pop() !== closing) return "invalid";
  return stack.length === 0 ? "complete" : "open";
}

function openContainer(stack: string[], opening: string): boolean {
  if (stack.length >= MAX_CONTAINER_DEPTH) return false;
  stack.push(matchingClose(opening));
  return true;
}

type ContainerStep = { readonly next: number } | { readonly end: number } | undefined;

function isLineBreak(value: string): boolean {
  return value === "\r" || value === "\n";
}

function containerEscapeNext(input: string, cursor: number): number | undefined {
  if (input[cursor] !== "\\") return undefined;
  const escaped = input[cursor + 1] ?? "";
  return escaped === "" || isLineBreak(escaped) ? -1 : cursor + 2;
}

function containerQuotedEnd(input: string, start: number, quote: string): number | undefined {
  let cursor = start + 1;
  while (cursor < input.length) {
    const current = input[cursor] ?? "";
    if (isLineBreak(current)) return undefined;
    const escaped = containerEscapeNext(input, cursor);
    if (escaped !== undefined) {
      if (escaped < 0) return undefined;
      cursor = escaped;
      continue;
    }
    if (current === quote) return cursor + 1;
    cursor += 1;
  }
  return undefined;
}

function containerStep(input: string, cursor: number, stack: string[]): ContainerStep {
  const current = input[cursor] ?? "";
  if (isQuote(current)) {
    const end = containerQuotedEnd(input, cursor, current);
    return end === undefined ? undefined : { next: end };
  }
  if (isContainerOpening(current)) {
    return openContainer(stack, current) ? { next: cursor + 1 } : undefined;
  }
  if (!isContainerClosing(current)) return { next: cursor + 1 };
  const status = closeContainer(stack, current);
  if (status === "invalid") return undefined;
  return status === "complete" ? { end: cursor + 1 } : { next: cursor + 1 };
}

function balancedContainerEnd(input: string, start: number): number | undefined {
  const stack: string[] = [matchingClose(input[start] ?? "")];
  let cursor = start + 1;
  while (cursor < input.length) {
    const step = containerStep(input, cursor, stack);
    if (step === undefined) return undefined;
    if ("end" in step) return step.end;
    cursor = step.next;
  }
  return undefined;
}

function sentinelIsExact(input: string, start: number): boolean {
  const end = start + CREDENTIAL_REDACTED_SENTINEL.length;
  if (!input.startsWith(CREDENTIAL_REDACTED_SENTINEL, start)) return false;
  let cursor = end;
  while (isHorizontalWhitespace(input[cursor] ?? "")) cursor += 1;
  return isSafeBoundary(input[cursor] ?? "");
}

function containerValueSpan(
  input: string,
  start: number,
  knownLineEnd?: number,
): StructuredCredentialSpan | undefined {
  if (sentinelIsExact(input, start)) return undefined;
  const balancedEnd = balancedContainerEnd(input, start);
  const end =
    balancedEnd === undefined ? input.length : boundedValueEnd(input, balancedEnd, knownLineEnd);
  return { start, end, replacement: CREDENTIAL_REDACTED_SENTINEL };
}

function scalarValueSpan(
  input: string,
  start: number,
  knownLineEnd?: number,
): StructuredCredentialSpan | undefined {
  if (valueStartsAuthorization(input, start)) return undefined;
  const end = knownLineEnd ?? lineValueEnd(input, start);
  let contentEnd = end;
  while (contentEnd > start && isHorizontalWhitespace(input[contentEnd - 1] ?? "")) {
    contentEnd -= 1;
  }
  if (contentEnd === start || rangeEquals(input, start, contentEnd, CREDENTIAL_REDACTED_SENTINEL)) {
    return undefined;
  }
  return { start, end, replacement: CREDENTIAL_REDACTED_SENTINEL };
}

function structuredValueSpan(
  input: string,
  value: ValueStart,
  knownLineEnd?: number,
): StructuredCredentialSpan | undefined {
  if (value.overflow) {
    return { start: value.start, end: input.length, replacement: CREDENTIAL_REDACTED_SENTINEL };
  }
  const opening = input[value.start] ?? "";
  if (isQuote(opening)) return quotedValueSpan(input, value.start, opening, knownLineEnd);
  if (isContainerOpening(opening)) return containerValueSpan(input, value.start, knownLineEnd);
  if (opening === "|" || opening === ">") {
    return { start: value.start, end: input.length, replacement: CREDENTIAL_REDACTED_SENTINEL };
  }
  return scalarValueSpan(input, value.start, knownLineEnd);
}

function quarantinedDetection(
  legacySpan: StructuredCredentialSpan,
  start: number,
  end: number,
  unitKind: StructuredCredentialUnitKind,
  replacement = "",
): StructuredCredentialDetection {
  return {
    start,
    end,
    replacement,
    disposition: "quarantine",
    unitKind,
    legacySpan,
  };
}

function redactedDetection(
  legacySpan: StructuredCredentialSpan,
  unitKind: StructuredCredentialUnitKind,
): StructuredCredentialDetection {
  return { ...legacySpan, disposition: "redact", unitKind, legacySpan };
}

function quotedValueDetection(
  input: string,
  value: ValueStart,
  legacySpan: StructuredCredentialSpan,
  knownLineEnd?: number,
): StructuredCredentialDetection {
  const opening = input[value.start] ?? "";
  const closedEnd = quotedEnd(input, value.start, opening);
  const localEnd = knownLineEnd ?? lineValueEnd(input, value.start);
  if (closedEnd === undefined) {
    return quarantinedDetection(
      legacySpan,
      value.start,
      localEnd,
      "line-remainder",
      `${opening}${CREDENTIAL_REDACTED_SENTINEL}${opening}`,
    );
  }
  if (closedEnd > localEnd) {
    return quarantinedDetection(
      legacySpan,
      value.start,
      closedEnd,
      "quoted-segment",
      legacySpan.replacement,
    );
  }
  return boundedValueEnd(input, closedEnd, knownLineEnd) === closedEnd
    ? redactedDetection(legacySpan, "quoted-segment")
    : quarantinedDetection(legacySpan, value.start, localEnd, "line-remainder");
}

function containerValueDetection(
  input: string,
  value: ValueStart,
  legacySpan: StructuredCredentialSpan,
  knownLineEnd?: number,
): StructuredCredentialDetection {
  const balancedEnd = balancedContainerEnd(input, value.start);
  if (balancedEnd === undefined) {
    return quarantinedDetection(
      legacySpan,
      value.start,
      knownLineEnd ?? lineValueEnd(input, value.start),
      "line-remainder",
    );
  }
  return boundedValueEnd(input, balancedEnd, knownLineEnd) === balancedEnd
    ? redactedDetection(legacySpan, "structured-value")
    : quarantinedDetection(
        legacySpan,
        value.start,
        knownLineEnd ?? lineValueEnd(input, value.start),
        "line-remainder",
      );
}

function nextLineStart(input: string, end: number): number {
  let cursor = end;
  if (input[cursor] === "\r") cursor += 1;
  if (input[cursor] === "\n") cursor += 1;
  return cursor;
}

function lineIndent(input: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && isHorizontalWhitespace(input[cursor] ?? "")) cursor += 1;
  return cursor - start;
}

function parentLineIndent(input: string, valueStart: number): number {
  const newline = input.lastIndexOf("\n", Math.max(0, valueStart - 1));
  const start = newline < 0 ? 0 : newline + 1;
  return lineIndent(input, start, valueStart);
}

function blockScalarUnitEnd(input: string, start: number): number {
  const headerEnd = lineValueEnd(input, start);
  const parentIndent = parentLineIndent(input, start);
  let cursor = nextLineStart(input, headerEnd);
  let end = headerEnd;
  let hasOwnedContent = false;
  while (cursor < input.length) {
    const currentEnd = lineValueEnd(input, cursor);
    const indent = lineIndent(input, cursor, currentEnd);
    const blank = cursor + indent === currentEnd;
    if (!blank && indent <= parentIndent) return end;
    if (!blank) hasOwnedContent = true;
    end = currentEnd;
    cursor = nextLineStart(input, currentEnd);
  }
  return hasOwnedContent ? end : input.length;
}

export function structuredValueDetection(
  input: string,
  value: ValueStart,
  knownLineEnd?: number,
): StructuredCredentialDetection | undefined {
  const legacySpan = structuredValueSpan(input, value, knownLineEnd);
  if (legacySpan === undefined) return undefined;
  if (value.overflow) {
    return quarantinedDetection(
      legacySpan,
      value.start,
      legacySpan.end,
      "line-remainder",
      CREDENTIAL_REDACTED_SENTINEL,
    );
  }
  const opening = input[value.start] ?? "";
  if (isQuote(opening)) return quotedValueDetection(input, value, legacySpan, knownLineEnd);
  if (isContainerOpening(opening)) {
    return containerValueDetection(input, value, legacySpan, knownLineEnd);
  }
  if (opening === "|" || opening === ">") {
    return quarantinedDetection(
      legacySpan,
      legacySpan.start,
      blockScalarUnitEnd(input, value.start),
      "structured-value",
      CREDENTIAL_REDACTED_SENTINEL,
    );
  }
  return redactedDetection(legacySpan, "structured-value");
}
