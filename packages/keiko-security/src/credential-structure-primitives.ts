export const CREDENTIAL_REDACTED_SENTINEL = "[REDACTED]";
export const MAX_VALUE_WHITESPACE = 4_096;

export interface StructuredCredentialSpan {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export type StructuredCredentialDisposition = "redact" | "quarantine";
export type StructuredCredentialUnitKind = "quoted-segment" | "structured-value" | "line-remainder";

export interface StructuredCredentialDetection extends StructuredCredentialSpan {
  readonly disposition: StructuredCredentialDisposition;
  readonly unitKind: StructuredCredentialUnitKind;
  readonly legacySpan?: StructuredCredentialSpan | undefined;
}

export type CredentialKeyPredicate = (value: string) => boolean;

export function isHorizontalWhitespace(value: string): boolean {
  return value === " " || value === "\t";
}

export function isValueWhitespace(value: string): boolean {
  return isHorizontalWhitespace(value) || value === "\r" || value === "\n";
}

function lineEnd(input: string, from: number): number {
  const newline = input.indexOf("\n", from);
  return newline < 0 ? input.length : newline;
}

export function lineValueEnd(input: string, from: number): number {
  const end = lineEnd(input, from);
  return end > from && input[end - 1] === "\r" ? end - 1 : end;
}

export function quotedEnd(input: string, start: number, quote: string): number | undefined {
  let cursor = start + 1;
  while (cursor < input.length) {
    if (input[cursor] === "\\") {
      cursor = Math.min(input.length, cursor + 2);
      continue;
    }
    if (input[cursor] === quote) {
      if (quote === "'" && input[cursor + 1] === "'") {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return undefined;
}
