import {
  CREDENTIAL_REDACTED_SENTINEL,
  isHorizontalWhitespace,
  lineValueEnd,
  type StructuredCredentialDetection,
} from "./credential-structure-primitives.js";

interface GovernedKeyBounds {
  readonly anchor: number;
}

const MAX_METHOD_RETURN_TYPE_CHARACTERS = 128;
const MAX_METHOD_RETURN_TYPE_DEPTH = 16;
const MAX_BOUNDARY_CONTAINER_DEPTH = 64;
const BUILTIN_METHOD_RETURN_TYPES: ReadonlySet<string> = new Set([
  "any",
  "bigint",
  "boolean",
  "never",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "this",
  "unknown",
  "undefined",
  "void",
]);

type GovernedSeparator<TPolicy> = (
  input: string,
  separator: number,
  policy: TPolicy,
) => GovernedKeyBounds | undefined;

export class CredentialLineEndCache {
  private breakAt = -1;
  private valueEnd = -1;

  valueFor(input: string, start: number): number {
    if (start <= this.breakAt) return this.valueEnd;
    this.valueEnd = lineValueEnd(input, start);
    this.breakAt =
      input[this.valueEnd] === "\r" && input[this.valueEnd + 1] === "\n"
        ? this.valueEnd + 1
        : this.valueEnd;
    return this.valueEnd;
  }
}

interface MethodTypeCursor {
  index: number;
  readonly limit: number;
}

function skipMethodTypeWhitespace(input: string, cursor: MethodTypeCursor): void {
  while (cursor.index < cursor.limit && isHorizontalWhitespace(input[cursor.index] ?? "")) {
    cursor.index += 1;
  }
}

function isMethodIdentifierStart(value: string): boolean {
  return /[A-Za-z_$]/u.test(value);
}

function isMethodIdentifierCharacter(value: string): boolean {
  return /[A-Za-z0-9_$]/u.test(value);
}

function methodIdentifier(input: string, cursor: MethodTypeCursor): string | undefined {
  const start = cursor.index;
  if (start >= cursor.limit || !isMethodIdentifierStart(input[start] ?? "")) return undefined;
  cursor.index += 1;
  while (cursor.index < cursor.limit && isMethodIdentifierCharacter(input[cursor.index] ?? "")) {
    cursor.index += 1;
  }
  return input.slice(start, cursor.index);
}

interface MethodTypeName {
  readonly root: string;
  readonly qualified: boolean;
}

function methodTypeName(input: string, cursor: MethodTypeCursor): MethodTypeName | undefined {
  const root = methodIdentifier(input, cursor);
  if (root === undefined) return undefined;
  let qualified = false;
  while (cursor.index < cursor.limit && input[cursor.index] === ".") {
    cursor.index += 1;
    if (methodIdentifier(input, cursor) === undefined) return undefined;
    qualified = true;
  }
  return { root, qualified };
}

function supportedMethodTypeName(name: MethodTypeName): boolean {
  const first = name.root[0] ?? "";
  return BUILTIN_METHOD_RETURN_TYPES.has(name.root) || name.qualified || /[A-Z_$]/u.test(first);
}

function parseMethodGeneric(input: string, cursor: MethodTypeCursor, depth: number): boolean {
  if (cursor.index >= cursor.limit || input[cursor.index] !== "<") return true;
  if (depth >= MAX_METHOD_RETURN_TYPE_DEPTH) return false;
  cursor.index += 1;
  if (!parseMethodUnion(input, cursor, depth + 1)) return false;
  skipMethodTypeWhitespace(input, cursor);
  while (cursor.index < cursor.limit && input[cursor.index] === ",") {
    cursor.index += 1;
    if (!parseMethodUnion(input, cursor, depth + 1)) return false;
    skipMethodTypeWhitespace(input, cursor);
  }
  if (cursor.index >= cursor.limit || input[cursor.index] !== ">") return false;
  cursor.index += 1;
  return true;
}

function parseMethodArraySuffixes(input: string, cursor: MethodTypeCursor): boolean {
  for (;;) {
    skipMethodTypeWhitespace(input, cursor);
    if (cursor.index >= cursor.limit || input[cursor.index] !== "[") return true;
    if (cursor.index + 1 >= cursor.limit || input[cursor.index + 1] !== "]") return false;
    cursor.index += 2;
  }
}

