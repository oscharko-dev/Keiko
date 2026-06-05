// Internal helpers shared by the memory contract validators (Epic #204, Issue #205).
// NOT part of the public package surface. Other validator modules in this directory
// import from here so primitive guards, bounded-text caps, and the control-character
// safety gate stay defined exactly once.

// Bounded text caps. Chosen to keep audit summaries and rationales safe to ship to a
// browser surface without truncation, and to keep the body cap aligned with a comfortable
// Memory Center card without scrolling.
export const MEMORY_BODY_MAX_CHARS = 4096;
export const MEMORY_RATIONALE_MAX_CHARS = 1024;
export const MEMORY_REASON_MAX_CHARS = 1024;
export const MEMORY_TAG_MAX_CHARS = 64;
export const MEMORY_TAGS_MAX_COUNT = 32;
export const MEMORY_SUMMARY_MAX_CHARS = 512;

// Intentional control-range match — this is the safety gate. `no-control-regex` guards
// against accidental matches, not deliberate ones.
// eslint-disable-next-line no-control-regex
export const FORBIDDEN_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function isSafeText(value: unknown, maxChars: number): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length === 0 || value.length > maxChars) {
    return false;
  }
  return !FORBIDDEN_CONTROL_RE.test(value);
}

export function validateTags(field: string, input: unknown, errors: string[]): void {
  if (!isStringArray(input)) {
    errors.push(`${field} must be a string array`);
    return;
  }
  if (input.length > MEMORY_TAGS_MAX_COUNT) {
    errors.push(`${field} must have at most ${String(MEMORY_TAGS_MAX_COUNT)} entries`);
    return;
  }
  for (const tag of input) {
    if (tag.length === 0 || tag.length > MEMORY_TAG_MAX_CHARS || FORBIDDEN_CONTROL_RE.test(tag)) {
      errors.push(`${field} entry must be a non-empty bounded control-free string`);
      return;
    }
  }
}

export function validateRetentionHint(
  field: string,
  input: unknown,
  errors: string[],
): void {
  if (!isRecord(input)) {
    errors.push(`${field} must be an object when set`);
    return;
  }
  if (!isNonEmptyTrimmedString(input.policyKey)) {
    errors.push(`${field}.policyKey must be a non-empty string`);
  }
  if (input.retainUntil !== undefined && !isFiniteNonNegativeNumber(input.retainUntil)) {
    errors.push(`${field}.retainUntil must be a finite non-negative number when set`);
  }
  if (input.notes !== undefined && !isSafeText(input.notes, MEMORY_REASON_MAX_CHARS)) {
    errors.push(`${field}.notes must be a bounded control-free string when set`);
  }
}

export function validateOptionalReference(field: string, value: unknown, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isNonEmptyTrimmedString(value)) {
    errors.push(`${field} must be a non-empty string when set`);
  }
}

// Shared helpers used by both record-validation and operation-validation modules. Lifted
// here so each callsite imports from one canonical source rather than each validator file
// re-declaring the same prefix-pusher.
export interface NestedValidation {
  readonly ok: boolean;
  readonly errors?: readonly string[];
}

export function pushNestedErrors(prefix: string, result: NestedValidation, errors: string[]): void {
  if (result.ok) {
    return;
  }
  for (const reason of result.errors ?? []) {
    errors.push(`${prefix}.${reason}`);
  }
}

export function validateMemoryIdString(field: string, value: unknown, errors: string[]): void {
  if (!isNonEmptyTrimmedString(value)) {
    errors.push(`${field} must be a non-empty string`);
  }
}

export function validateSchemaVersionLiteral(
  input: Record<string, unknown>,
  errors: string[],
): void {
  if (input.schemaVersion !== "1") {
    errors.push('schemaVersion must be the literal "1"');
  }
}