function parseMethodPrimary(input: string, cursor: MethodTypeCursor, depth: number): boolean {
  skipMethodTypeWhitespace(input, cursor);
  const name = methodTypeName(input, cursor);
  if (name === undefined || !supportedMethodTypeName(name)) return false;
  skipMethodTypeWhitespace(input, cursor);
  if (!parseMethodGeneric(input, cursor, depth)) return false;
  return parseMethodArraySuffixes(input, cursor);
}

function parseMethodUnion(input: string, cursor: MethodTypeCursor, depth: number): boolean {
  if (!parseMethodPrimary(input, cursor, depth)) return false;
  skipMethodTypeWhitespace(input, cursor);
  while (cursor.index < cursor.limit && input[cursor.index] === "|") {
    cursor.index += 1;
    if (!parseMethodPrimary(input, cursor, depth)) return false;
    skipMethodTypeWhitespace(input, cursor);
  }
  return true;
}

function isMethodReturnTerminator(input: string, cursor: MethodTypeCursor): boolean {
  if (cursor.index === input.length) return true;
  const current = input[cursor.index] ?? "";
  return current === "{" || current === ";" || current === "\r" || current === "\n";
}

/**
 * Conservative return-type subset: built-ins or custom/qualified names, bounded nested generics,
 * array suffixes, and unions. The entire type must be consumed before a code terminator; unsupported
 * TypeScript syntax is intentionally treated as a credential assignment rather than guessed at.
 */
function hasCompleteMethodReturnType(input: string, separator: number): boolean {
  const start = separator + 1;
  const cursor: MethodTypeCursor = {
    index: start,
    limit: Math.min(input.length, start + MAX_METHOD_RETURN_TYPE_CHARACTERS),
  };
  if (!parseMethodUnion(input, cursor, 0)) return false;
  skipMethodTypeWhitespace(input, cursor);
  return isMethodReturnTerminator(input, cursor);
}

export function isEmptyCallColon(
  input: string,
  separator: number,
  bounds: GovernedKeyBounds & { readonly start: number; readonly end: number },
): boolean {
  const anchor = input[bounds.anchor] ?? "";
  if (
    input[separator] !== ":" ||
    anchor === '"' ||
    anchor === "'" ||
    !input.slice(bounds.start, bounds.end).endsWith("()")
  ) {
    return false;
  }
  return hasCompleteMethodReturnType(input, separator);
}

function isQuote(value: string): boolean {
  return value === '"' || value === "'";
}

function isAssignmentDelimiter(value: string): boolean {
  return value === ";" || value === "," || value === "&";
}

function isAssignmentSeparator(value: string): boolean {
  return value === ":" || value === "=";
}

function hasBoundarySeparator(boundary: number, value: string): boolean {
  return boundary >= 0 && isAssignmentSeparator(value);
}

type ContainerStatus = "outside" | "inside" | "invalid";

function matchingClose(value: string): string | undefined {
  if (value === "{") return "}";
  if (value === "[") return "]";
  return undefined;
}

function containerStatus(current: string, stack: string[]): ContainerStatus {
  const closing = matchingClose(current);
  if (closing !== undefined) {
    if (stack.length >= MAX_BOUNDARY_CONTAINER_DEPTH) return "invalid";
    stack.push(closing);
    return "inside";
  }
  if (current === "}" || current === "]") {
    if (stack.pop() !== current) return "invalid";
  }
  return stack.length === 0 ? "outside" : "inside";
}

function quotedEndWithin(input: string, start: number, end: number, quote: string): number {
  let cursor = start + 1;
  while (cursor < end) {
    const current = input[cursor] ?? "";
    if (current === "\\") {
      cursor = Math.min(end, cursor + 2);
    } else if (current === quote) {
      if (quote !== "'" || input[cursor + 1] !== "'") return cursor + 1;
      cursor += 2;
    } else {
      cursor += 1;
    }
  }
  return end;
}

function onlyWhitespaceBeforeKey(input: string, start: number, end: number): boolean {
  for (let cursor = start; cursor < end; cursor += 1) {
    if (!isHorizontalWhitespace(input[cursor] ?? "")) return false;
  }
  return true;
}

function governsDirectNextKey<TPolicy>(
  input: string,
  boundary: number,
  separator: number,
  policy: TPolicy,
  isGoverned: GovernedSeparator<TPolicy>,
): boolean {
  const governed = isGoverned(input, separator, policy);
  return governed !== undefined && onlyWhitespaceBeforeKey(input, boundary + 1, governed.anchor);
}

function scalarAssignmentBoundary<TPolicy>(
  input: string,
  start: number,
  end: number,
  policy: TPolicy,
  isGoverned: GovernedSeparator<TPolicy>,
): number | undefined {
  let boundary = -1;
  let cursor = start;
  const containers: string[] = [];
  while (cursor < end) {
    const current = input[cursor] ?? "";
    if (current === "\\") {
      cursor = Math.min(end, cursor + 2);
      continue;
    }
    if (isQuote(current)) {
      cursor = quotedEndWithin(input, cursor, end, current);
      continue;
    }
    const status = containerStatus(current, containers);
    if (status === "invalid") return undefined;
    if (status === "inside") {
      cursor += 1;
      continue;
    }
    if (isAssignmentDelimiter(current)) {
      boundary = cursor;
    } else if (hasBoundarySeparator(boundary, current)) {
      if (governsDirectNextKey(input, boundary, cursor, policy, isGoverned)) {
        return boundary;
      }
      boundary = -1;
    }
    cursor += 1;
  }
  return undefined;
}

function redactedValueEnd(input: string, start: number, boundary: number): number {
  let end = boundary;
  while (end > start && isHorizontalWhitespace(input[end - 1] ?? "")) end -= 1;
  return end;
}

function exactSentinelBefore(input: string, start: number, boundary: number): boolean {
  const end = redactedValueEnd(input, start, boundary);
  return (
    end - start === CREDENTIAL_REDACTED_SENTINEL.length &&
    input.startsWith(CREDENTIAL_REDACTED_SENTINEL, start)
  );
}

function exactQuotedSentinelBefore(input: string, start: number, boundary: number): boolean {
  const quote = input[start] ?? "";
  if (!isQuote(quote)) return false;
  const expected = `${quote}${CREDENTIAL_REDACTED_SENTINEL}${quote}`;
  const end = redactedValueEnd(input, start, boundary);
  return end - start === expected.length && input.startsWith(expected, start);
}

function exactRedactedBefore(input: string, start: number, boundary: number): boolean {
  return (
    exactSentinelBefore(input, start, boundary) || exactQuotedSentinelBefore(input, start, boundary)
  );
}

function canScopeDetection(detection: StructuredCredentialDetection, opening: string): boolean {
  return (
    detection.disposition === "redact" || isQuote(opening) || matchingClose(opening) !== undefined
  );
}

export interface ScalarDetectionScope {
  readonly detection?: StructuredCredentialDetection;
  readonly resumeAt: number;
}

export function scopeScalarDetection<TPolicy>(
  input: string,
  start: number,
  detection: StructuredCredentialDetection,
  policy: TPolicy,
  isGoverned: GovernedSeparator<TPolicy>,
): ScalarDetectionScope {
  const boundary = scalarAssignmentBoundary(input, start, detection.end, policy, isGoverned);
  if (boundary === undefined) return { detection, resumeAt: detection.end };
  if (boundary === start) return { resumeAt: start + 1 };
  if (exactRedactedBefore(input, start, boundary)) return { resumeAt: boundary };
  const opening = input[start] ?? "";
  if (!canScopeDetection(detection, opening) || detection.legacySpan === undefined) {
    return { detection, resumeAt: detection.end };
  }
  const legacySpan = { ...detection.legacySpan, end: boundary };
  return {
    detection: {
      ...detection,
      end: boundary,
      replacement: legacySpan.replacement,
      disposition: "redact",
      unitKind: isQuote(opening) ? "quoted-segment" : "structured-value",
      legacySpan,
    },
    resumeAt: boundary,
  };
}
